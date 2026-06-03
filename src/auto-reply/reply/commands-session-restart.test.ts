import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleRestartCommand } from "./commands-session.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
  triggerOpenClawRestart: vi.fn(),
}));
vi.mock("../../infra/restart-sentinel.js", () => ({
  buildRestartSuccessContinuation: vi.fn(() => ({})),
  formatDoctorNonInteractiveHint: vi.fn(() => ""),
  removeRestartSentinelFile: vi.fn(),
  writeRestartSentinel: vi.fn(() => "/tmp/sentinel"),
}));
vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: vi.fn(() => ({ deliveryContext: {}, threadId: undefined })),
}));
vi.mock("../../globals.js", () => ({ logVerbose: vi.fn() }));

import { scheduleGatewaySigusr1Restart, triggerOpenClawRestart } from "../../infra/restart.js";

describe("handleRestartCommand version-mismatch guard", () => {
  let mockParams: HandleCommandsParams;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("process", {
      ...process,
      argv: ["node", "/usr/lib/node_modules/openclaw/openclaw.mjs"],
      listenerCount: vi.fn(() => 1), // SIGUSR1 listener exists by default
    });

    mockParams = {
      sessionKey: "agent:main:webchat:123",
      cfg: { commands: { restart: true } } as any,
      ctx: {} as any,
      command: {
        commandBodyNormalized: "/restart",
        isAuthorizedSender: true,
        senderId: "owner",
        isOwner: true,
      } as any,
      sessionStore: {} as any,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Test 1: When running version matches global npm version, and SIGUSR1
   * listener exists, the handler should use the fast SIGUSR1 path.
   */
  it("uses SIGUSR1 when running version matches global npm version", async () => {
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ version: "2026.5.28" })
    );
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ dependencies: { openclaw: { version: "2026.5.28" } } }),
    });

    const result = await handleRestartCommand(mockParams, true);

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledTimes(1);
    expect(triggerOpenClawRestart).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚙️ Restarting OpenClaw in-process (SIGUSR1); back in a few seconds.",
      },
    });
  });

  /**
   * Test 2: When running version differs from global npm version, the
   * handler must bypass SIGUSR1 and force a full restart even if a SIGUSR1
   * listener is registered.
   */
  it("forces full restart when running version differs from global npm version", async () => {
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ version: "2026.5.7" })
    );
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ dependencies: { openclaw: { version: "2026.5.28" } } }),
    });
    (triggerOpenClawRestart as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      method: "systemd",
    });

    const result = await handleRestartCommand(mockParams, true);

    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
    expect(triggerOpenClawRestart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚙️ Restarting OpenClaw via systemd (npm package 2026.5.7 → 2026.5.28); give me a few seconds to come back online.",
      },
    });
  });

  /**
   * Test 3: When version detection fails (e.g. npm list errors), the
   * handler should fall back to the safe SIGUSR1 path (default behavior).
   */
  it("falls back to SIGUSR1 when version detection fails", async () => {
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ version: "2026.5.7" })
    );
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 1, // npm list failed
      stdout: "",
    });

    const result = await handleRestartCommand(mockParams, true);

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledTimes(1);
    expect(triggerOpenClawRestart).not.toHaveBeenCalled();
  });

  /**
   * Test 4: When no SIGUSR1 listener exists and versions match, the handler
   * should still use the full restart path (existing behavior).
   */
  it("uses full restart when no SIGUSR1 listener exists", async () => {
    vi.stubGlobal("process", {
      ...process,
      argv: ["node", "/usr/lib/node_modules/openclaw/openclaw.mjs"],
      listenerCount: vi.fn(() => 0), // No SIGUSR1 listener
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ version: "2026.5.28" })
    );
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ dependencies: { openclaw: { version: "2026.5.28" } } }),
    });
    (triggerOpenClawRestart as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      method: "systemd",
    });

    const result = await handleRestartCommand(mockParams, true);

    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
    expect(triggerOpenClawRestart).toHaveBeenCalledTimes(1);
  });
});
