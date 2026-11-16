// openclaw-aab through a real Gateway: a linked claw whose key files are gone stays
// off for remote access with keys_missing and creates no key, while the Gateway
// itself starts and serves local clients. The endpoint key case runs the real tunnel
// child and needs the iroh binding.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveStateDir } from "../config/state-dir.js";
import { writeStoredClaw } from "./openclaw-id/claw-store.js";
import { linkedClaw, memoryStore } from "./openclaw-id/openclaw-id.test-support.js";
import { loadIrohBinding } from "./openclaw-id/tunnel-child/addon.js";
import { TEST_OPERATOR_CLIENT, openWs } from "./server.auth.test-helpers.js";
import { connectOk, installGatewayTestHooks, rpcReq, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let hasBinding = true;
try {
  loadIrohBinding();
} catch {
  hasBinding = false;
}

// Stores a linked claw in this Gateway's state; `withGatewayKey` restores its K_gw file.
async function storeLinkedClaw(withGatewayKey: boolean) {
  const store = memoryStore();
  const claw = await linkedClaw(store);
  await writeStoredClaw((await store.read())!);
  const keyDir = path.join(resolveStateDir(), "openclaw-id");
  fs.rmSync(keyDir, { recursive: true, force: true });
  if (withGatewayKey) {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(
      path.join(claw.stateDir, "openclaw-id", "gateway.key"),
      path.join(keyDir, "gateway.key"),
    );
  }
  return keyDir;
}

async function withOpenClawIdGateway(run: (status: () => Promise<unknown>) => Promise<void>) {
  const { writeConfigFile } = await import("../config/config.js");
  // Nothing listens on port 9: a Gateway that tried to publish would only log failures.
  await writeConfigFile({
    gateway: {
      openclawId: {
        enabled: true,
        relayUrl: "http://127.0.0.1:9/",
        discoveryUrl: "http://127.0.0.1:9",
      },
    },
  });
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port);
    try {
      await connectOk(ws, { client: TEST_OPERATOR_CLIENT });
      await run(async () => (await rpcReq(ws, "openclawId.status", {})).payload);
      // The Gateway keeps serving local clients.
      expect((await rpcReq(ws, "health", {})).ok).toBe(true);
    } finally {
      ws.close();
    }
  });
}

describe("OpenClaw ID with lost key files", () => {
  test("id-e2e: a linked Gateway whose Gateway key is gone stays off with keys_missing and creates no key", async () => {
    const keyDir = await storeLinkedClaw(false);
    await withOpenClawIdGateway(async (status) => {
      expect(await status()).toMatchObject({
        status: { state: "keys_refused", key: "gateway", reason: "keys_missing" },
        link: { linked: true },
      });
      expect(fs.existsSync(path.join(keyDir, "gateway.key"))).toBe(false);
      expect(fs.existsSync(path.join(keyDir, "endpoint.key"))).toBe(false);
    });
  });

  test.skipIf(!hasBinding)(
    "id-e2e: a linked Gateway whose endpoint key is gone stays off with keys_missing and creates no key",
    async () => {
      const keyDir = await storeLinkedClaw(true);
      await withOpenClawIdGateway(async (status) => {
        await expect.poll(status, { timeout: 20_000 }).toMatchObject({
          status: { state: "keys_refused", key: "endpoint", reason: "keys_missing" },
        });
        expect(fs.existsSync(path.join(keyDir, "endpoint.key"))).toBe(false);
      });
    },
    40_000,
  );
});
