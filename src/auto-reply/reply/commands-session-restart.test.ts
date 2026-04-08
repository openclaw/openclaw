import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { HandleCommandsParams } from "./commands-types.js";

const writeRestartSentinelMock = vi.hoisted(() => vi.fn().mockResolvedValue("/tmp/restart.json"));
const scheduleGatewaySigusr1RestartMock = vi.hoisted(() => vi.fn());
const triggerOpenClawRestartMock = vi.hoisted(() =>
  vi.fn<() => { ok: boolean; method: string; detail?: string }>(() => ({
    ok: true,
    method: "launchctl",
  })),
);

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: () => true,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfo: vi.fn(() => ({
    baseSessionKey: "agent:main:telegram:group:123",
    threadId: "456",
  })),
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart-sentinel.js")>();
  return {
    ...actual,
    writeRestartSentinel: writeRestartSentinelMock,
    formatDoctorNonInteractiveHint: vi.fn(() => "Run: openclaw doctor --non-interactive"),
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
  triggerOpenClawRestart: triggerOpenClawRestartMock,
}));

vi.mock("../../infra/session-cost-usage.js", () => ({
  loadCostUsageSummary: vi.fn(),
  loadSessionCostSummary: vi.fn(),
}));

const { handleRestartCommand } = await import("./commands-session.js");

function buildParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { restart: true },
    } as OpenClawConfig,
    ctx: {},
    command: {
      commandBodyNormalized: "/restart",
      rawBodyNormalized: "/restart",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "8167215807",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      ownerList: ["8167215807"],
      from: "telegram:user",
      to: "telegram:bot",
    },
    sessionKey: "agent:main:telegram:group:123:topic:456",
    sessionEntry: {
      deliveryContext: {
        channel: "telegram",
        to: "123",
        accountId: "default",
      },
      updatedAt: Date.now(),
    },
  } as unknown as HandleCommandsParams;
}

function mockSigusr1ListenerCount(count: number) {
  const actual = process.listenerCount.bind(process);
  vi.spyOn(process, "listenerCount").mockImplementation((event: string | symbol) =>
    event === "SIGUSR1" ? count : actual(event),
  );
}

describe("handleRestartCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    triggerOpenClawRestartMock.mockReturnValue({ ok: true, method: "launchctl" });
    writeRestartSentinelMock.mockResolvedValue("/tmp/restart.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a restart sentinel for in-process restarts", async () => {
    mockSigusr1ListenerCount(1);

    const result = await handleRestartCommand(buildParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toMatch(/SIGUSR1/);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restart",
        status: "ok",
        sessionKey: "agent:main:telegram:group:123:topic:456",
        deliveryContext: {
          channel: "telegram",
          to: "123",
          accountId: "default",
        },
        threadId: "456",
        doctorHint: "Run: openclaw doctor --non-interactive",
        stats: { mode: "slash-command" },
      }),
    );
  });

  it("writes a restart sentinel after an accepted external restart", async () => {
    mockSigusr1ListenerCount(0);

    const result = await handleRestartCommand(buildParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toMatch(/Restarting OpenClaw via launchctl/);
    expect(triggerOpenClawRestartMock).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
  });

  it("does not write a restart sentinel when the external restart fails", async () => {
    mockSigusr1ListenerCount(0);
    triggerOpenClawRestartMock.mockReturnValue({ ok: false, method: "launchctl", detail: "nope" });

    const result = await handleRestartCommand(buildParams(), true);

    expect(result?.reply?.text).toContain("Restart failed");
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  });

  it("continues restarting when sentinel write fails", async () => {
    mockSigusr1ListenerCount(1);
    writeRestartSentinelMock.mockRejectedValueOnce(new Error("disk full"));

    const result = await handleRestartCommand(buildParams(), true);

    expect(result?.reply?.text).toMatch(/SIGUSR1/);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
  });

  it("skips sentinel writes for unauthorized /restart", async () => {
    mockSigusr1ListenerCount(1);
    const params = buildParams();
    params.command.isAuthorizedSender = false;

    const result = await handleRestartCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });
});
