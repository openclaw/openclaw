// Covers the cross-channel killswitch fast-path: phrase matching, owner/DM/channel
// gating, and that it bypasses the LLM entirely (no agent/reply resolver involved).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getKillswitchStatusSync } from "../../infra/killswitch.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { buildTestCtx } from "./test-ctx.js";

const commandAuthMocks = vi.hoisted(() => ({
  resolveCommandAuthorization: vi.fn(),
}));

vi.mock("../command-auth.js", () => ({
  resolveCommandAuthorization: commandAuthMocks.resolveCommandAuthorization,
}));

const embeddedRunMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(() => true),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  abortEmbeddedAgentRun: embeddedRunMocks.abortEmbeddedAgentRun,
}));

const replyRunRegistryMocks = vi.hoisted(() => ({
  listActiveReplyRunSessionIds: vi.fn<() => string[]>(() => []),
}));

vi.mock("./reply-run-registry.js", () => ({
  listActiveReplyRunSessionIds: replyRunRegistryMocks.listActiveReplyRunSessionIds,
}));

const tempDirs: string[] = [];

function ownerAuth(overrides: Partial<{ senderIsOwner: boolean; providerId: string }> = {}) {
  return {
    providerId: "signal",
    ownerList: ["+1000"],
    senderId: "+1000",
    senderIsOwner: true,
    isAuthorizedSender: true,
    from: "+1000",
    to: "+2000",
    ...overrides,
  };
}

describe("killswitch fast-path", () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-killswitch-cmd-"));
    tempDirs.push(dir);
    process.env.OPENCLAW_STATE_DIR = dir;
    commandAuthMocks.resolveCommandAuthorization.mockReset().mockReturnValue(ownerAuth());
    embeddedRunMocks.abortEmbeddedAgentRun.mockReset().mockReturnValue(true);
    replyRunRegistryMocks.listActiveReplyRunSessionIds.mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    delete process.env.OPENCLAW_STATE_DIR;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  async function run(body: string, ctxOverrides: Record<string, unknown> = {}) {
    const { tryFastKillswitchFromMessage } = await import("./killswitch-command.js");
    return tryFastKillswitchFromMessage({
      ctx: buildTestCtx({ CommandBody: body, ChatType: "direct", ...ctxOverrides }),
      cfg: {} as OpenClawConfig,
    });
  }

  it("ignores ordinary messages", async () => {
    const result = await run("hey what's up");
    expect(result.handled).toBe(false);
  });

  it("ignores near-miss phrases (not exact)", async () => {
    const result = await run("please KILLSWITCH-ENGAGE now");
    expect(result.handled).toBe(false);
  });

  it("engages, aborts active runs, and confirms without touching the agent/LLM", async () => {
    replyRunRegistryMocks.listActiveReplyRunSessionIds.mockReturnValue(["session-a", "session-b"]);
    const result = await run("KILLSWITCH-ENGAGE");
    expect(result.handled).toBe(true);
    expect(result.replyText).toContain("engaged");
    expect(embeddedRunMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-a");
    expect(embeddedRunMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-b");
    expect(getKillswitchStatusSync().engaged).toBe(true);
  });

  it("revives after being engaged", async () => {
    await run("KILLSWITCH-ENGAGE");
    expect(getKillswitchStatusSync().engaged).toBe(true);
    const result = await run("KILLSWITCH-REVIVE");
    expect(result.handled).toBe(true);
    expect(result.replyText).toContain("released");
    expect(getKillswitchStatusSync().engaged).toBe(false);
  });

  it("rejects a non-owner sender even with the exact phrase", async () => {
    commandAuthMocks.resolveCommandAuthorization.mockReturnValue(
      ownerAuth({ senderIsOwner: false }),
    );
    const result = await run("KILLSWITCH-ENGAGE");
    expect(result.handled).toBe(false);
    expect(getKillswitchStatusSync().engaged).toBe(false);
  });

  it("rejects a group message even from the owner", async () => {
    const result = await run("KILLSWITCH-ENGAGE", { ChatType: "group" });
    expect(result.handled).toBe(false);
    expect(getKillswitchStatusSync().engaged).toBe(false);
  });

  it("rejects a non-Signal channel", async () => {
    commandAuthMocks.resolveCommandAuthorization.mockReturnValue(
      ownerAuth({ providerId: "whatsapp" }),
    );
    const result = await run("KILLSWITCH-ENGAGE");
    expect(result.handled).toBe(false);
    expect(getKillswitchStatusSync().engaged).toBe(false);
  });
});
