// "Move to new keys" (OpenClaw ID re-bind) through a real Gateway, its real tunnel child
// and a recording stand-in for Discovery: the lost-key case is recovered with the kit on
// this machine, over loopback only, and a crash after the commit finishes on the next start.
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DISCOVERY_SIGNATURE_HEADER } from "../../packages/openclaw-id-protocol/src/index.js";
import { signRebind, type RebindPreparation } from "../cli/id-cli-rebind.js";
import { resolveStateDir } from "../config/state-dir.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import { linkedClaw, memoryStore } from "./openclaw-id/openclaw-id.test-support.js";
import { loadIrohBinding } from "./openclaw-id/tunnel-child/addon.js";
import { ed25519PublicKeyHex } from "./openclaw-id/tunnel-child/keyfile.js";
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

// Discovery stand-in: accepts every write and records it with the signing key.
type Recorded = {
  method: string;
  url: string;
  keyid: string | undefined;
  body: { payload?: { event?: string } } | undefined;
};
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
        // An empty long poll, answered after a while.
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

const keyDir = () => path.join(resolveStateDir(), "openclaw-id");
const fileKey = (name: string) => fs.readFileSync(path.join(keyDir(), name));

// Stores a linked, registered claw whose key files are gone (the openclaw-aab case).
async function storeClawWithLostKeys() {
  const store = memoryStore();
  const claw = await linkedClaw(store);
  await claw.authority.recordDiscovery({
    owner_account_id: "acct-owner",
    published_binding_seq: 1,
  });
  await writeStoredClaw((await store.read())!);
  fs.rmSync(keyDir(), { recursive: true, force: true });
  return { claw, kit: claw.kit };
}

async function withOpenClawIdGateway(
  run: (call: (method: string, params?: unknown) => Promise<any>) => Promise<void>,
) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    gateway: {
      openclawId: { enabled: true, relayUrl: "http://127.0.0.1:9/", discoveryUrl },
    },
  });
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port);
    try {
      await connectOk(ws, { client: TEST_OPERATOR_CLIENT });
      await run(async (method, params = {}) => {
        const res = await rpcReq(ws, method, params);
        return res.ok ? res.payload : { refused: (res.error?.details as { code?: string })?.code };
      });
    } finally {
      ws.close();
    }
  });
}

describe.skipIf(!hasBinding)("OpenClaw ID re-bind", () => {
  test("id-e2e: re-bind over the tunnel is refused; direct loopback succeeds", async () => {
    const { claw, kit } = await storeClawWithLostKeys();

    // A relayed client never reaches the ceremony.
    let refusal: string | undefined;
    await openclawIdHandlers["openclawId.authority"]!({
      params: { action: "rebind_prepare" },
      client: { internal: { isLocalClient: true, openclawIdPeerKey: claw.w1 } },
      respond: (_ok: boolean, _payload: unknown, error?: { details?: { code?: string } }) => {
        refusal = error?.details?.code;
      },
      context: {
        openclawIdService: { rebind: async () => ({ ok: true }) },
        getRuntimeConfig: () => ({ gateway: { openclawId: { enabled: true } } }),
      },
    } as unknown as GatewayRequestHandlerOptions);
    expect(refusal).toBe("not_local_operator");

    await withOpenClawIdGateway(async (call) => {
      expect((await call("openclawId.status")).status).toMatchObject({ state: "keys_refused" });
      const prep = (await call("openclawId.authority", {
        action: "rebind_prepare",
      })) as RebindPreparation;
      expect(prep).toMatchObject({ binding_seq: 2, current: { binding_seq: 1 } });
      // Preparing again reuses the staged keys.
      expect(await call("openclawId.authority", { action: "rebind_prepare" })).toMatchObject({
        k_srv: prep.k_srv,
        k_gw: prep.k_gw,
      });
      const signed = await signRebind(prep, kit);
      if (!signed.ok) {
        throw new Error("kit refused");
      }
      recorded.length = 0;
      expect(
        await call("openclawId.authority", { action: "rebind_commit", binding: signed.binding }),
      ).toMatchObject({ ok: true, bindingSeq: 2 });

      // Remote access is back on the new keys, both promoted from the staged files.
      await expect
        .poll(async () => (await call("openclawId.status")).status, { timeout: 20_000 })
        .toMatchObject({ state: "on", tunnel: { state: "running", endpointKey: prep.k_srv } });
      expect(`ed25519:${ed25519PublicKeyHex(fileKey("gateway.key"))}`).toBe(prep.k_gw);
      expect(`iroh:${ed25519PublicKeyHex(fileKey("endpoint.key"))}`).toBe(prep.k_srv);
      expect(fs.existsSync(path.join(keyDir(), "gateway.key.next"))).toBe(false);
      expect(fs.existsSync(path.join(keyDir(), "endpoint.key.next"))).toBe(false);

      // Discovery gets the new binding and its snapshot in one write, signed by the new K_gw.
      await expect
        .poll(() => recorded.find((r) => r.method === "PUT" && r.url.endsWith("/descriptor")), {
          timeout: 10_000,
        })
        .toMatchObject({
          keyid: prep.k_gw,
          body: {
            descriptor: {
              binding: { body: { binding_seq: 2, k_srv: prep.k_srv, k_gw: prep.k_gw } },
            },
            snapshot: { signer: prep.k_gw, body: { binding_seq: 2 } },
          },
        });
      // Owners hear about it once Discovery has the new keys.
      await expect
        .poll(() => recorded.find((r) => r.body?.payload?.event === "rebind"), { timeout: 10_000 })
        .toMatchObject({ keyid: prep.k_gw, body: { to: "owners", payload: { ref: "2" } } });

      // Owner devices and members are untouched.
      const stored = await readStoredClaw();
      expect(stored?.authority?.seq).toBe(claw.authority.current()?.authority?.seq);
      expect(stored?.discovery.published_binding_seq).toBe(2);
    });
  }, 60_000);

  test("id-e2e: a crash after the re-bind commit finishes promotion on the next start", async () => {
    const { kit } = await storeClawWithLostKeys();
    let prep!: RebindPreparation;
    await withOpenClawIdGateway(async (call) => {
      prep = await call("openclawId.authority", { action: "rebind_prepare" });
    });
    // The commit is stored, then the Gateway stops before it switched keys.
    const signed = await signRebind(prep, kit);
    if (!signed.ok) {
      throw new Error("kit refused");
    }
    const record = (await readStoredClaw())!;
    await writeStoredClaw({ ...record, binding: signed.binding });
    expect(fs.existsSync(path.join(keyDir(), "gateway.key.next"))).toBe(true);

    await withOpenClawIdGateway(async (call) => {
      await expect
        .poll(async () => (await call("openclawId.status")).status, { timeout: 20_000 })
        .toMatchObject({ state: "on", tunnel: { state: "running", endpointKey: prep.k_srv } });
      expect(`ed25519:${ed25519PublicKeyHex(fileKey("gateway.key"))}`).toBe(prep.k_gw);
    });
  }, 60_000);
});
