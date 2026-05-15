import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionListRow } from "./sessions-helpers.js";
import type { SessionsBroadcastResult } from "./sessions-broadcast-tool.js";

// --- Mock callGateway ---
const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

// --- Mock enqueueSystemEvent ---
const enqueueSystemEventMock = vi.fn<
  (text: string, options: { sessionKey: string; trusted: boolean }) => boolean
>();
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (
    text: string,
    options: unknown,
  ) => enqueueSystemEventMock(text, options as { sessionKey: string; trusted: boolean }),
}));

// --- Mock getRuntimeConfig ---
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => baseConfig,
  loadConfig: () => baseConfig,
}));

const baseConfig: OpenClawConfig = {
  session: { scope: "per-sender", mainKey: "main" },
  tools: {
    agentToAgent: { enabled: true },
    sessions: { visibility: "all" },
  },
} as unknown as OpenClawConfig;

const a2aDisabledConfig: OpenClawConfig = {
  session: { scope: "per-sender", mainKey: "main" },
  tools: {
    agentToAgent: { enabled: false },
    sessions: { visibility: "all" },
  },
} as unknown as OpenClawConfig;

const allowListConfig: OpenClawConfig = {
  session: { scope: "per-sender", mainKey: "main" },
  tools: {
    agentToAgent: { enabled: true, allow: ["zero"] },
    sessions: { visibility: "all" },
  },
} as unknown as OpenClawConfig;

const CALLER_SESSION_KEY = "agent:zero:tui-abc123";

function makeSessions(keys: string[], agentId = "zero"): { sessions: SessionListRow[] } {
  return {
    sessions: keys.map((key) => ({
      key,
      kind: "main" as const,
      channel: "tui",
      agentId,
    })),
  };
}

let createSessionsBroadcastTool: typeof import("./sessions-broadcast-tool.js").createSessionsBroadcastTool;

beforeEach(async () => {
  vi.resetModules();
  callGatewayMock.mockReset();
  enqueueSystemEventMock.mockReset();
  enqueueSystemEventMock.mockReturnValue(true);
  ({ createSessionsBroadcastTool } = await import("./sessions-broadcast-tool.js"));
});

function requireResult(value: unknown): { details?: unknown } {
  if (!value || typeof value !== "object") throw new Error("expected result object");
  return value as { details?: unknown };
}

function requireDetails(result: { details?: unknown }): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") throw new Error("expected details");
  return result.details as Record<string, unknown>;
}

