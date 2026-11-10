import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatIrohEndpointKey,
  randomBytes,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

// openclaw-aab: a linked claw's binding names K_gw. Without that key the Gateway keeps
// running for local use, but remote access stays off and no key is created or used.
const config = {
  enabled: true,
  relayUrl: "https://relay.example.test/",
  discoveryUrl: "https://discovery.example.test",
};

const gatewayKeyPath = (stateDir: string) => path.join(stateDir, "openclaw-id", "gateway.key");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

async function startWithoutBoundKey(prepare?: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-keys-"));
  cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  prepare?.(stateDir);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  const claw = await linkedClaw();
  // Registered at Discovery, so a working claw would publish at start.
  await claw.authority.recordDiscovery({ owner_account_id: "acct-owner" });
  const { service } = serviceFor(claw.authority, config, stateDir);
  cleanups.push(() => service.stop());
  await service.reconcileRuntimePolicy();
  return { claw, service, stateDir, fetch };
}

describe("OpenClaw ID with the bound Gateway key unavailable", () => {
  it("stays off with keys_missing, creates no key and contacts nothing", async () => {
    const { claw, service, stateDir, fetch } = await startWithoutBoundKey();
    expect(service.status()).toEqual({
      state: "keys_refused",
      key: "gateway",
      reason: "keys_missing",
    });
    expect(await service.publish()).toMatchObject({ state: "failed", code: "keys_missing" });
    expect(fs.existsSync(gatewayKeyPath(stateDir))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    // Local use goes on: the owner still manages People on this machine.
    const member = formatIrohEndpointKey(randomBytes(32));
    const added = await service.submitStatement(
      "local_operator",
      await claw.sign({
        op: "add",
        account_id: "m",
        role: "viewer",
        peer_keys: [member],
        invite_id: null,
      }),
    );
    expect(added).toMatchObject({ ok: true });
    // The change waits for publication under the claw's own keys (after a re-bind).
    await vi.waitFor(() => expect(claw.authority.current()?.discovery.publish_pending).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays off with key_mismatch and keeps the other key file untouched", async () => {
    const other = randomBytes(32);
    const { service, stateDir, fetch } = await startWithoutBoundKey((dir) => {
      fs.mkdirSync(path.dirname(gatewayKeyPath(dir)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(gatewayKeyPath(dir), other, { mode: 0o600 });
    });
    expect(service.status()).toEqual({
      state: "keys_refused",
      key: "gateway",
      reason: "key_mismatch",
    });
    expect(new Uint8Array(fs.readFileSync(gatewayKeyPath(stateDir)))).toEqual(other);
    expect(fetch).not.toHaveBeenCalled();
  });
});
