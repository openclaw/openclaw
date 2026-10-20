import { expect, vi } from "vitest";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import { tryClaimSessionControllerTask } from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  getRpcSourceIdentity,
  setRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

const sessionRow = vi.hoisted(() => ({
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
const loadGatewaySessionRowMock = vi.hoisted(() => vi.fn());
const projectChatDisplayMessageMock = vi.hoisted(() => vi.fn((message: unknown) => message));
const listAccessorSessionEntriesReadOnlyMock = vi.hoisted(() => vi.fn());
const loadAccessorSessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
const loadGatewaySessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
const readSessionMessageCountAsyncMock = vi.hoisted(() => vi.fn());
const readSessionMessageByIdAsyncMock = vi.hoisted(() => vi.fn());
const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const sessionEventStorePath = "/tmp/session-events-fixture.sqlite";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtimeConfigState.value }));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    listSessionEntriesReadOnly: listAccessorSessionEntriesReadOnlyMock,
    loadSessionEntryReadOnly: loadAccessorSessionEntryReadOnlyMock,
  };
});
vi.mock("./chat-display-projection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-display-projection.js")>();
  return { ...actual, projectChatDisplayMessage: projectChatDisplayMessageMock };
});
vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessageCountAsync: readSessionMessageCountAsyncMock,
    readSessionMessageByIdAsync: readSessionMessageByIdAsyncMock,
  };
});

const { createLifecycleEventBroadcastHandler: createLifecycleHandler } =
  await import("./server-session-lifecycle-events.js");
const { createTranscriptUpdateBroadcastHandler: createTranscriptHandler } =
  await import("./server-session-events.js");
const { createGatewayBroadcaster } = await import("./server-broadcast.js");
const { subscribePluginSessionsChanged } = await import("../plugins/services.test-support.js");

const projection = {
  get state() {
    return {
      rowContext: { projectedAgentRuns: buildProjectedAgentRunIndex() },
      scope: () => ({ path: sessionEventStorePath }),
    };
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
  selectEntries(query: { key?: string; agentId?: string; storePath?: string }) {
    if (!query.key) {
      return (
        listAccessorSessionEntriesReadOnlyMock({
          agentId: query.agentId,
          storePath: query.storePath,
        }) ?? []
      ).map((row: { key: string; entry: unknown }) =>
        Object.assign({}, row, {
          agentId: query.agentId,
          storeTarget: { agentId: query.agentId, storePath: query.storePath },
        }),
      );
    }
    const target = query.storePath
      ? {
          entry: loadAccessorSessionEntryReadOnlyMock({
            agentId: query.agentId,
            sessionKey: query.key,
            storePath: query.storePath,
          }),
          storePath: query.storePath,
        }
      : loadGatewaySessionEntryReadOnlyMock(query.key, { agentId: query.agentId });
    return target?.entry
      ? [
          {
            key: query.key,
            agentId: query.agentId,
            entry: target.entry,
            storeTarget: { agentId: query.agentId, storePath: target.storePath },
          },
        ]
      : [];
  },
  capture(query: { key: string; agentId: string; storePath?: string }) {
    return projection.selectEntries(query)[0];
  },
  findBySessionId(query: { sessionId: string; agentId?: string; storePath?: string }) {
    return projection
      .selectEntries({ agentId: query.agentId, storePath: query.storePath })
      .filter(({ entry }) => entry.sessionId === query.sessionId);
  },
  snapshot(query: { key: string; agentId: string }) {
    return { row: loadGatewaySessionRowMock(query.key, { agentId: query.agentId }) };
  },
  describe(query: { key: string; agentId: string; storePath?: string }) {
    const row = projection.snapshot(query).row;
    return row
      ? {
          materialized: { row },
          storeTarget: {
            agentId: query.agentId,
            storePath: query.storePath ?? sessionEventStorePath,
          },
        }
      : undefined;
  },
  present(record: Parameters<SessionRowProjection["present"]>[0]) {
    return record.materialized.row;
  },
} as unknown as SessionRowProjection;

function createLifecycleEventBroadcastHandler(
  params: Parameters<typeof createLifecycleHandler>[0],
) {
  return createLifecycleHandler({ getSessionRowProjection: () => projection, ...params });
}
function createTranscriptUpdateBroadcastHandler(
  params: Parameters<typeof createTranscriptHandler>[0],
) {
  return createTranscriptHandler({ getSessionRowProjection: () => projection, ...params });
}

function createActiveRun(
  projectSessionActive: boolean,
  executionStarted = true,
  identity: {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    storePath?: string;
  } = {},
): RpcSourceRef {
  const ref = createRpcSourceForTest(
    { projectSessionActive },
    {
      sessionId: identity.sessionId ?? "sess-main",
      sessionKey: identity.sessionKey ?? "agent:main:main",
      agentId: identity.agentId,
      storeScope: identity.storePath ?? sessionEventStorePath,
    },
  );
  if (executionStarted) {
    const claim = tryClaimSessionControllerTask(ref.input);
    if (!claim) {
      throw new Error("Fixture could not acquire its isolated turn");
    }
    const sourceIdentity = getRpcSourceIdentity(ref);
    const operation = createReplyOperation({
      sessionId: sourceIdentity.sessionId,
      sessionKey: sourceIdentity.sessionKey,
      resetTriggered: false,
      mailboxClaim: claim,
      target: ref.input.mailbox.owner.target,
    });
    markReplyOperationExecutionStarted(operation);
    setRpcSourceProjectSessionActive(ref, projectSessionActive);
  }
  return ref;
}

function storedMessage(messageId: string, seq = 1) {
  return {
    found: true,
    oversized: false,
    seq,
    message: { role: "assistant", content: `Stored ${messageId}` },
  };
}

function fixedStoreRuntimeConfig(ownerAgentId: string, configuredAgentIds: string[]) {
  return {
    session: { store: "/tmp/shared.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: ownerAgentId } },
      entries: Object.fromEntries(configuredAgentIds.map((agentId) => [agentId, {}])),
    },
  };
}

function createHandler(
  projectSessionActive: boolean,
  executionStarted = true,
  getSessionMessageSubscribers: SessionMessageSubscriberRegistry["get"] = () => new Set<string>(),
) {
  const broadcastToConnIds = vi.fn();
  const source = createActiveRun(projectSessionActive, executionStarted);
  // Preparation has controller custody, but acceptance owns its queued projection.
  rpcSourceTesting.reset(executionStarted ? [["run-before-finalize", source]] : []);
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: getSessionMessageSubscribers },
  });
  return { broadcastToConnIds, handler };
}

const ownerGoal = {
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

const PRIVATE_SESSION_FIELDS =
  "agentId session message owner goal status hasActiveRun activeRunIds model responseUsage".split(
    " ",
  );

function expectPrivateSessionInvalidation(payload: unknown) {
  for (const field of PRIVATE_SESSION_FIELDS) {
    expect(payload, field).not.toHaveProperty(field);
  }
}

async function emitAssistantTranscriptUpdate(
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

export {
  createActiveRun,
  createGatewayBroadcaster,
  createHandler,
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
  emitAssistantTranscriptUpdate,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  listAccessorSessionEntriesReadOnlyMock,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  ownerGoal,
  projectChatDisplayMessageMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  runtimeConfigState,
  sessionRow,
  storedMessage,
  subscribePluginSessionsChanged,
};