describe("sessions_broadcast — safety gate: no filters", () => {
  it("rejects call with no filter params", async () => {
    const tool = createSessionsBroadcastTool({
      agentSessionKey: CALLER_SESSION_KEY,
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(await tool.execute("_", { message: "hello" }));
    const details = requireDetails(result);
    expect(typeof details.error).toBe("string");
    expect(String(details.error)).toMatch(/at least one filter/i);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

describe("sessions_broadcast — agentToAgent disabled", () => {
  it("rejects when agentToAgent.enabled is false", async () => {
    const tool = createSessionsBroadcastTool({
      agentSessionKey: CALLER_SESSION_KEY,
      config: a2aDisabledConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "hello", agentIds: ["acid"] }),
    );
    const details = requireDetails(result);
    expect(typeof details.error).toBe("string");
    expect(String(details.error)).toMatch(/agentToAgent/i);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

describe("sessions_broadcast — filter resolves no sessions", () => {
  it("returns zero counts when sessions list is empty", async () => {
    callGatewayMock.mockResolvedValue({ sessions: [] });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: CALLER_SESSION_KEY,
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "ping", agentIds: ["acid"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(0);
    expect(details.failed).toBe(0);
    expect(details.skipped).toBe(0);
    expect(details.results).toEqual([]);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});

describe("sessions_broadcast — successful delivery", () => {
  it("delivers to matching sessions and returns structured result", async () => {
    callGatewayMock.mockResolvedValue(
      makeSessions(["agent:zero:tui-s1", "agent:zero:tui-s2", "agent:zero:tui-s3"], "zero"),
    );
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "broadcast message", agentIds: ["zero"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(3);
    expect(details.failed).toBe(0);
    expect(details.skipped).toBe(0);
    expect(details.results).toHaveLength(3);
    expect(details.results.every((r) => r.status === "delivered")).toBe(true);
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(3);
    for (const call of enqueueSystemEventMock.mock.calls) {
      expect(call[0]).toBe("broadcast message");
      expect(call[1]).toHaveProperty("trusted", false);
    }
  });
});

describe("sessions_broadcast — excludeCurrentSession (default true)", () => {
  it("excludes caller session by default", async () => {
    callGatewayMock.mockResolvedValue(
      makeSessions([CALLER_SESSION_KEY, "agent:zero:tui-s2"], "zero"),
    );
    const tool = createSessionsBroadcastTool({
      agentSessionKey: CALLER_SESSION_KEY,
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "hi", agentIds: ["zero"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(1);
    expect(details.skipped).toBe(1);
    const skipped = details.results.find((r) => r.status === "skipped");
    expect(skipped?.sessionKey).toBe(CALLER_SESSION_KEY);
    expect(skipped?.reason).toBe("self");
  });

  it("includes caller session when excludeCurrentSession is false", async () => {
    callGatewayMock.mockResolvedValue(
      makeSessions([CALLER_SESSION_KEY, "agent:zero:tui-s2"], "zero"),
    );
    const tool = createSessionsBroadcastTool({
      agentSessionKey: CALLER_SESSION_KEY,
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", {
        message: "hi",
        agentIds: ["zero"],
        excludeCurrentSession: false,
      }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(2);
    expect(details.skipped).toBe(0);
  });
});

describe("sessions_broadcast — thread-scoped exclusion", () => {
  it("excludes thread-scoped sessions and marks them skipped", async () => {
    callGatewayMock.mockResolvedValue({
      sessions: [
        { key: "agent:zero:tui-main", kind: "main", channel: "tui", agentId: "zero" },
        {
          key: "agent:zero:discord:thread:12345",
          kind: "main",
          channel: "discord",
          agentId: "zero",
        },
      ] as SessionListRow[],
    });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "notify", agentIds: ["zero"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(1);
    expect(details.skipped).toBe(1);
    const skipped = details.results.find((r) => r.status === "skipped");
    expect(skipped?.reason).toBe("thread-scoped");
    expect(skipped?.sessionKey).toContain(":thread:");
  });
});

describe("sessions_broadcast — allow-list enforcement", () => {
  it("skips sessions whose agentId is not in the allow list", async () => {
    callGatewayMock.mockImplementation(
      (opts: { method: string; params: { agentId?: string } }) => {
        if (opts.params?.agentId === "zero") {
          return Promise.resolve(makeSessions(["agent:zero:tui-main"], "zero"));
        }
        if (opts.params?.agentId === "acid") {
          return Promise.resolve(makeSessions(["agent:acid:tui-main"], "acid"));
        }
        return Promise.resolve({ sessions: [] });
      },
    );
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:zero:brain",
      config: allowListConfig,
      callGateway: callGatewayMock,
    });
    // acid is not in allow: ["zero"]
    const result = requireResult(
      await tool.execute("_", { message: "hey", agentIds: ["zero", "acid"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    // acid session: agentId !== caller, not in allow list → skipped
    const acidSkipped = details.results.find(
      (r) => r.agentId === "acid" && r.status === "skipped",
    );
    expect(acidSkipped?.reason).toBe("allow-list");
    expect(details.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("sessions_broadcast — partial failure handling", () => {
  it("marks session as failed when enqueueSystemEvent returns false", async () => {
    callGatewayMock.mockResolvedValue(
      makeSessions(["agent:zero:s1", "agent:zero:s2", "agent:zero:s3"], "zero"),
    );
    // s2 fails (queue rejected)
    enqueueSystemEventMock.mockImplementation((_text, opts) => {
      return opts.sessionKey !== "agent:zero:s2";
    });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "partial", agentIds: ["zero"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(2);
    expect(details.failed).toBe(1);
    const failed = details.results.find((r) => r.status === "failed");
    expect(failed?.sessionKey).toBe("agent:zero:s2");
  });

  it("continues delivery to remaining sessions after a throw", async () => {
    callGatewayMock.mockResolvedValue(
      makeSessions(["agent:zero:s1", "agent:zero:s2", "agent:zero:s3"], "zero"),
    );
    let callCount = 0;
    enqueueSystemEventMock.mockImplementation((_text, opts) => {
      callCount += 1;
      if (opts.sessionKey === "agent:zero:s2") {
        throw new Error("queue unavailable");
      }
      return true;
    });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "test", agentIds: ["zero"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details.delivered).toBe(2);
    expect(details.failed).toBe(1);
    expect(callCount).toBe(3); // all three attempted
  });
});

describe("sessions_broadcast — filter variants pass safety gate", () => {
  it("passes with only label filter", async () => {
    callGatewayMock.mockResolvedValue({ sessions: [] });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "ping", label: "my-session" }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details).not.toHaveProperty("error");
    expect(details.delivered).toBe(0);
  });

  it("passes with only kinds filter", async () => {
    callGatewayMock.mockResolvedValue({ sessions: [] });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "ping", kinds: ["cron"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details).not.toHaveProperty("error");
  });

  it("passes with only activeWithinMinutes filter", async () => {
    callGatewayMock.mockResolvedValue({ sessions: [] });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "ping", activeWithinMinutes: 10 }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details).not.toHaveProperty("error");
  });

  it("passes with only agentIds filter", async () => {
    callGatewayMock.mockResolvedValue({ sessions: [] });
    const tool = createSessionsBroadcastTool({
      agentSessionKey: "agent:brain:main",
      config: baseConfig,
      callGateway: callGatewayMock,
    });
    const result = requireResult(
      await tool.execute("_", { message: "ping", agentIds: ["zero"] }),
    );
    const details = requireDetails(result) as SessionsBroadcastResult;
    expect(details).not.toHaveProperty("error");
  });
});
