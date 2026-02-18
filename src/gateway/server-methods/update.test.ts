import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";

// Capture the sentinel payload written during update.run
let capturedPayload: RestartSentinelPayload | undefined;

const runGatewayUpdateMock = vi.fn<() => Promise<UpdateRunResult>>();

const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ update: {} }),
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: (sessionKey: string | undefined) => {
    if (!sessionKey) {
      return { deliveryContext: undefined, threadId: undefined };
    }
    // Simulate a threaded Slack session
    if (sessionKey.includes(":thread:")) {
      return {
        deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
        threadId: "1234567890.123456",
      };
    }
    return {
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    };
  },
}));

vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => "/tmp/openclaw",
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    writeRestartSentinel: async (payload: RestartSentinelPayload) => {
      capturedPayload = payload;
      return "/tmp/sentinel.json";
    },
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: () => undefined,
}));

vi.mock("../../infra/update-runner.js", () => ({
  runGatewayUpdate: runGatewayUpdateMock,
}));

vi.mock("../protocol/index.js", () => ({
  validateUpdateRunParams: () => true,
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: (params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    note: params.note,
    restartDelayMs: undefined,
  }),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  capturedPayload = undefined;
  runGatewayUpdateMock.mockReset();
  runGatewayUpdateMock.mockResolvedValue({
    status: "ok",
    mode: "npm",
    steps: [],
    durationMs: 100,
  });
  scheduleGatewaySigusr1RestartMock.mockReset();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
});

describe("update.run sentinel deliveryContext", () => {
  it("includes deliveryContext in sentinel payload when sessionKey is provided", async () => {
    capturedPayload = undefined;
    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.run"];

    let responded = false;
    await handler({
      params: { sessionKey: "agent:main:webchat:dm:user-123" },
      respond: () => {
        responded = true;
      },
    } as never);

    expect(responded).toBe(true);
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toEqual({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });
  });

  it("omits deliveryContext when no sessionKey is provided", async () => {
    capturedPayload = undefined;
    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.run"];

    await handler({
      params: {},
      respond: () => {},
    } as never);

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toBeUndefined();
    expect(capturedPayload!.threadId).toBeUndefined();
  });

  it("includes threadId in sentinel payload for threaded sessions", async () => {
    capturedPayload = undefined;
    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.run"];

    await handler({
      params: { sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456" },
      respond: () => {},
    } as never);

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toEqual({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });
    expect(capturedPayload!.threadId).toBe("1234567890.123456");
  });
});

describe("update.run restart scheduling", () => {
  it("schedules restart when update succeeds", async () => {
    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.run"];
    let payload: { ok: boolean; restart: unknown } | undefined;

    await handler({
      params: {},
      respond: (_ok: boolean, response: { ok: boolean; restart: unknown }) => {
        payload = response;
      },
    } as never);

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.ok).toBe(true);
    expect(payload?.restart).toEqual({ scheduled: true });
  });

  it("skips restart when update fails", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      reason: "build-failed",
      steps: [],
      durationMs: 100,
    });

    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.run"];
    let payload: { ok: boolean; restart: unknown } | undefined;

    await handler({
      params: {},
      respond: (_ok: boolean, response: { ok: boolean; restart: unknown }) => {
        payload = response;
      },
    } as never);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
  });
});
