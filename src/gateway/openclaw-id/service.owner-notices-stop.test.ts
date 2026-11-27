import { describe, expect, it, vi } from "vitest";
import {
  formatIrohEndpointKey,
  randomBytes,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

// Lets a test hold the notice sender's import, the first step of owner-notice preparation.
const noticeImport = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release, send: vi.fn(async () => {}) };
});
vi.mock("./owner-notices.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./owner-notices.js")>();
  await noticeImport.gate;
  return { ...actual, sendOwnerNotices: noticeImport.send };
});

describe("OpenClaw ID owner notices", () => {
  it("sends nothing when remote access is turned off while the notice is prepared", async () => {
    const claw = await linkedClaw();
    const config: GatewayOpenClawIdConfig = { enabled: true };
    const { service } = serviceFor(claw.authority, config);
    const added = await service.submitStatement(
      "local_operator",
      await claw.sign({
        op: "add",
        account_id: "acct-bob",
        role: "operator",
        peer_keys: [formatIrohEndpointKey(randomBytes(32))],
        invite_id: null,
      }),
    );
    expect(added).toMatchObject({ ok: true });

    // The notice is now waiting on its import; the operator turns remote access off.
    config.enabled = false;
    await service.reconcileRuntimePolicy();
    noticeImport.release();
    await import("./owner-notices.js");
    // Let the resumed notice reach its next step.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(noticeImport.send).not.toHaveBeenCalled();
  });
});
