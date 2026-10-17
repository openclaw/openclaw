import { expect, vi } from "vitest";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export const sessionRow = vi.hoisted(() => ({
  key: "agent:main:main",
  kind: "direct",
  sessionId: "sess-main",
  status: "done",
  updatedAt: 1,
  thinkingLevel: "ultra" as string | undefined,
  thinkingLevels: [{ id: "ultra", label: "ultra" }],
  thinkingOptions: ["ultra"],
  thinkingDefault: "medium",
  agentRuntime: { id: "openclaw", source: "model" },
}));
export const resolveEmbeddedAgentSessionProgressStateMock = vi.hoisted(() => vi.fn());
export const loadGatewaySessionRowMock = vi.hoisted(() => vi.fn());
export const projectChatDisplayMessageMock = vi.hoisted(() => vi.fn((message: unknown) => message));
export const listAccessorSessionEntriesReadOnlyMock = vi.hoisted(() => vi.fn());
export const loadAccessorSessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
export const loadGatewaySessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
export const readSessionMessageCountAsyncMock = vi.hoisted(() => vi.fn());
export const readSessionMessageByIdAsyncMock = vi.hoisted(() => vi.fn());
export const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtimeConfigState.value }));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: listAccessorSessionEntriesReadOnlyMock,
  loadSessionEntryReadOnly: loadAccessorSessionEntryReadOnlyMock,
}));
vi.mock("./chat-display-projection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-display-projection.js")>()),
  projectChatDisplayMessage: projectChatDisplayMessageMock,
}));
vi.mock("./session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-readers.js")>()),
  readSessionMessageCountAsync: readSessionMessageCountAsyncMock,
  readSessionMessageByIdAsync: readSessionMessageByIdAsyncMock,
}));
vi.mock("../agents/embedded-agent-runner/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent-runner/runs.js")>()),
  resolveEmbeddedAgentSessionProgressState: resolveEmbeddedAgentSessionProgressStateMock,
}));

const {
  createLifecycleEventBroadcastHandler: createLifecycleHandler,
  createTranscriptUpdateBroadcastHandler: createTranscriptHandler,
} = await import("./server-session-events.js");
export const { createGatewayBroadcaster } = await import("./server-broadcast.js");
export const { subscribePluginSessionsChanged } =
  await import("../plugins/services.test-support.js");

type RowQuery = { key?: string; agentId?: string; storePath?: string };
function projectedEntry(row: { key: string; entry: unknown }, { agentId, storePath }: RowQuery) {
  return Object.assign({}, row, { agentId, storeTarget: { agentId, storePath } });
}

const projection = {
  get state() {
    return { rowContext: { projectedAgentRuns: buildProjectedAgentRunIndex() } };
  },
  ensureMaterialized: async () => {},
  ancestorRows: () => [],
  prepareMembership: async () => {},
  needsMembershipPreparation: () => false,
  withPreparedExactRows: (async (queries, consume) => {
    queries(runtimeConfigState.value);
    return consume(projection);
  }) satisfies SessionRowProjection["withPreparedExactRows"],
  isCurrent: () => true,
  selectEntries({ key, agentId, storePath }: RowQuery) {
    if (!key) {
      return (listAccessorSessionEntriesReadOnlyMock({ agentId, storePath }) ?? []).map(
        (row: { key: string; entry: unknown }) => projectedEntry(row, { agentId, storePath }),
      );
    }
    const target = storePath
      ? {
          entry: loadAccessorSessionEntryReadOnlyMock({ agentId, sessionKey: key, storePath }),
          storePath,
        }
      : loadGatewaySessionEntryReadOnlyMock(key, { agentId });
    return target?.entry
      ? [projectedEntry({ key, entry: target.entry }, { agentId, storePath: target.storePath })]
      : [];
  },
  capture: (query: { key: string; agentId: string; storePath?: string }) =>
    projection.selectEntries(query)[0],
  findBySessionId(query: { sessionId: string; agentId?: string; storePath?: string }) {
    return projection
      .selectEntries({ agentId: query.agentId, storePath: query.storePath })
      .filter(({ entry }) => entry.sessionId === query.sessionId);
  },
  describe(query: { key: string; agentId: string }) {
    const row = loadGatewaySessionRowMock(query.key, { agentId: query.agentId });
    return row ? { materialized: { row } } : undefined;
  },
  present(record: Parameters<SessionRowProjection["present"]>[0]) {
    return record.materialized.row;
  },
} as unknown as SessionRowProjection;

export const createLifecycleEventBroadcastHandler = (
  params: Parameters<typeof createLifecycleHandler>[0],
) => createLifecycleHandler({ getSessionRowProjection: () => projection, ...params });
export const createTranscriptUpdateBroadcastHandler = (
  params: Parameters<typeof createTranscriptHandler>[0],
) => createTranscriptHandler({ getSessionRowProjection: () => projection, ...params });

export const createActiveRun = (
  projectSessionActive: boolean,
  executionStarted = true,
): ChatAbortControllerEntry => ({
  controller: new AbortController(),
  sessionId: "sess-main",
  sessionKey: "agent:main:main",
  startedAtMs: Date.now(),
  executionStarted,
  expiresAtMs: Date.now() + 60_000,
  projectSessionActive,
});

export const storedMessage = (messageId: string, seq = 1) => ({
  found: true,
  oversized: false,
  seq,
  message: { role: "assistant", content: `Stored ${messageId}` },
});

export const fixedStoreRuntimeConfig = (ownerAgentId: string, configuredAgentIds: string[]) => ({
  session: { store: "/tmp/shared.sqlite" },
  agents: {
    ownership: "explicit",
    defaults: { sessionStore: { agentId: ownerAgentId } },
    entries: Object.fromEntries(configuredAgentIds.map((agentId) => [agentId, {}])),
  },
});

export function createHandler(
  projectSessionActive: boolean,
  executionStarted = true,
  getSessionMessageSubscribers: SessionMessageSubscriberRegistry["get"] = () => new Set<string>(),
) {
  const broadcastToConnIds = vi.fn();
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: getSessionMessageSubscribers },
    chatAbortControllers: new Map([
      ["run-before-finalize", createActiveRun(projectSessionActive, executionStarted)],
    ]),
  });
  return { broadcastToConnIds, handler };
}

export const ownerGoal = {
  schemaVersion: 1 as const,
  id: "goal-ops",
  objective: "Ops only",
  status: "active" as const,
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 3,
  continuationTurns: 0,
};

export function expectPrivateSessionInvalidation(payload: unknown) {
  for (const field of "agentId session message owner goal status hasActiveRun activeRunIds model responseUsage".split(
    " ",
  )) {
    expect(payload, field).not.toHaveProperty(field);
  }
}

export async function emitAssistantTranscriptUpdate(
  projectSessionActive: boolean,
  message: unknown = { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
  executionStarted = true,
) {
  const { broadcastToConnIds, handler } = createHandler(projectSessionActive, executionStarted);
  await handler({
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    message,
    messageId: "message-1",
    messageSeq: 1,
  });
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  return broadcastToConnIds.mock.calls[0]?.[1];
}
