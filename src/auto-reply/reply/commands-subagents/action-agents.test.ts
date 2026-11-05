import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSubagentListReadContext } from "../../../agents/subagents/registry/subagent-list.js";
import { buildSubagentRunReadIndexFromRuns } from "../../../agents/subagents/registry/subagent-registry-queries.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const MAIN_SESSION_KEY = "agent:main:main";

const { listBySessionMock } = vi.hoisted(() => ({ listBySessionMock: vi.fn() }));

// mock-isolation: Use synthetic channel descriptors without loading the bundled plugin registry.
vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channel: string) =>
    channel === "thread-chat" || channel === "room-chat"
      ? { conversationBindings: { supportsCurrentConversationBinding: true } }
      : null,
  normalizeChannelId: (channel: string) => channel,
}));

vi.mock("../../../infra/outbound/session-binding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/outbound/session-binding-service.js")>()),
  listSessionBindingsBySessionsAsync: async (keys: string[]) =>
    new Map([...new Set(keys)].map((key) => [key, listBySessionMock(key)])),
}));

let handleSubagentsAgentsAction: typeof import("./action-agents.js").handleSubagentsAgentsAction;

function bindSession(targetSessionKey: string, channel: string, conversationId: string) {
  const binding = {
    bindingId: `binding-${conversationId}`,
    targetSessionKey,
    targetKind: "subagent",
    conversation: { channel, accountId: "default", conversationId },
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
  const startedAt = Date.now() - (params.startedAgoMs ?? 20_000);
  return {
    runId: task,
    childSessionKey: params.childSessionKey ?? `agent:main:subagent:${task.replaceAll(" ", "-")}`,
    requesterSessionKey: MAIN_SESSION_KEY,
    requesterDisplayKey: "main",
    task,
    cleanup: "keep" as const,
    createdAt: startedAt,
    execution:
      params.endedAgoMs === undefined
        ? { status: "running" as const, startedAt }
        : {
            status: "terminal" as const,
            startedAt,
            endedAt: Date.now() - params.endedAgoMs,
            outcome: { status: "ok" as const },
          },
  };
}

async function agentsReply(channel: string, runs: ReturnType<typeof subagentRun>[]) {
  const snapshot = new Map(runs.map((run) => [run.runId, run]));
  const result = await handleSubagentsAgentsAction({
    params: {
      ctx: { Provider: channel, Surface: channel },
      command: { channel },
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
  } as never);
  return result.reply?.text;
}

describe("handleSubagentsAgentsAction", () => {
  beforeAll(async () => {
    ({ handleSubagentsAgentsAction } = await import("./action-agents.js"));
  });

  beforeEach(() => {
    listBySessionMock.mockReset().mockReturnValue([]);
  });

  it("dedupes stale bound rows for the same child session", async () => {
    const childSessionKey = "agent:main:subagent:worker";
    bindSession(childSessionKey, THREAD_CHANNEL, "thread-1");

    const text = await agentsReply(THREAD_CHANNEL, [
      subagentRun("current worker label", { childSessionKey, startedAgoMs: 10_000 }),
      subagentRun("stale worker label", { childSessionKey, endedAgoMs: 15_000 }),
    ]);

    expect(text).toContain("current worker label");
    expect(text).not.toContain("stale worker label");
  });

  it("keeps /agents numbering aligned with target resolution when hidden recent rows exist", async () => {
    const visibleSessionKey = "agent:main:subagent:visible-bound";
    bindSession(visibleSessionKey, THREAD_CHANNEL, "thread-visible");

    const text = await agentsReply(THREAD_CHANNEL, [
      subagentRun("stale unended worker", { startedAgoMs: 3 * 60 * 60_000 }),
      subagentRun("hidden recent worker", { startedAgoMs: 10_000, endedAgoMs: 5_000 }),
      subagentRun("visible bound worker", {
        childSessionKey: visibleSessionKey,
        endedAgoMs: 15_000,
      }),
    ]);

    expect(text).toContain("2. visible bound worker");
    expect(text).not.toContain("1. visible bound worker");
    expect(text).not.toContain("hidden recent worker");
    expect(text).not.toContain("stale unended worker");
  });

  it("shows room-channel runs as unbound when the plugin supports conversation bindings", async () => {
    const text = await agentsReply(ROOM_CHANNEL, [subagentRun("room worker")]);

    expect(text).toContain("room worker (unbound)");
    expect(text).not.toContain("bindings unavailable");
  });

  it("formats bindings generically", async () => {
    const childSessionKey = "agent:main:subagent:room-bound";
    bindSession(childSessionKey, ROOM_CHANNEL, "room-thread-1");

    const text = await agentsReply(ROOM_CHANNEL, [
      subagentRun("room bound worker", { childSessionKey }),
    ]);

    expect(text).toContain("room bound worker (binding:room-thread-1)");
  });

  it("shows bindings unavailable for channels without conversation binding support", async () => {
    const text = await agentsReply("irc", [subagentRun("irc worker")]);

    expect(text).toContain("irc worker (bindings unavailable)");
  });
});
