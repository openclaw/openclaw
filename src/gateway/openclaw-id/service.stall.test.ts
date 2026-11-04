import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { linkedClaw } from "./openclaw-id.test-support.js";
import { createOpenClawIdService } from "./service.js";

let stateDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("OpenClaw ID lifecycle with a stalled Discovery", () => {
  it("turns off while a publication request never finishes, and cancels it", async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-id-stall-"));
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({
      owner_account_id: "acct-owner",
      published_binding_seq: 1,
    });
    // Discovery accepts the request and never answers until the signal aborts it.
    const cancelled: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            cancelled.push(signal.reason);
            reject(new Error("aborted"));
          });
        }),
    );
    let config: GatewayOpenClawIdConfig = {
      enabled: true,
      relayUrl: "https://relay.example.test",
      discoveryUrl: "https://discovery.example.test",
    };
    const service = createOpenClawIdService({
      getConfig: () => config,
      getStateDir: () => stateDir!,
      log: { info: vi.fn(), warn: vi.fn() },
      createAuthority: async () => claw.authority,
    });
    service.bindEffects(async () => undefined);
    await service.reconcileRuntimePolicy();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    config = { enabled: false };
    await service.reconcileRuntimePolicy();
    expect(service.status()).toEqual({ state: "off" });
    // Stopping aborts the stalled publication and mailbox requests.
    await vi.waitFor(() => expect(cancelled.length).toBeGreaterThan(0));
    // Well inside the 30-second Discovery request deadline: stop did not wait for it.
  }, 10_000);
});
