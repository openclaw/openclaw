// "Reset owner access" (OpenClaw ID owner reset) through a real Gateway and a recording
// stand-in for Discovery, and `openclaw id reset` with the Gateway stopped: over loopback only,
// everyone removed, the machine keys kept, the new root published with K_gw's RootReset.
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  deriveRootSigner,
  DISCOVERY_SIGNATURE_HEADER,
  formatEd25519PublicKey,
  generateKitSecret,
  ROOT_EPOCH,
  signStatement,
  verifyRootReset,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { resolveStateDir } from "../config/state-dir.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import { linkedClaw, memoryStore } from "./openclaw-id/openclaw-id.test-support.js";
import type { ResetPreparation } from "./openclaw-id/reset-operations.js";
import { loadIrohBinding } from "./openclaw-id/tunnel-child/addon.js";
import { openclawIdHandlers } from "./server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { TEST_OPERATOR_CLIENT, openWs } from "./server.auth.test-helpers.js";
import { connectOk, installGatewayTestHooks, rpcReq, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let hasBinding = true;
try {
  loadIrohBinding();
} catch {
  hasBinding = false;
}

type Recorded = { method: string; url: string; keyid: string | undefined; body: any };
const recorded: Recorded[] = [];
let discovery: http.Server;
let discoveryUrl: string;

beforeAll(async () => {
  discovery = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      recorded.push({
        method: req.method ?? "",
        url: req.url ?? "",
        keyid: /keyid=([^,]+)/.exec(
          String(req.headers[DISCOVERY_SIGNATURE_HEADER.toLowerCase()] ?? ""),
        )?.[1],
        body: text ? JSON.parse(text) : undefined,
      });
      if (req.url?.includes("/mailbox") && req.method === "GET") {
        setTimeout(() => res.end(JSON.stringify({ messages: [], cursor: "c0" })), 500);
        return;
      }
      res.statusCode = 204;
      res.end();
    });
  });
  discovery.listen(0, "127.0.0.1");
  await once(discovery, "listening");
  discoveryUrl = `http://127.0.0.1:${(discovery.address() as AddressInfo).port}`;
});

afterAll(() => {
  discovery.close();
});

// Stores a linked, registered claw with its Gateway key in this Gateway's state directory.
async function storeLinkedClaw() {
  const store = memoryStore();
  const claw = await linkedClaw(store);
  await claw.authority.recordDiscovery({
    owner_account_id: "acct-owner",
    published_binding_seq: 1,
    published_snapshot_seq: 1,
  });
  await writeStoredClaw((await store.read())!);
  const keyDir = path.join(resolveStateDir(), "openclaw-id");
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(
    path.join(claw.stateDir, "openclaw-id", "gateway.key"),
    path.join(keyDir, "gateway.key"),
  );
  return { claw, before: (await store.read())! };
}

async function configure() {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    gateway: { openclawId: { enabled: true, relayUrl: "http://127.0.0.1:9/", discoveryUrl } },
  });
}

async function signBinding(prep: ResetPreparation) {
  const root = await deriveRootSigner(generateKitSecret());
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: prep.binding_seq,
      root_epoch: ROOT_EPOCH,
      issued_at: Math.floor(Date.now() / 1000),
    },
    root,
  );
  return { rootPub: formatEd25519PublicKey(root.publicKey), binding };
}

