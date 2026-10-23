import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSubagentListReadContext } from "../../../agents/subagents/registry/subagent-list.js";
import { buildSubagentRunReadIndexFromRuns } from "../../../agents/subagents/registry/subagent-registry-queries.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const MAIN_SESSION_KEY = "agent:main:main";

const { listBySessionMock, getChannelPluginMock, normalizeChannelIdMock } = vi.hoisted(() => ({
  listBySessionMock: vi.fn(),
  getChannelPluginMock: vi.fn((channel: string) =>
    channel === "thread-chat" || channel === "room-chat"
      ? {
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        }
      : null,
  ),
  normalizeChannelIdMock: vi.fn((channel: string) => channel),
}));

vi.mock("../../../infra/outbound/session-binding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/outbound/session-binding-service.js")>()),
  listSessionBindingsBySessionsAsync: async (keys: string[]) =>
    new Map([...new Set(keys)].map((key) => [key, listBySessionMock(key)])),
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  normalizeChannelId: normalizeChannelIdMock,
}));

let handleSubagentsAgentsAction: typeof import("./action-agents.js").handleSubagentsAgentsAction;

function bindSession(targetSessionKey: string, channel: string, conversationId: string) {
  const binding = {
    bindingId: `binding-${conversationId}`,
    targetSessionKey,
    targetKind: "subagent",
    conversation: {
      channel,
      accountId: "default",
      conversationId,
    },
    status: "active",
    boundAt: Date.now() - 20_000,
  };
  listBySessionMock.mockImplementation((sessionKey: string) =>
    sessionKey === targetSessionKey ? [binding] : [],
  );
}

function subagentRun(
  task: string,
  params: { childSessionKey?: string; endedAgoMs?: number; startedAgoMs?: number } = {},
) {
  const startedAgoMs = params.startedAgoMs ?? 20_000;
  return {
    runId: task,
    childSessionKey: params.childSessionKey ?? `agent:main:subagent:${task.replaceAll(" ", "-")}`,
    requesterSessionKey: MAIN_SESSION_KEY,
    requesterDisplayKey: "main",
    task,
    cleanup: "keep" as const,
    createdAt: Date.now() - startedAgoMs,
    execution:
      params.endedAgoMs === undefined
        ? { status: "running" as const, startedAt: Date.now() - startedAgoMs }
        : {
            status: "terminal" as const,
            startedAt: Date.now() - startedAgoMs,
            endedAt: Date.now() - params.endedAgoMs,
            outcome: { status: "ok" as const },
          },
  };
}

function agentsActionInput(channel: string, runs: ReturnType<typeof subagentRun>[]) {
  const snapshot = new Map(runs.map((run) => [run.runId, run]));
  return {
    params: {
      ctx: {
        Provider: channel,
        Surface: channel,
      },
      command: {
        channel,
      },
    },
    requesterKey: MAIN_SESSION_KEY,
    readContext: {
      list: captureSubagentListReadContext(
        runs,
        buildSubagentRunReadIndexFromRuns({ runs: snapshot }),
        snapshot,
        30,
      ),
    },
    restTokens: [],
  } as never;
}

describe("handleSubagentsAgentsAction", () => {
  beforeAll(async () => {
    ({ handleSubagentsAgentsAction } = await import("./action-agents.js"));
  });

  beforeEach(() => {
    listBySessionMock.mockReset();
    getChannelPluginMock.mockClear();
    normalizeChannelIdMock.mockClear();
  });

  it("dedupes stale bound rows for the same child session", async () => {
    const childSessionKey = "agent:main:subagent:worker";
    bindSession(childSessionKey, THREAD_CHANNEL, "thread-1");

    const result = await handleSubagentsAgentsAction(
      agentsActionInput(THREAD_CHANNEL, [
        subagentRun("current worker label", { childSessionKey, startedAgoMs: 10_000 }),
        subagentRun("stale worker label", { childSessionKey, endedAgoMs: 15_000 }),
      ]),
    );

    expect(result.reply?.text).toContain("current worker label");
    expect(result.reply?.text).not.toContain("stale worker label");
  });

  it("keeps /agents numbering aligned with target resolution when hidden recent rows exist", async () => {
    const visibleSessionKey = "agent:main:subagent:visible-bound";
    bindSession(visibleSessionKey, THREAD_CHANNEL, "thread-visible");

    const result = await handleSubagentsAgentsAction(
      agentsActionInput(THREAD_CHANNEL, [
        subagentRun("stale unended worker", { startedAgoMs: 3 * 60 * 60_000 }),
        subagentRun("hidden recent worker", {
          startedAgoMs: 10_000,
          endedAgoMs: 5_000,
        }),
        subagentRun("visible bound worker", {
          childSessionKey: visibleSessionKey,
          endedAgoMs: 15_000,
        }),
      ]),
    );

    expect(result.reply?.text).toContain("2. visible bound worker");
    expect(result.reply?.text).not.toContain("1. visible bound worker");
    expect(result.reply?.text).not.toContain("hidden recent worker");
    expect(result.reply?.text).not.toContain("stale unended worker");
  });

  it("shows room-channel runs as unbound when the plugin supports conversation bindings", async () => {
    listBySessionMock.mockReturnValue([]);

    const result = await handleSubagentsAgentsAction(
      agentsActionInput(ROOM_CHANNEL, [subagentRun("room worker")]),
    );

    expect(result.reply?.text).toContain("room worker (unbound)");
    expect(result.reply?.text).not.toContain("bindings unavailable");
  });

  it("formats bindings generically", async () => {
    const childSessionKey = "agent:main:subagent:room-bound";
    bindSession(childSessionKey, ROOM_CHANNEL, "room-thread-1");

    const result = await handleSubagentsAgentsAction(
      agentsActionInput(ROOM_CHANNEL, [subagentRun("room bound worker", { childSessionKey })]),
    );

    expect(result.reply?.text).toContain("room bound worker (binding:room-thread-1)");
  });

  it("shows bindings unavailable for channels without conversation binding support", async () => {
    getChannelPluginMock.mockReturnValueOnce(null);
    listBySessionMock.mockReturnValue([]);

    const result = await handleSubagentsAgentsAction(
      agentsActionInput("irc", [subagentRun("irc worker")]),
    );

    expect(result.reply?.text).toContain("irc worker (bindings unavailable)");
  });
});
