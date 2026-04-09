import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const callGatewayMock = vi.fn();
const runSessionsSendA2AFlowMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: (...args: unknown[]) => runSessionsSendA2AFlowMock(...args),
}));

type ToolTestConfig = {
  session: {
    scope: "per-sender";
    mainKey: string;
    agentToAgent: {
      maxPingPongTurns: number;
    };
  };
  tools: {
    agentToAgent: {
      enabled: boolean;
    };
    sessions: {
      visibility: "all";
    };
  };
};

const testConfig: ToolTestConfig = {
  session: {
    scope: "per-sender",
    mainKey: "main",
    agentToAgent: {
      maxPingPongTurns: 2,
    },
  },
  tools: {
    agentToAgent: {
      enabled: true,
    },
    sessions: {
      visibility: "all",
    },
  },
};

let resolveAnnounceTarget: (typeof import("./sessions-announce-target.js"))["resolveAnnounceTarget"];
let createSessionsSendTool: (typeof import("./sessions-send-tool.js"))["createSessionsSendTool"];
let setActivePluginRegistry: (typeof import("../../plugins/runtime.js"))["setActivePluginRegistry"];

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadFreshModules() {
  vi.resetModules();
  vi.doMock("../../gateway/call.js", () => ({
    callGateway: (opts: unknown) => callGatewayMock(opts),
  }));
  vi.doMock("./sessions-send-tool.a2a.js", () => ({
    runSessionsSendA2AFlow: (...args: unknown[]) => runSessionsSendA2AFlowMock(...args),
  }));
  ({ resolveAnnounceTarget } = await import("./sessions-announce-target.js"));
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
}

function installRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
}

function createTool() {
  return createSessionsSendTool({
    agentSessionKey: "main",
    agentChannel: "discord",
    config: testConfig,
  });
}

beforeEach(async () => {
  callGatewayMock.mockReset();
  runSessionsSendA2AFlowMock.mockReset();
  await loadFreshModules();
  installRegistry();
});

describe("resolveAnnounceTarget fail-closed classification", () => {
  it("classifies key-shaped channel targets as external targets", async () => {
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });

    expect(target).toEqual({
      kind: "external_target",
      target: { channel: "discord", to: "group:dev", threadId: undefined },
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("classifies matched sessions with no outbound delivery context as no_external_target", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [{ key: "main", displayName: "main" }],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "main",
      displayKey: "main",
    });

    expect(target).toEqual({ kind: "no_external_target" });
  });

  it("classifies lookup-preferred channel hits without delivery metadata as unknown", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [{ key: "agent:main:whatsapp:group:123@g.us", displayName: "wa target" }],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });

    expect(target).toEqual({ kind: "unknown", reason: "missing_delivery" });
  });

  it("returns unknown when lookup misses and only the display key looks channel-bound", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "main",
      displayKey: "discord:group:dev",
    });

    expect(target).toEqual({ kind: "unknown", reason: "miss" });
  });

  it("returns unknown:error when sessions.list throws", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("sessions.list exploded"));

    const target = await resolveAnnounceTarget({
      sessionKey: "main",
      displayKey: "main",
    });

    expect(target).toEqual({ kind: "unknown", reason: "error" });
  });
});

