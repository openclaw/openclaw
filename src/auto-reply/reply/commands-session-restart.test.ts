import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const writeRestartSentinelMock = vi.fn().mockResolvedValue("/tmp/sentinel.json");

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig };
});

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: () => true,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
  triggerOpenClawRestart: vi.fn(() => ({ ok: true, method: "launchctl" })),
}));

vi.mock("../../infra/session-cost-usage.js", () => ({
  loadCostUsageSummary: vi.fn(),
  loadSessionCostSummary: vi.fn(),
}));

vi.mock("../../plugins/runtime/index.js", () => ({
  createPluginRuntime: () => ({ channel: {} }),
}));

const { handleRestartCommand } = await import("./commands-session.js");

function makeParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized: "/restart",
      isAuthorizedSender: true,
      senderId: "user1",
      surface: "telegram",
      channel: "telegram",
      from: "telegram:user1",
      to: "telegram:bot1",
      resetHookTriggered: false,
    },
    cfg: {} as HandleCommandsParams["cfg"],
    ctx: {} as HandleCommandsParams["ctx"],
    sessionKey: "telegram:bot1:123:topic:456",
    sessionEntry: {
      deliveryContext: { channel: "telegram", to: "telegram:123", accountId: "bot1" },
    },
    previousSessionEntry: undefined,
    workspaceDir: "/tmp/ws",
    ...overrides,
  } as HandleCommandsParams;
}

describe("handleRestartCommand sentinel", () => {
  beforeEach(() => {
    writeRestartSentinelMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes restart sentinel with delivery context before restarting", async () => {
    const result = await handleRestartCommand(makeParams(), true);

    expect(result).not.toBeNull();
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toMatch(/Restarting/);

    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);

    const payload = writeRestartSentinelMock.mock.calls[0][0];
    expect(payload.kind).toBe("restart");
    expect(payload.status).toBe("ok");
    expect(payload.sessionKey).toBe("telegram:bot1:123:topic:456");
    expect(payload.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:123",
      accountId: "bot1",
    });
    expect(payload.threadId).toBe("456");
    expect(payload.stats?.mode).toBe("slash-command");
    expect(payload.doctorHint).toBeDefined();
  });

  it("still restarts even if sentinel write fails", async () => {
    writeRestartSentinelMock.mockRejectedValueOnce(new Error("disk full"));

    const result = await handleRestartCommand(makeParams(), true);

    expect(result).not.toBeNull();
    expect(result?.reply?.text).toMatch(/Restarting/);
  });

  it("skips sentinel when command is not /restart", async () => {
    const params = makeParams();
    params.command.commandBodyNormalized = "/help";

    const result = await handleRestartCommand(params, true);

    expect(result).toBeNull();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  });

  it("skips sentinel for unauthorized sender", async () => {
    const params = makeParams();
    params.command.isAuthorizedSender = false;

    const result = await handleRestartCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  });
});