describe("OpenClaw ID owner reset", () => {
  test("a relayed client is refused before the service is asked", async () => {
    const resetOwner = vi.fn();
    for (const action of ["reset_prepare", "reset_commit"]) {
      let refusal: string | undefined;
      await openclawIdHandlers["openclawId.authority"]!({
        params: { action },
        client: { internal: { isLocalClient: true, openclawIdPeerKey: "iroh:" + "a".repeat(64) } },
        respond: (_ok: boolean, _payload: unknown, error?: { details?: { code?: string } }) => {
          refusal = error?.details?.code;
        },
        context: {
          openclawIdService: { resetOwner },
          getRuntimeConfig: () => ({ gateway: { openclawId: { enabled: true } } }),
        },
      } as unknown as GatewayRequestHandlerOptions);
      expect(refusal).toBe("not_local_operator");
    }
    expect(resetOwner).not.toHaveBeenCalled();
  });

  test.skipIf(!hasBinding)(
    "id-e2e: direct loopback resets and publishes the new root with its RootReset",
    async () => {
      const { before } = await storeLinkedClaw();
      await configure();
      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port);
        try {
          await connectOk(ws, { client: TEST_OPERATOR_CLIENT });
          const call = async (params: Record<string, unknown>) => {
            const res = await rpcReq(ws, "openclawId.authority", params);
            return res.ok
              ? res.payload
              : { refused: (res.error?.details as { code?: string })?.code };
          };
          const prep = (await call({ action: "reset_prepare" })) as ResetPreparation;
          expect(prep).toMatchObject({ binding_seq: 2, removes: { ownerDevices: 1 } });
          const signed = await signBinding(prep);
          recorded.length = 0;
          expect(await call({ action: "reset_commit", ...signed })).toMatchObject({
            ok: true,
            reset: true,
            bindingSeq: 2,
            removed: { ownerDevices: 1 },
            publication: { state: "published" },
          });
          // One descriptor write signed by the unchanged K_gw, with the reset evidence and no
          // link code, then the snapshot for the new binding.
          const put = recorded.find((r) => r.method === "PUT" && r.url.endsWith("/descriptor"));
          expect(put).toMatchObject({
            keyid: before.binding!.body.k_gw,
            body: { descriptor: { root_pub: signed.rootPub, binding: signed.binding } },
          });
          expect(put?.body.code).toBeUndefined();
          const { reset } = put!.body.descriptor;
          expect(
            await verifyRootReset(
              { root_pub: before.authority!.anchor.root_pub, binding: before.binding! },
              reset.statement,
              { root_pub: signed.rootPub, binding: signed.binding },
              { now: Math.floor(Date.now() / 1000) },
            ),
          ).toMatchObject({ ok: true });
          expect(recorded.find((r) => r.url.endsWith("/snapshot"))).toMatchObject({
            body: { snapshot: { body: { binding_seq: 2, seq: before.authority!.seq + 1 } } },
          });
        } finally {
          ws.close();
        }
      });
      const stored = await readStoredClaw();
      expect(stored?.authority?.owner_devices).toEqual({});
      expect(stored?.discovery.published_binding_seq).toBe(2);
    },
    60_000,
  );

  test("openclaw id reset with the Gateway stopped edits local state and shows the kit once", async () => {
    const { before } = await storeLinkedClaw();
    await configure();
    const prompt = await import("../cli/prompt.js");
    vi.spyOn(prompt, "promptText").mockResolvedValue("studio");
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const { runReset } = await import("../cli/id-cli-reset.js");
      await runReset();
    } finally {
      write.mockRestore();
      vi.restoreAllMocks();
      for (const [stream, descriptor] of [
        [process.stdin, stdin],
        [process.stdout, stdout],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(stream, "isTTY", descriptor);
        } else {
          delete (stream as { isTTY?: boolean }).isTTY;
        }
      }
    }
    const text = output.join("");
    expect(text).toContain("Owner access reset.");
    expect(text).toContain("The Gateway publishes the new owner key to Discovery when it starts.");
    expect(text.match(/OCK1-[A-Z0-9-]+/g)).toHaveLength(1);
    const stored = (await readStoredClaw())!;
    expect(stored.authority?.anchor.root_pub).not.toBe(before.authority!.anchor.root_pub);
    expect(stored.authority?.owner_devices).toEqual({});
    expect(stored.authority?.seq).toBe(before.authority!.seq + 1);
    expect(stored.binding?.body).toMatchObject({
      binding_seq: 2,
      k_gw: before.binding!.body.k_gw,
      k_srv: before.binding!.body.k_srv,
    });
    expect(stored.reset?.statement.signer).toBe(before.binding!.body.k_gw);
    // Nothing reached Discovery: the Gateway publishes at its next start.
    expect(stored.discovery.published_binding_seq).toBe(1);
  });
});