describe("sessions_send fail-closed announce flow", () => {
  it("skips channel-bound announce flow by default", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "sessions.list") {
        return {
          sessions: [{ key: "agent:main:discord:group:target", displayName: "target" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-channel-bound", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId ?? "run-channel-bound", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "initial" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const result = await createTool().execute("call-channel-bound", {
      sessionKey: "agent:main:discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });

  it("preserves internal announce flow when target has no outbound route", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "sessions.list") {
        return {
          sessions: [{ key: "main", displayName: "main" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-internal", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId ?? "run-internal", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const result = await createTool().execute("call-internal-target", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      delivery: { status: "pending", mode: "announce" },
    });
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for fire-and-forget sends without immediate target classification", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-fire-and-forget", status: "accepted" };
      }
      return {};
    });

    const resultPromise = createTool().execute("call-fire-and-forget", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    const timeoutSentinel = Symbol("timeout");
    const resultOrTimeout = await Promise.race([
      resultPromise,
      new Promise<typeof timeoutSentinel>((resolve) => {
        setTimeout(() => resolve(timeoutSentinel), 0);
      }),
    ]);

    expect(resultOrTimeout).not.toBe(timeoutSentinel);
    const result = resultOrTimeout as Awaited<ReturnType<ReturnType<typeof createTool>["execute"]>>;

    expect(result.details).toMatchObject({
      runId: "run-fire-and-forget",
      status: "accepted",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
    const methods = callGatewayMock.mock.calls.map(
      ([request]) => (request as { method?: string }).method,
    );
    expect(methods).not.toContain("sessions.list");
    expect(methods).not.toContain("agent.wait");
    expect(methods).not.toContain("chat.history");
  });

  it("fails closed for fire-and-forget sends even when metadata-backed routing would exist", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-fire-metadata-route", status: "accepted" };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: "main",
              displayName: "main",
              deliveryContext: {
                channel: "discord",
                to: "group:dev",
              },
            },
          ],
        };
      }
      return {};
    });

    const result = await createTool().execute("call-fire-and-forget-metadata-route", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      runId: "run-fire-metadata-route",
      status: "accepted",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
    const methods = callGatewayMock.mock.calls.map(
      ([request]) => (request as { method?: string }).method,
    );
    expect(methods).not.toContain("sessions.list");
    expect(methods).not.toContain("agent.wait");
    expect(methods).not.toContain("chat.history");
  });

  it("skips fire-and-forget announce flow for immediate external targets", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-fire-external", status: "accepted" };
      }
      return {};
    });

    const result = await createTool().execute("call-fire-and-forget-external", {
      sessionKey: "agent:main:discord:group:target",
      message: "ping",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      runId: "run-fire-external",
      status: "accepted",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
    const methods = callGatewayMock.mock.calls.map(
      ([request]) => (request as { method?: string }).method,
    );
    expect(methods).not.toContain("sessions.list");
    expect(methods).not.toContain("agent.wait");
    expect(methods).not.toContain("chat.history");
  });

  it("fails closed for fire-and-forget lookup-preferred sessions missing delivery metadata", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-fire-skip", status: "accepted" };
      }
      return {};
    });

    const resultPromise = createTool().execute("call-fire-and-forget-skip", {
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      message: "ping",
      timeoutSeconds: 0,
    });
    const timeoutSentinel = Symbol("timeout");
    const resultOrTimeout = await Promise.race([
      resultPromise,
      new Promise<typeof timeoutSentinel>((resolve) => {
        setTimeout(() => resolve(timeoutSentinel), 0);
      }),
    ]);

    expect(resultOrTimeout).not.toBe(timeoutSentinel);
    const result = resultOrTimeout as Awaited<ReturnType<ReturnType<typeof createTool>["execute"]>>;

    expect(result.details).toMatchObject({
      runId: "run-fire-skip",
      status: "accepted",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
    const methods = callGatewayMock.mock.calls.map(
      ([request]) => (request as { method?: string }).method,
    );
    expect(methods).not.toContain("sessions.list");
    expect(methods).not.toContain("agent.wait");
    expect(methods).not.toContain("chat.history");
  });

  it("fails closed for lookup-preferred sessions missing delivery metadata", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "sessions.list") {
        return {
          sessions: [{ key: "agent:main:whatsapp:group:123@g.us", displayName: "wa target" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-missing-delivery", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId ?? "run-missing-delivery", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const result = await createTool().execute("call-lookup-preferred", {
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });

  it("fails closed when announce target resolution is partial", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "sessions.list") {
        return {
          sessions: [{ key: "main", displayName: "main", lastChannel: "discord" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-partial", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId ?? "run-partial", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const result = await createTool().execute("call-partial-target", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });

  it("does not await lookup-based announce planning after the reply is ready", async () => {
    const sessionsListDeferred = createDeferredPromise<{
      sessions: Array<{ key: string; displayName: string }>;
    }>();
    let historyReads = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "sessions.list") {
        return sessionsListDeferred.promise;
      }
      if (request.method === "agent") {
        return { runId: "run-delayed-announce-lookup", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId ?? "run-delayed-announce-lookup", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyReads += 1;
        if (historyReads === 1) {
          return { messages: [] };
        }
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    try {
      const resultPromise = createTool().execute("call-delayed-announce-lookup", {
        sessionKey: "main",
        message: "ping",
        timeoutSeconds: 1,
      });
      const timeoutSentinel = Symbol("timeout");
      const resultOrTimeout = await Promise.race([
        resultPromise,
        new Promise<typeof timeoutSentinel>((resolve) => {
          setTimeout(() => resolve(timeoutSentinel), 0);
        }),
      ]);

      expect(resultOrTimeout).not.toBe(timeoutSentinel);
      const result = resultOrTimeout as Awaited<
        ReturnType<ReturnType<typeof createTool>["execute"]>
      >;
      expect(result.details).toMatchObject({
        runId: "run-delayed-announce-lookup",
        status: "ok",
        reply: "done",
        delivery: { status: "pending", mode: "announce" },
      });
      expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1);
      expect(
        (
          runSessionsSendA2AFlowMock.mock.calls[0]?.[0] as {
            announcePlan?: Promise<unknown>;
          }
        ).announcePlan,
      ).toBeInstanceOf(Promise);
    } finally {
      sessionsListDeferred.resolve({
        sessions: [{ key: "main", displayName: "main" }],
      });
    }
  });

  it("does not consult sessions.list for fire-and-forget sends that would need metadata to classify", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-fire-metadata-only", status: "accepted" };
      }
      if (request.method === "sessions.list") {
        throw new Error("sessions.list should not be called for timeoutSeconds=0");
      }
      return {};
    });

    const result = await createTool().execute("call-fire-and-forget-metadata-only", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      runId: "run-fire-metadata-only",
      status: "accepted",
      delivery: { status: "skipped", mode: "none" },
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
    const methods = callGatewayMock.mock.calls.map(
      ([request]) => (request as { method?: string }).method,
    );
    expect(methods).toEqual(["agent"]);
  });
});

describe("runSessionsSendA2AFlow last-mile delivery", () => {
  it("swallows announce delivery failures after generating the last-mile reply", async () => {
    const a2aModule = await vi.importActual<typeof import("./sessions-send-tool.a2a.js")>(
      "./sessions-send-tool.a2a.js",
    );
    const agentStepModule =
      await vi.importActual<typeof import("./agent-step.js")>("./agent-step.js");
    const runWaitModule = await vi.importActual<typeof import("../run-wait.js")>("../run-wait.js");
    const a2aGatewayMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "send") {
        throw new Error("announce delivery failed");
      }
      return {};
    });
    const agentStepGatewayMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "announce-step-run" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "  delivered reply  " }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    a2aModule.__testing.setDepsForTest({
      callGateway: a2aGatewayMock as typeof callGatewayMock,
    });
    agentStepModule.__testing.setDepsForTest({
      callGateway: agentStepGatewayMock as typeof callGatewayMock,
    });
    runWaitModule.__testing.setDepsForTest({
      callGateway: agentStepGatewayMock as typeof callGatewayMock,
    });

    try {
      await expect(
        a2aModule.runSessionsSendA2AFlow({
          targetSessionKey: "agent:main:whatsapp:group:123@g.us",
          displayKey: "agent:main:whatsapp:group:123@g.us",
          message: "ping",
          announceTimeoutMs: 1_000,
          maxPingPongTurns: 0,
          announcePlan: {
            shouldRunAnnounceFlow: true,
            delivery: { status: "pending", mode: "announce" },
            announceTarget: {
              channel: "whatsapp",
              to: "123@g.us",
              accountId: "work",
            },
          },
          roundOneReply: "first reply",
        }),
      ).resolves.toBeUndefined();

      expect(agentStepGatewayMock).toHaveBeenCalled();
      expect(a2aGatewayMock).toHaveBeenCalledWith({
        method: "send",
        params: expect.objectContaining({
          channel: "whatsapp",
          to: "123@g.us",
          accountId: "work",
          message: "delivered reply",
        }),
        timeoutMs: 10_000,
      });
    } finally {
      a2aModule.__testing.setDepsForTest();
      agentStepModule.__testing.setDepsForTest();
      runWaitModule.__testing.setDepsForTest();
    }
  });

  it("passes threadId through last-mile delivery for metadata-backed announce targets", async () => {
    const a2aModule = await vi.importActual<typeof import("./sessions-send-tool.a2a.js")>(
      "./sessions-send-tool.a2a.js",
    );
    const agentStepModule =
      await vi.importActual<typeof import("./agent-step.js")>("./agent-step.js");
    const runWaitModule = await vi.importActual<typeof import("../run-wait.js")>("../run-wait.js");
    const a2aGatewayMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "send") {
        return { status: "ok" };
      }
      return {};
    });
    const agentStepGatewayMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "announce-thread-run" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "threaded reply" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    a2aModule.__testing.setDepsForTest({
      callGateway: a2aGatewayMock as typeof callGatewayMock,
    });
    agentStepModule.__testing.setDepsForTest({
      callGateway: agentStepGatewayMock as typeof callGatewayMock,
    });
    runWaitModule.__testing.setDepsForTest({
      callGateway: agentStepGatewayMock as typeof callGatewayMock,
    });

    try {
      await expect(
        a2aModule.runSessionsSendA2AFlow({
          targetSessionKey: "main",
          displayKey: "main",
          message: "ping",
          announceTimeoutMs: 1_000,
          maxPingPongTurns: 0,
          announcePlan: {
            shouldRunAnnounceFlow: true,
            delivery: { status: "pending", mode: "announce" },
            announceTarget: {
              channel: "discord",
              to: "channel:dev",
              accountId: "ops",
              threadId: "1710000000.000100",
            },
          },
          roundOneReply: "first reply",
        }),
      ).resolves.toBeUndefined();

      expect(a2aGatewayMock).toHaveBeenCalledWith({
        method: "send",
        params: expect.objectContaining({
          channel: "discord",
          to: "channel:dev",
          accountId: "ops",
          threadId: "1710000000.000100",
          message: "threaded reply",
        }),
        timeoutMs: 10_000,
      });
    } finally {
      a2aModule.__testing.setDepsForTest();
      agentStepModule.__testing.setDepsForTest();
      runWaitModule.__testing.setDepsForTest();
    }
  });
});
