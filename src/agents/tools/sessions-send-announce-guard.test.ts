import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushBackgroundTasks(times = 1) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeAll(async () => {
  ({ resolveAnnounceTarget } = await import("./sessions-announce-target.js"));
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
});

beforeEach(() => {
  callGatewayMock.mockReset();
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
});

describe("resolveAnnounceTarget fail-closed classification", () => {
  it("classifies key-shaped channel targets as external targets", async () => {
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });

    expect(target).toEqual({
      kind: "external_target",
      target: { channel: "discord", to: "channel:dev" },
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
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
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
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });
});

describe("sessions_send fail-closed announce flow", () => {
  it("skips channel-bound announce flow by default", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              extraSystemPrompt?: string;
            }
          | undefined;
        const reply = params?.extraSystemPrompt?.includes("Agent-to-agent announce step")
          ? "announce now"
          : "initial";
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        throw new Error("send should not be called when channel-bound announce is skipped");
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      config: testConfig,
    });

    const result = await tool.execute("call-channel-bound", {
      sessionKey: "agent:main:discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      reply: "initial",
      delivery: { status: "skipped", mode: "none" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
  });

  it("runs internal-only announce flow with a single sessions.list lookup", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              extraSystemPrompt?: string;
            }
          | undefined;
        const reply = params?.extraSystemPrompt?.includes("Agent-to-agent announce step")
          ? "announce now"
          : "done";
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return { sessions: [{ key: "main", displayName: "main" }] };
      }
      if (request.method === "send") {
        throw new Error("send should not be called for internal-only announce flow");
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      config: testConfig,
    });

    const result = await tool.execute("call-internal-target", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      reply: "done",
      delivery: { status: "pending", mode: "announce" },
    });

    await flushBackgroundTasks();
    expect(calls.filter((call) => call.method === "sessions.list")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(2);
  });

  it("preserves internal announce flow when target lookup misses and keys are not channel-shaped", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              extraSystemPrompt?: string;
            }
          | undefined;
        const reply = params?.extraSystemPrompt?.includes("Agent-to-agent announce step")
          ? "announce now"
          : "done";
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return { sessions: [] };
      }
      if (request.method === "send") {
        throw new Error("send should not be called for internal announce flow on lookup miss");
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      config: testConfig,
    });

    const result = await tool.execute("call-missed-internal-target", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      reply: "done",
      delivery: { status: "pending", mode: "announce" },
    });

    await flushBackgroundTasks();
    expect(calls.filter((call) => call.method === "sessions.list")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(2);
  });

  it("does not block timeoutSeconds=0 on announce precheck and still runs internal announce later when lookup misses", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const sessionsList = createDeferred<{
      sessions: Array<{ key: string; displayName: string }>;
    }>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              extraSystemPrompt?: string;
            }
          | undefined;
        const reply = params?.extraSystemPrompt?.includes("Agent-to-agent announce step")
          ? "announce now"
          : "initial";
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return sessionsList.promise;
      }
      if (request.method === "send") {
        throw new Error("send should not be called for delayed internal announce flow");
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      config: testConfig,
    });

    let resolved = false;
    let resultValue: Awaited<ReturnType<typeof tool.execute>> | undefined;
    const resultPromise = tool.execute("call-timeout-zero", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    void resultPromise.then((result) => {
      resolved = true;
      resultValue = result;
    });

    await flushBackgroundTasks();

    expect(resolved).toBe(true);
    expect(resultValue?.details).toMatchObject({
      status: "accepted",
      delivery: { status: "pending", mode: "announce" },
    });
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);

    sessionsList.resolve({ sessions: [] });
    await resultPromise;
    await flushBackgroundTasks(2);

    expect(calls.filter((call) => call.method === "sessions.list")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(2);
  });

  it("skips announce flow when target resolution is partial", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              extraSystemPrompt?: string;
            }
          | undefined;
        const reply = params?.extraSystemPrompt?.includes("Agent-to-agent announce step")
          ? "announce now"
          : "done";
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [{ key: "main", displayName: "main", lastChannel: "discord" }],
        };
      }
      if (request.method === "send") {
        throw new Error("send should not be called when announce target resolution is partial");
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      config: testConfig,
    });

    const result = await tool.execute("call-unknown-target", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      reply: "done",
      delivery: { status: "skipped", mode: "none" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.method === "sessions.list")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
  });
});
