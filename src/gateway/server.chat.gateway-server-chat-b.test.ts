// Gateway chat integration tests cover dashboard chat requests, transcript
// history limits, model overrides, inbound dispatch, and streaming event fanout.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { bindActiveOperatorTurnAuthority } from "../agents/cron-creator-authority-context.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createModelCatalogDecisions } from "../agents/model-catalog-decisions.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { createSessionsHistoryTool } from "../agents/tools/sessions-history-tool.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { resolveSessionRoutingContract } from "../config/sessions/main-session.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  listSessionPendingInputs,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../media/media-reference.js";
import { getMediaDir } from "../media/store.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  assertPluginMetadataSnapshotConsistency,
  createGatewayPluginMetadataSnapshot,
} from "./plugin-metadata.test-helpers.js";
import { readWarmChatStartup } from "./server-chat-startup.test-support.js";
import {
  createChatVisionModelCatalogSnapshot,
  createDirectChatContext,
  createTextTranscriptEvent,
  registerChatConnectionIdentityTest,
} from "./server-chat.agent-events.test-helpers.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import { createGatewayChatMetadataRuntime } from "./server-methods/chat-metadata-runtime.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./server-methods/shared-types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import {
  captureChatResponse,
  captureChatResult,
  type CapturedChatResponse,
} from "./server.chat-response.test-support.js";
import {
  createDirectChatSessionStoreFixture,
  writeMainChatSessionTranscript as writeMainSessionTranscript,
  type ChatSessionDirectoryOptions,
} from "./server.chat-session-store.test-support.js";
import type { GatewaySessionsDefaults } from "./session-utils.types.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const restartRecoveryMocks = vi.hoisted(() => ({
  retryRestartAbortedMainSessionRecovery: vi.fn<
    typeof import("../agents/main-session-recovery/main-session-restart-recovery.js").retryRestartAbortedMainSessionRecovery
  >(async () => ({
    started: 0,
    settled: 0,
    failed: 1,
    skipped: 0,
  })),
}));
const preparedThinkingPolicy = vi.hoisted(() => ({ fallback: "off" as "base" | "off" }));

vi.mock(
  "../agents/main-session-recovery/main-session-restart-recovery.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../agents/main-session-recovery/main-session-restart-recovery.js")
      >();
    return {
      ...actual,
      retryRestartAbortedMainSessionRecovery:
        restartRecoveryMocks.retryRestartAbortedMainSessionRecovery,
    };
  },
);

vi.mock("../plugins/provider-thinking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-thinking.js")>()),
  resolveEffectiveThinkingProfile: (params: { context?: { reasoning?: boolean } }) => {
    const offOnly =
      params.context?.reasoning === false ||
      (params.context?.reasoning === undefined && preparedThinkingPolicy.fallback === "off");
    return offOnly
      ? {
          levels: [{ id: "off", label: "off" }],
          defaultLevel: "off",
          preserveWhenCatalogReasoningFalse: true,
        }
      : undefined;
  },
}));

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 2_000, interval: 1 } as const;
function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;

const autoCleanupTempDirs = createTempDirTracker();
const sessionStoreFixture = createDirectChatSessionStoreFixture(autoCleanupTempDirs);
const openDirectChatSession = sessionStoreFixture.open;

afterEach(async () => {
  await resetDirectChatSession();
  autoCleanupTempDirs.cleanup();
});

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  sessionStoreFixture.prepare();
});

afterAll(async () => {
  try {
    await sessionStoreFixture.dispose();
  } finally {
    await harness.close();
  }
});

async function withGatewayChatHarness(
  run: (ctx: {
    ws: GatewaySocket;
    createSessionDir: (options?: ChatSessionDirectoryOptions) => Promise<string>;
  }) => Promise<void>,
  options?: { headers?: Record<string, string> },
) {
  const ws = await harness.openWs(options?.headers);
  const createSessionDir = async (directoryOptions?: ChatSessionDirectoryOptions) =>
    openDirectChatSession(directoryOptions).sessionDir;

  try {
    await run({ ws, createSessionDir });
  } finally {
    await resetDirectChatSession();
    if (process.env.OPENCLAW_CONFIG_PATH) {
      await fs.rm(process.env.OPENCLAW_CONFIG_PATH, { force: true });
    }
    ws.close();
  }
}

function testSessionFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

async function writeMainSessionStore(sessionId = "sess-main") {
  await writeStoredMainSession({
    sessionId,
    updatedAt: futureFixtureUpdatedAt(),
  });
}

function futureFixtureUpdatedAt(): number {
  return Date.now() + 60_000;
}

type HistoryPage = {
  messages?: Array<{ __openclaw?: { seq?: number } }>;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
};

function readOpenClawSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const seq = (metadata as Record<string, unknown>).seq;
  return typeof seq === "number" ? seq : undefined;
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  resetConfigRuntimeState();
}

async function withDirectChatSession(
  run: (sessionDir: string, storePath: string) => Promise<void>,
) {
  const { sessionDir, storePath } = openDirectChatSession();
  try {
    await run(sessionDir, storePath);
  } finally {
    await resetDirectChatSession();
  }
}

type StoredSessionEntry = Parameters<typeof writeSessionStore>[0]["entries"][string];

function getDirectChatSessionWorkRelease(sessionKey = "agent:main:main") {
  return getSessionWorkAdmissionRelease({
    scope: resolveSessionStorePathForScope({ sessionKey }, getRuntimeConfig()),
    identities: [sessionKey],
  });
}

async function resetDirectChatSession() {
  await disposeSessionReadContexts();
  await sessionStoreFixture.reset();
  dispatchInboundMessageMock.mockReset();
  resetConfigRuntimeState();
}

async function writeStoredMainSession(entry: StoredSessionEntry = {}) {
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        ...entry,
      },
    },
  });
}

type DirectChatMethod = "chat.abort" | "chat.history" | "chat.send" | "chat.startup";

async function callDirectChatHandler(
  method: DirectChatMethod,
  options: GatewayRequestHandlerOptions,
) {
  const { coreGatewayHandlers } = await import("./server-methods.js");
  if (method === "chat.history" || method === "chat.startup") {
    await initializeSessionReadContext(options.context);
  }
  await expectDefined(coreGatewayHandlers[method], `${method} test invariant`)(options);
}

type DirectChatCallOptions = Omit<
  GatewayRequestHandlerOptions,
  "client" | "isWebchatConnect" | "req"
> & {
  id: string;
  client?: GatewayRequestHandlerOptions["client"];
  isWebchatConnect?: GatewayRequestHandlerOptions["isWebchatConnect"];
  req?: GatewayRequestHandlerOptions["req"];
};

async function callDirectChat(method: DirectChatMethod, options: DirectChatCallOptions) {
  const { client, id, isWebchatConnect, req, ...handlerOptions } = options;
  await callDirectChatHandler(method, {
    ...handlerOptions,
    req: req ?? { type: "req", id, method, params: options.params },
    client: client ?? null,
    isWebchatConnect: isWebchatConnect ?? (() => false),
  });
}

function createControlUiClient(
  scopes = ["operator.write", "operator.admin"],
  properties: Record<string, unknown> = {},
) {
  return {
    ...properties,
    connect: {
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes,
    },
  } as never;
}

type ChatSendParamOverrides = {
  idempotencyKey: string;
  [key: string]: unknown;
};

function makeMainSessionParams(overrides: Record<string, unknown> = {}) {
  return { sessionKey: "main", ...overrides };
}

function makeMainMessageParams(messageId: string) {
  return { sessionKey: "main", messageId };
}

function makeChatSendParams(overrides: ChatSendParamOverrides) {
  return makeMainSessionParams({ message: "hello", ...overrides });
}

function makeMainSessionScope(storePath: string | undefined) {
  return {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  };
}

function makeGatewayWebchatClient(id: string = GATEWAY_CLIENT_NAMES.CONTROL_UI) {
  return {
    client: {
      id,
      version: "1.0.0",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  };
}

function makeTuiClient() {
  return {
    connId: "conn-tui",
    connect: {
      client: { id: GATEWAY_CLIENT_NAMES.TUI, mode: GATEWAY_CLIENT_MODES.UI },
      scopes: ["operator.write", "operator.admin"],
    },
  } as never;
}

function makeTranscriptTextEvent(
  text: string,
  overrides: {
    role?: "assistant" | "toolResult" | "user";
    message?: Record<string, unknown>;
    [key: string]: unknown;
  } = {},
) {
  const { role = "assistant", message = {}, ...event } = overrides;
  return {
    ...event,
    message: { role, content: [{ type: "text", text }], ...message },
  };
}

function makeDoneSessionEntry(overrides: StoredSessionEntry = {}): StoredSessionEntry {
  return { status: "done", ...overrides };
}

async function sendControlUiChat(params: {
  authenticatedUserId?: string;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    hasAvatar: boolean;
  };
  context: GatewayRequestContext;
  expectedSessionRoutingContract?: string;
  idempotencyKey: string;
  message: string;
  respond: RespondFn;
  onAdmissionOwned?: () => Promise<boolean>;
  localClient?: boolean;
}): Promise<void> {
  const requestParams = makeChatSendParams({
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    ...(params.expectedSessionRoutingContract
      ? { expectedSessionRoutingContract: params.expectedSessionRoutingContract }
      : {}),
  });
  const options: GatewayRequestHandlerOptions = {
    req: {
      type: "req",
      id: params.idempotencyKey,
      method: "chat.send",
      params: requestParams,
    },
    params: requestParams,
    client: createControlUiClient(undefined, {
      ...(params.localClient ? { internal: { isLocalClient: true } } : {}),
      ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
      ...(params.authenticatedUserProfile
        ? { authenticatedUserProfile: params.authenticatedUserProfile }
        : {}),
    }),
    isWebchatConnect: () => true,
    respond: params.respond,
    context: params.context,
  };
  if (params.onAdmissionOwned) {
    const { handleChatSend } = await import("./server-methods/chat-send-handler.js");
    await handleChatSend(options, params.onAdmissionOwned);
    return;
  }
  await callDirectChatHandler("chat.send", options);
}

test("chat.send replays a cached result after the session is archived", async () => {
  openDirectChatSession();
  try {
    dispatchInboundMessageMock.mockClear();
    await writeStoredMainSession({
      archivedAt: Date.now(),
    });
    const context = createDirectChatContext();
    const runId = "idem-archived-cached-result";
    const cachedPayload = { runId, status: "ok", summary: "already completed" };
    context.dedupe.set(`chat:${runId}`, {
      ts: Date.now(),
      ok: true,
      payload: cachedPayload,
    });
    const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown; meta?: unknown }> =
      [];
    await callDirectChat("chat.send", {
      id: "cached",
      req: { type: "req", id: "cached", method: "chat.send" },
      params: makeChatSendParams({
        message: "retry completed send",
        idempotencyKey: runId,
      }),
      respond: ((ok, payload, error, meta) => {
        responses.push({ ok, payload, error, meta });
      }) as RespondFn,
      context,
    });

    expect(responses).toEqual([
      {
        ok: true,
        payload: cachedPayload,
        error: undefined,
        meta: { cached: true },
      },
    ]);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  } finally {
    await resetDirectChatSession();
  }
});

async function fetchHistoryMessages(
  ws: GatewaySocket,
  params?: {
    limit?: number;
    maxChars?: number;
  },
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(
    ws,
    "chat.history",
    makeMainSessionParams({
      limit: params?.limit ?? 1000,
      ...(typeof params?.maxChars === "number" ? { maxChars: params.maxChars } : {}),
    }),
  );
  expect(historyRes.ok, JSON.stringify(historyRes.error)).toBe(true);
  return historyRes.payload?.messages ?? [];
}

async function fetchChatMessage(
  ws: GatewaySocket,
  params: {
    sessionKey: string;
    agentId?: string;
    messageId: string;
    maxChars?: number;
  },
): Promise<{
  ok?: boolean;
  message?: unknown;
  unavailableReason?: "not_found" | "oversized" | "not_visible";
}> {
  const res = await rpcReq<{
    ok?: boolean;
    message?: unknown;
    unavailableReason?: "not_found" | "oversized" | "not_visible";
  }>(ws, "chat.message.get", {
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    messageId: params.messageId,
    ...(typeof params.maxChars === "number" ? { maxChars: params.maxChars } : {}),
  });
  if (!res.ok) {
    throw new Error(`chat.message.get rpc failed: ${JSON.stringify(res.error ?? null)}`);
  }
  return res.payload ?? {};
}

type ConfiguredImageModelCase = {
  id: string;
  imageModel: AgentModelConfig;
};

const configuredImageModelCases: ConfiguredImageModelCase[] = [
  {
    id: "with-image-fallback",
    imageModel: { primary: "openai/gpt-4o", fallbacks: ["openai/gpt-4o-mini"] },
  },
];

async function prepareMainHistoryHarness(params: {
  ws: GatewaySocket;
  createSessionDir: (options?: ChatSessionDirectoryOptions) => Promise<string>;
  freshStore?: boolean;
  sessionId?: string;
}) {
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir({ fresh: params.freshStore });
  await writeMainSessionStore(params.sessionId);
  return sessionDir;
}

async function prepareUnconfiguredAcpHarnessSession(options?: { withMetadata?: boolean }) {
  openDirectChatSession({ fresh: true });
  const sessionKey = `agent:codex:acp:${randomUUID()}`;
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    acp: { enabled: true, backend: "acpx", allowedAgents: ["codex"] },
  };
  testState.agentsConfig = config.agents;
  await writeGatewayConfig(config);
  if (options?.withMetadata === false) {
    await writeSessionStore({
      agentId: "codex",
      entries: {
        [sessionKey]: {
          sessionId: "sess-acp-codex",
          updatedAt: Date.now(),
        },
      },
    });
  } else {
    await upsertAcpSessionMeta({
      sessionKey,
      agentId: "codex",
      cfg: getRuntimeConfig(),
      now: () => 1,
      mutate: () => ({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: sessionKey,
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      }),
    });
  }
  return sessionKey;
}

describe("gateway server chat", () => {
  test.each(["chat.history"] as const)(
    "%s reads a persisted ACP harness session without configuring its harness as an ordinary agent",
    async (method) => {
      try {
        const sessionKey = await prepareUnconfiguredAcpHarnessSession();
        const responses: CapturedChatResponse[] = [];
        await callDirectChat(method, {
          id: `acp-harness-${method}`,
          params: { sessionKey },
          respond: captureChatResponse(responses),
          context: createDirectChatContext({ getRuntimeConfig }),
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok, JSON.stringify(responses[0]?.error ?? null)).toBe(true);
      } finally {
        testState.agentsConfig = undefined;
        await resetDirectChatSession();
      }
    },
  );

  test("chat.send accepts a persisted ACP harness without configuring it as an ordinary agent", async () => {
    try {
      const sessionKey = await prepareUnconfiguredAcpHarnessSession();
      const responses: CapturedChatResponse[] = [];
      const context = createDirectChatContext({ getRuntimeConfig });
      await callDirectChat("chat.send", {
        id: "acp-harness-send",
        params: {
          sessionKey,
          message: "continue the bound ACP session",
          idempotencyKey: "acp-harness-send",
        },
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses).toHaveLength(1);
      expect(responses[0]?.ok, JSON.stringify(responses[0]?.error ?? null)).toBe(true);
      expect(responses[0]?.payload).toMatchObject({ status: "started" });
      await getDirectChatSessionWorkRelease(sessionKey);
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      testState.agentsConfig = undefined;
      await resetDirectChatSession();
    }
  });

  test("chat.send rejects an unconfigured ACP-shaped session without authoritative ACP metadata", async () => {
    try {
      const sessionKey = await prepareUnconfiguredAcpHarnessSession({ withMetadata: false });
      const responses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "acp-harness-forged",
        params: {
          sessionKey,
          message: "reject an unconfirmed ACP session",
          idempotencyKey: "acp-harness-forged",
        },
        respond: captureChatResponse(responses),
        context: createDirectChatContext({ getRuntimeConfig }),
      });

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        ok: false,
        error: { message: 'Agent "codex" no longer exists in configuration' },
      });
    } finally {
      testState.agentsConfig = undefined;
      await resetDirectChatSession();
    }
  });

  test.each(["chat.history"] as const)(
    "%s projects the session's durable worker placement",
    async (method) => {
      openDirectChatSession();
      try {
        await writeMainSessionStore();
        const placement = {
          sessionId: "sess-main",
          agentId: "main",
          sessionKey: "agent:main:main",
          executionMode: "worker-turn",
          state: "active",
          environmentId: "env-placement",
          generation: 7,
          activeOwnerEpoch: 12,
          workspaceBaseManifestRef: "manifest-base",
          remoteWorkspaceDir: "/workspace/main",
          workerBundleHash: "ab".repeat(32),
          recoveryError: null,
          terminalReason: null,
          terminalAtMs: null,
          turnClaim: null,
          createdAtMs: 100,
          updatedAtMs: 300,
          stateChangedAtMs: 200,
        };
        const context = createDirectChatContext({
          workerSessionPlacementService: {
            getMany: () => new Map([[placement.sessionId, placement]]),
          },
        } as unknown as Partial<GatewayRequestContext>);
        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        // Clients merge this row into the same store sessions.list fills, so a
        // missing placement here silently erases a live worker placement.
        expect(
          (responses[0]?.payload as { sessionInfo?: { placement?: { state?: string } } })
            ?.sessionInfo?.placement,
        ).toMatchObject({ state: "active", environmentId: "env-placement" });
      } finally {
        testState.sessionStorePath = undefined;
      }
    },
  );

  test.each(["chat.history"] as const)(
    "%s projects embedded identity through the existing run snapshot",
    async (method) => {
      const {
        createAgentEventHandler,
        createSessionEventSubscriberRegistry,
        createSessionMessageSubscriberRegistry,
      } = await import("./server-chat.js");
      openDirectChatSession();
      await writeMainSessionStore();
      const context = createDirectChatContext();
      const handler = createAgentEventHandler({
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        resolveSessionKeyForRun: () => "main",
        clearAgentRunContext: vi.fn(),
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      });
      const handle: EmbeddedAgentQueueHandle = {
        runId: "run-embedded",
        startedAtMs: 1_700_000_000_000,
        abort: () => undefined,
        isAborted: () => false,
        isCompacting: () => false,
        isStreaming: () => true,
        queueMessage: async () => undefined,
      };
      setActiveEmbeddedRun("sess-main", handle, "main");
      try {
        await handler({
          runId: "run-embedded",
          seq: 1,
          stream: "item",
          ts: 1_001,
          data: { kind: "preamble", itemId: "preamble-1", progressText: "Checking files" },
        });
        await handler({
          runId: "run-embedded",
          seq: 2,
          stream: "tool",
          ts: 1_002,
          data: {
            phase: "start",
            name: "exec",
            toolCallId: "tool-1",
            args: { command: "SECRET_COMMAND" },
          },
        });
        await handler({
          runId: "run-embedded",
          seq: 3,
          stream: "tool",
          ts: 1_003,
          data: {
            phase: "input_delta",
            name: "exec",
            toolCallId: "tool-1",
            diff: "SECRET_DIFF",
          },
        });
        await handler({
          runId: "run-embedded",
          seq: 4,
          stream: "tool",
          ts: 1_004,
          data: {
            phase: "update",
            name: "exec",
            toolCallId: "tool-1",
            partialResult: "SECRET_PARTIAL",
          },
        });
        await handler({
          runId: "run-embedded",
          seq: 5,
          stream: "tool",
          ts: 1_005,
          data: {
            phase: "review",
            name: "exec",
            toolCallId: "tool-1",
            review: { id: "review-1", text: "SECRET_REVIEW" },
          },
        });
        await handler({
          runId: "run-embedded",
          seq: 6,
          stream: "tool",
          ts: 1_006,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-1",
            result: "SECRET_RESULT",
          },
        });
        await handler({
          runId: "run-embedded",
          seq: 7,
          stream: "plan",
          ts: 1_007,
          data: {
            phase: "update",
            steps: [{ step: "Inspect", status: "in_progress" }],
          },
        });

        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        const inFlightRun = (responses[0]?.payload as { inFlightRun?: unknown } | undefined)
          ?.inFlightRun;
        expect(inFlightRun).toEqual({
          runId: "run-embedded",
          text: "",
          startedAt: 1_700_000_000_000,
          sessionAbortable: true,
          events: [
            {
              runId: "run-embedded",
              seq: 1,
              stream: "item",
              ts: 1_001,
              sessionKey: "main",
              data: {
                kind: "preamble",
                itemId: "preamble-1",
                progressText: "Checking files",
              },
            },
            {
              runId: "run-embedded",
              seq: 2,
              stream: "tool",
              ts: 1_002,
              sessionKey: "main",
              data: { phase: "start", name: "exec", toolCallId: "tool-1" },
            },
            {
              runId: "run-embedded",
              seq: 3,
              stream: "tool",
              ts: 1_003,
              sessionKey: "main",
              data: { phase: "input_delta", name: "exec", toolCallId: "tool-1" },
            },
            {
              runId: "run-embedded",
              seq: 4,
              stream: "tool",
              ts: 1_004,
              sessionKey: "main",
              data: { phase: "update", name: "exec", toolCallId: "tool-1" },
            },
            {
              runId: "run-embedded",
              seq: 6,
              stream: "tool",
              ts: 1_006,
              sessionKey: "main",
              data: { phase: "result", name: "exec", toolCallId: "tool-1" },
            },
          ],
          plan: { steps: [{ step: "Inspect", status: "in_progress" }] },
        });
        expect(JSON.stringify(inFlightRun)).not.toContain("SECRET");
      } finally {
        clearActiveEmbeddedRun("sess-main", handle, "main");
        testState.sessionStorePath = undefined;
      }
    },
  );

  test.each(["chat.history"] as const)(
    "%s adopts the in-flight run for a non-default agent alias key",
    async (method) => {
      const { sessionDir } = openDirectChatSession({ fresh: true });
      try {
        // Per-agent stores: bare keys then carry no persisted fixed-store
        // owner, so an explicit non-default agentId is a valid pairing.
        testState.sessionConfig = {
          store: path.join(sessionDir, "sessions-{agentId}.json"),
        };
        await writeGatewayConfig({
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, writer: {} },
          },
        });
        await writeSessionStore({
          agentId: "writer",
          storePath: path.join(sessionDir, "sessions-writer.json"),
          entries: { "agent:writer:notes": { sessionId: "sess-writer", updatedAt: Date.now() } },
        });
        const writerConfig = {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, writer: {} },
          },
          session: { store: path.join(sessionDir, "sessions-{agentId}.json") },
        } satisfies OpenClawConfig;
        const context = createDirectChatContext({
          getRuntimeConfig: () => writerConfig,
        });
        const controller = new AbortController();
        // chat.send registers the agent-scoped canonical key; the handler's
        // in-flight adoption must resolve the same scoped key for the bare
        // alias request or the streaming run renders idle on switch-back.
        context.chatAbortControllers.set("run-writer", {
          controller,
          sessionId: "sess-writer",
          sessionKey: "agent:writer:notes",
          agentId: "writer",
          startedAtMs: 1_000,
          expiresAtMs: Date.now() + 60_000,
          projectSessionActive: true,
        });
        context.chatRunState.getOrCreate("run-writer").buffer = "writer partial";
        const responses: CapturedChatResponse[] = [];
        await callDirectChat(method, {
          id: method,
          params: { sessionKey: "notes", agentId: "writer" },
          respond: captureChatResponse(responses),
          context,
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok, JSON.stringify(responses[0]?.error ?? null)).toBe(true);
        expect(
          (responses[0]?.payload as { inFlightRun?: unknown } | undefined)?.inFlightRun,
        ).toMatchObject({ runId: "run-writer", text: "writer partial" });
      } finally {
        testState.sessionConfig = undefined;
        testState.sessionStorePath = undefined;
      }
    },
  );

  test.each(["chat.history"] as const)(
    "%s retains completed tool owner events in bounded inFlightRun replay",
    async (method) => {
      const {
        createAgentEventHandler,
        createSessionEventSubscriberRegistry,
        createSessionMessageSubscriberRegistry,
      } = await import("./server-chat.js");
      openDirectChatSession();
      const context = createDirectChatContext();
      const handler = createAgentEventHandler({
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        resolveSessionKeyForRun: () => "main",
        clearAgentRunContext: vi.fn(),
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      });
      try {
        await writeMainSessionStore();
        const controller = new AbortController();
        context.chatAbortControllers.set("run-active", {
          controller,
          sessionId: "sess-main",
          sessionKey: "main",
          startedAtMs: 1_000,
          expiresAtMs: 10_000,
          projectSessionActive: true,
        });
        context.chatRunState.registry.add("provider-run", {
          sessionKey: "main",
          clientRunId: "run-active",
        });
        const toolArgs = { path: "a" };

        await handler({
          runId: "provider-run",
          seq: 1,
          stream: "item",
          ts: 1_001,
          data: { kind: "preamble", itemId: "preamble-1", progressText: "Checking files" },
        });
        await handler({
          runId: "provider-run",
          seq: 2,
          stream: "tool",
          ts: 1_002,
          data: { phase: "start", name: "read", toolCallId: "tool-active", args: toolArgs },
        });
        await handler({
          runId: "provider-run",
          seq: 3,
          stream: "tool",
          ts: 1_003,
          data: {
            phase: "update",
            name: "read",
            toolCallId: "tool-active",
            partialResult: "halfway",
          },
        });
        await handler({
          runId: "provider-run",
          seq: 4,
          stream: "tool",
          ts: 1_004,
          data: { phase: "start", name: "exec", toolCallId: "tool-finished", args: {} },
        });
        await handler({
          runId: "provider-run",
          seq: 5,
          stream: "tool",
          ts: 1_005,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-finished",
            result: "x".repeat(256_000),
          },
        });
        // A delayed result older than the latest accepted progress event must
        // not remove the active tool from the reconnect projection.
        await handler({
          runId: "provider-run",
          seq: 3,
          stream: "tool",
          ts: 1_006,
          data: { phase: "result", name: "read", toolCallId: "tool-active", result: "stale" },
        });
        await handler({
          runId: "provider-run",
          seq: 6,
          stream: "item",
          ts: 1_006,
          data: {
            kind: "preamble",
            itemId: "preamble-2",
            progressText: "Autoreview is running",
          },
        });

        toolArgs.path = "producer changed after emission";
        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok).toBe(true);
        expect(
          (responses[0]?.payload as { inFlightRun?: unknown } | undefined)?.inFlightRun,
        ).toEqual({
          runId: "run-active",
          text: "",
          startedAt: 1_000,
          events: [
            {
              runId: "run-active",
              seq: 1,
              stream: "item",
              ts: 1_001,
              sessionKey: "main",
              data: {
                kind: "preamble",
                itemId: "preamble-1",
                progressText: "Checking files",
              },
            },
            {
              runId: "run-active",
              seq: 2,
              stream: "tool",
              ts: 1_002,
              sessionKey: "main",
              data: {
                phase: "start",
                name: "read",
                toolCallId: "tool-active",
                args: { path: "a" },
              },
            },
            {
              runId: "run-active",
              seq: 3,
              stream: "tool",
              ts: 1_003,
              sessionKey: "main",
              data: {
                phase: "update",
                name: "read",
                toolCallId: "tool-active",
                partialResult: "halfway",
              },
            },
            {
              runId: "run-active",
              seq: 4,
              stream: "tool",
              ts: 1_004,
              sessionKey: "main",
              data: {
                phase: "start",
                name: "exec",
                toolCallId: "tool-finished",
                args: {},
              },
            },
            {
              runId: "run-active",
              seq: 5,
              stream: "tool",
              ts: 1_005,
              sessionKey: "main",
              data: {
                phase: "result",
                name: "exec",
                toolCallId: "tool-finished",
              },
            },
            {
              runId: "run-active",
              seq: 6,
              stream: "item",
              ts: 1_006,
              sessionKey: "main",
              data: {
                kind: "preamble",
                itemId: "preamble-2",
                progressText: "Autoreview is running",
              },
            },
          ],
        });
      } finally {
        await handler.dispose();
        testState.sessionStorePath = undefined;
      }
    },
  );

  test("chat.startup returns warm metadata while agents.list owns roster provenance", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "main" },
            model: {
              primary: "openai/gpt-main",
            },
            models: {
              "openai/gpt-main": {},
            },
          },
          entries: { main: {}, research: {} },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [{ id: "gpt-main", name: "GPT Main" }],
            },
          },
        },
      });
      recordAgentProvenance(
        "research",
        { createdVia: "agent", creatorAgentId: "main" },
        { nowMs: 42 },
      );
      await connectOk(ws, { prePairDevice: true });
      await createSessionDir();
      const updatedAt = Date.now();
      await writeStoredMainSession({
        updatedAt,
        modelProvider: "openai",
        model: "gpt-5",
      });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "startup hydrate", { timestamp: updatedAt }),
      ]);
      const preparedMetadata = await rpcReq(ws, "chat.metadata", { agentId: "main" });
      expect(preparedMetadata.ok).toBe(true);

      const startup = await readWarmChatStartup(ws, makeMainSessionParams());
      const agents = await rpcReq<{
        agents?: Array<{
          id?: string;
          createdVia?: string;
          creatorAgentId?: string | null;
          createdAt?: number;
        }>;
        defaultId?: string | null;
        mainKey?: string | null;
      }>(ws, "agents.list", {});

      expect(startup.ok).toBe(true);
      expect(startup.payload).not.toHaveProperty("agentsList");
      expect(agents.ok).toBe(true);
      expect(agents.payload?.defaultId).toBe("main");
      expect(agents.payload?.mainKey).toBe("main");
      expect(agents.payload?.agents?.map((agent) => agent.id)).toContain("main");
      expect(agents.payload?.agents?.find((agent) => agent.id === "research")).toMatchObject({
        createdVia: "agent",
        creatorAgentId: "main",
        createdAt: 42,
      });
      expect(startup.payload?.sessionInfo).toMatchObject({
        key: "agent:main:main",
        sessionId: "sess-main",
      });
      expect(startup.payload?.metadata?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "gpt-main",
            provider: "openai",
          }),
        ]),
      );
      expect(startup.payload?.metadata?.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "model",
            textAliases: expect.arrayContaining(["/model"]),
          }),
        ]),
      );
      expect(startup.payload?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "startup hydrate" }],
          }),
        ]),
      );
    });
  });

  test.each([
    { method: "chat.startup", profile: false, delta: false, thinkingLevel: undefined },
    { method: "chat.history", profile: true, delta: true, thinkingLevel: "off" },
  ] as const)(
    "$method returns transcript while metadata replacement is pending (profile=$profile delta=$delta thinking=$thinkingLevel)",
    async ({ method, profile, delta, thinkingLevel }) => {
      const { storePath } = openDirectChatSession();
      testState.agentConfig = { thinkingDefault: "medium" };
      try {
        await writeStoredMainSession({
          thinkingLevel,
          ...(profile
            ? {
                authProfileOverride: "test:session",
                authProfileOverrideSource: "user",
              }
            : {}),
        });
        await writeMainSessionTranscript([
          createTextTranscriptEvent("user", "paint without metadata"),
        ]);
        const responses: CapturedChatResponse[] = [];
        const context = createDirectChatContext();
        await initializeSessionReadContext(context);
        let cursor: string | undefined;
        if (delta) {
          const initial: CapturedChatResponse[] = [];
          await callDirectChat("chat.history", {
            id: "history-before-metadata-replacement",
            params: makeMainSessionParams(),
            respond: captureChatResponse(initial),
            context,
          });
          expect(initial[0]?.ok).toBe(true);
          const initialPayload = expectDefined(initial[0]?.payload, "initial history page") as {
            deltaCursor?: string;
          };
          cursor = initialPayload.deltaCursor;
          expect(cursor).toEqual(expect.any(String));
        }
        const metadataRuntime = createGatewayChatMetadataRuntime({
          getConfig: context.getRuntimeConfig,
          getContext: () => context,
          log: context.logGateway,
        });
        context.readChatStartupProjection = metadataRuntime.readStartup;
        metadataRuntime.invalidate();

        const startup = callDirectChat(method, {
          id: "startup-neutral-pending-metadata",
          params: makeMainSessionParams(delta ? { cursor } : {}),
          respond: captureChatResponse(responses),
          context,
        });

        try {
          await vi.waitFor(() => expect(responses).toHaveLength(1), FAST_WAIT_OPTS);
          if (delta) {
            expect(responses[0]).toMatchObject({
              ok: true,
              payload: { kind: "delta", messages: [] },
            });
          } else {
            expect(responses[0]).toMatchObject({
              ok: true,
              payload: {
                messages: [
                  expect.objectContaining({
                    role: "user",
                    content: [{ type: "text", text: "paint without metadata" }],
                  }),
                ],
              },
            });
          }
          expect(responses[0]?.payload).not.toHaveProperty("metadata");
          const payload = responses[0]?.payload as {
            sessionInfo: {
              thinkingLevel?: string | null;
              thinkingDefault?: string;
            };
          };
          expect(payload.sessionInfo.thinkingDefault).toBe("medium");
          expect(payload.sessionInfo.thinkingLevel ?? null).toBe(thinkingLevel ?? null);
          const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
          expect(stored?.thinkingLevel).toBe(thinkingLevel);
          expect(stored?.authProfileOverride).toBe(profile ? "test:session" : undefined);
        } finally {
          metadataRuntime.fail(new Error("test metadata replacement stopped"));
          await startup;
        }
      } finally {
        testState.agentConfig = undefined;
        testState.sessionStorePath = undefined;
      }
    },
  );

  test.each<{
    name: string;
    preparedReasoning?: boolean;
    rawCatalog: "slow" | "empty" | "nonreasoning" | "prepared";
    configured?: { agent?: "off" | "low"; model?: "off" | "medium"; global?: "off" | "high" };
    thinkingLevel?: "off" | "xhigh";
    preparedEmpty?: boolean;
    preparedUnknown?: boolean;
    expectedDefault?: string;
  }>([
    {
      name: "inherits prepared Medium while raw discovery is slow",
      preparedReasoning: true,
      rawCatalog: "slow",
      expectedDefault: "medium",
    },
    {
      name: "keeps identity-only prepared metadata unknown and explicit XHigh intact",
      rawCatalog: "empty",
      preparedUnknown: true,
      thinkingLevel: "xhigh",
    },
    {
      name: "respects a prepared non-reasoning model",
      preparedReasoning: false,
      rawCatalog: "prepared",
      expectedDefault: "off",
    },
    {
      name: "keeps an empty prepared catalog unknown",
      rawCatalog: "nonreasoning",
      preparedEmpty: true,
    },
    {
      name: "respects per-model Off over the global default without metadata",
      rawCatalog: "slow",
      configured: { model: "off", global: "high" },
      expectedDefault: "off",
    },
    {
      name: "respects per-agent Off over model and global defaults without metadata",
      rawCatalog: "slow",
      configured: { agent: "off", model: "medium", global: "high" },
      expectedDefault: "off",
    },
  ])("chat.history reasoning-default projection $name", async (fixture) => {
    const { storePath } = openDirectChatSession();
    preparedThinkingPolicy.fallback = "base";
    try {
      testState.agentConfig = {
        model: { primary: "test-provider/slow-catalog-model" },
        thinkingDefault: fixture.configured?.global,
        models: {
          "test-provider/slow-catalog-model": { params: { thinking: fixture.configured?.model } },
        },
      };
      testState.agentsConfig = {
        defaults: testState.agentConfig,
        entries: { main: { thinkingDefault: fixture.configured?.agent } },
      };
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "slow-catalog-model",
        ...(fixture.thinkingLevel ? { thinkingLevel: fixture.thinkingLevel } : {}),
      });
      const config = getRuntimeConfig();
      await appendTranscriptMessage(makeMainSessionScope(storePath), {
        eventId: "reasoning-projection-message",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "reasoning projection" }],
        },
      });
      const preparedModel = {
        provider: "test-provider",
        id: "slow-catalog-model",
        name: "Reasoning Model",
        reasoning: fixture.preparedReasoning,
        compat: fixture.preparedUnknown
          ? undefined
          : { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      };
      const preparedCatalog = [preparedModel];
      const rawSnapshot = {
        agentId: "main",
        agentDir: "/tmp/chat-history-agent",
        catalogComplete: false,
        workspaceDir: "/tmp/chat-history-workspace",
        config,
        entries:
          fixture.rawCatalog === "empty"
            ? []
            : fixture.rawCatalog === "nonreasoning"
              ? [{ ...preparedModel, reasoning: false }]
              : preparedCatalog,
        routeVariants: [],
      };
      const slowCatalog =
        createDeferred<
          Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>
        >();
      const context = createDirectChatContext({
        loadGatewayModelCatalogSnapshot: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
          .mockReturnValue(
            fixture.rawCatalog === "slow" ? slowCatalog.promise : Promise.resolve(rawSnapshot),
          ),
        getRuntimeConfig: () => config,
        readPreparedGatewayModelCatalog: async () =>
          fixture.preparedEmpty
            ? { entries: [] }
            : fixture.preparedReasoning === undefined && !fixture.preparedUnknown
              ? undefined
              : { entries: preparedCatalog, pluginRegistry: { providers: [] } },
        readChatStartupProjection: async () =>
          fixture.preparedEmpty
            ? {
                metadata: { swarmEnabled: false },
                sessionModelCatalog: [],
                defaultModelCatalog: [],
              }
            : fixture.preparedReasoning === undefined && !fixture.preparedUnknown
              ? undefined
              : {
                  metadata: { models: preparedCatalog, swarmEnabled: false },
                  sessionModelCatalog: preparedCatalog,
                  defaultModelCatalog: preparedCatalog,
                },
      });
      try {
        let cursor: string | undefined;
        for (const mode of ["startup", "page", "delta"] as const) {
          if (mode === "delta") {
            await appendTranscriptMessage(makeMainSessionScope(storePath), {
              eventId: "reasoning-projection-reply",
              parentId: "reasoning-projection-message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "reasoning reply" }],
              },
            });
          }
          const responses: CapturedChatResponse[] = [];
          await callDirectChat(mode === "startup" ? "chat.startup" : "chat.history", {
            id: `history-reasoning-${mode}`,
            params: makeMainSessionParams(mode === "delta" ? { cursor } : {}),
            respond: captureChatResponse(responses),
            context,
          });

          expect(responses).toHaveLength(1);
          expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
          const payload = responses[0]?.payload as {
            kind?: string;
            deltaCursor?: string;
            messages: Array<{ session?: Record<string, unknown> }>;
            thinkingLevel?: string;
            defaults?: GatewaySessionsDefaults;
            sessionInfo: {
              sessionId?: string;
              modelProvider?: string;
              model?: string;
              agentRuntime?: unknown;
              activeLeafEntryId?: string | null;
              thinkingLevel?: string | null;
              thinkingDefault?: string;
              thinkingLevels?: Array<{ id: string; label: string }>;
              thinkingOptions?: string[];
            };
          };
          expect(payload.sessionInfo, mode).toMatchObject({
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "slow-catalog-model",
          });
          if (mode !== "startup") {
            expect(payload).not.toHaveProperty("metadata");
          }
          if (mode === "delta") {
            expect(payload.kind).toBe("delta");
            expect(payload.messages).toHaveLength(1);
            expect(payload.messages[0]?.session).toMatchObject({
              sessionId: payload.sessionInfo.sessionId,
              modelProvider: payload.sessionInfo.modelProvider,
              model: payload.sessionInfo.model,
              agentRuntime: payload.sessionInfo.agentRuntime,
              thinkingLevel: fixture.thinkingLevel ?? null,
            });
            for (const field of ["thinkingDefault", "thinkingLevels", "thinkingOptions"]) {
              expect(payload.messages[0]?.session).not.toHaveProperty(field);
            }
            expect(payload.sessionInfo.activeLeafEntryId).toBe("reasoning-projection-reply");
            expect(payload.deltaCursor).toEqual(expect.any(String));
            expect(payload.deltaCursor).not.toBe(cursor);
          } else {
            expect(payload.messages).toEqual([
              expect.objectContaining({
                content: [{ type: "text", text: "reasoning projection" }],
              }),
            ]);
            expect(payload.deltaCursor).toEqual(expect.any(String));
            cursor = payload.deltaCursor;
            expect
              .soft(payload.thinkingLevel, `${mode} effective thinking`)
              .toBe(fixture.thinkingLevel ?? fixture.expectedDefault);
          }
          expect(payload.sessionInfo.thinkingLevel ?? null, `${mode} override`).toBe(
            fixture.thinkingLevel ?? null,
          );
          const projections =
            mode === "delta"
              ? [payload.sessionInfo]
              : [payload.sessionInfo, expectDefined(payload.defaults, "page defaults")];
          for (const projection of projections) {
            expect
              .soft(projection.thinkingDefault, `${mode} default`)
              .toBe(fixture.expectedDefault);
            if (fixture.preparedReasoning === true) {
              expect
                .soft(
                  projection.thinkingLevels?.map((level) => level.id),
                  `${mode} supported levels`,
                )
                .toEqual(expect.arrayContaining(["medium", "xhigh"]));
            } else if (fixture.preparedReasoning === false) {
              expect(
                projection.thinkingLevels?.map((level) => level.id),
                mode,
              ).toEqual(["off", "ultra"]);
            } else {
              expect.soft(projection.thinkingLevels, `${mode} unknown levels`).toBeUndefined();
              expect.soft(projection.thinkingOptions, `${mode} unknown options`).toBeUndefined();
            }
          }
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.thinkingLevel,
          ).toBe(fixture.thinkingLevel);
        }
        expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      } finally {
        slowCatalog.resolve(rawSnapshot);
      }
    } finally {
      preparedThinkingPolicy.fallback = "off";
      testState.agentConfig = undefined;
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("chat.startup and chat.history preserve reasoning-default projection per agent and session auth", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-gw-startup-routes-",
        agentEnv: "main",
        env: {
          CHATGPT_OAUTH_TOKEN: undefined,
          CODEX_API_KEY: undefined,
          CODEX_HOME: "/__openclaw_gateway_startup_routes__/codex",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENAI_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
          OPENAI_OAUTH_TOKEN: undefined,
        },
      },
      async (state) => {
        const previousAgentConfig = testState.agentConfig;
        const previousAgentsConfig = testState.agentsConfig;
        const { storePath } = openDirectChatSession({ fresh: true });
        try {
          const config = {
            agents: {
              ownership: "explicit" as const,
              defaults: {
                model: { primary: "openai/gpt-5.5" },
                models: { "openai/gpt-5.5": {} },
                heartbeat: { agentId: "main" },
                sessionStore: { agentId: "main" },
                systemAgent: { agentId: "main" },
              },
              entries: { main: {}, work: {} },
            },
            auth: {
              order: { openai: ["openai:api", "openai:chatgpt", "openai:expired"] },
            },
            talk: { agentId: "main" },
          };
          await state.writeConfig(config);
          setRuntimeConfigSnapshot({ ...config, session: { store: storePath } });
          const pluginMetadataSnapshot = createGatewayPluginMetadataSnapshot(config);
          assertPluginMetadataSnapshotConsistency(pluginMetadataSnapshot);
          await withPluginMetadataSnapshotScope(
            pluginMetadataSnapshot,
            async () => {
              const initialConfig = getRuntimeConfig();
              expect(initialConfig.auth?.order?.openai).toEqual([
                "openai:api",
                "openai:chatgpt",
                "openai:expired",
              ]);
              testState.agentsConfig = initialConfig.agents;
              testState.agentConfig = initialConfig.agents?.defaults;
              await writeSessionStore({
                entries: {
                  "agent:work:main": {
                    sessionId: "sess-work",
                    modelProvider: "openai",
                    model: "gpt-5.5",
                    authProfileOverride: "openai:chatgpt",
                    authProfileOverrideSource: "user",
                    updatedAt: Date.now(),
                  },
                  "agent:work:auto": {
                    sessionId: "sess-work-auto",
                    modelProvider: "openai",
                    model: "gpt-5.5",
                    authProfileOverride: "openai:expired",
                    authProfileOverrideSource: "auto",
                    updatedAt: Date.now(),
                  },
                  "agent:work:auto-preferred": {
                    sessionId: "sess-work-auto-preferred",
                    modelProvider: "openai",
                    model: "gpt-5.5",
                    authProfileOverride: "openai:chatgpt",
                    authProfileOverrideSource: "auto",
                    updatedAt: Date.now(),
                  },
                  "agent:work:legacy-auto": {
                    sessionId: "sess-work-legacy-auto",
                    modelProvider: "openai",
                    model: "gpt-5.5",
                    authProfileOverride: "openai:expired",
                    authProfileOverrideCompactionCount: 0,
                    updatedAt: Date.now(),
                  },
                },
              });
              const { loadGatewaySessionEntryReadOnly } = await import("./session-utils.js");
              setRuntimeConfigSnapshot(initialConfig);
              const loaded = loadGatewaySessionEntryReadOnly("agent:work:main");
              expect(loaded.cfg.agents?.defaults?.model).toEqual(config.agents.defaults.model);
              expect(loaded.cfg.agents?.entries).toEqual(config.agents.entries);
              expect(loaded.canonicalKey).toBe("agent:work:main");
              expect(loaded.entry).toMatchObject({
                sessionId: "sess-work",
                modelProvider: "openai",
                model: "gpt-5.5",
                authProfileOverride: "openai:chatgpt",
              });
              await state.writeAuthProfiles({
                version: 1,
                profiles: {
                  "openai:chatgpt": {
                    type: "oauth",
                    provider: "openai",
                    access: "chatgpt-access",
                    refresh: "chatgpt-refresh",
                    expires: Date.now() + 30 * 60_000,
                  },
                },
              });
              await state.writeAuthProfiles(
                {
                  version: 1,
                  profiles: {
                    "openai:api": {
                      type: "api_key",
                      provider: "openai",
                      key: "platform-api-key",
                    },
                    "openai:chatgpt": {
                      type: "oauth",
                      provider: "openai",
                      access: "work-chatgpt-access",
                      refresh: "work-chatgpt-refresh",
                      expires: Date.now() + 30 * 60_000,
                    },
                    "openai:expired": {
                      type: "oauth",
                      provider: "openai",
                      access: "expired-work-chatgpt-access",
                      expires: Date.now() - 60_000,
                    },
                  },
                },
                "work",
              );
              const platformRoute = {
                id: "gpt-5.5",
                name: "GPT-5.5",
                provider: "openai",
                api: "openai-responses" as const,
                baseUrl: "https://api.openai.com/v1",
                contextWindow: 1_000_000,
                reasoning: true,
                compat: { supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
              };
              const subscriptionRoute = {
                ...platformRoute,
                api: "openai-chatgpt-responses" as const,
                baseUrl: "https://chatgpt.com/backend-api/codex",
                contextWindow: 400_000,
                reasoning: false,
                compat: { supportedReasoningEfforts: ["low"] },
                params: { apiKey: "private-route-token" },
              };
              const catalogSnapshot = {
                entries: [subscriptionRoute],
                routeVariants: [subscriptionRoute, platformRoute],
              };
              const { loadAuthProfileStoreForRuntime } = await import("../agents/auth-profiles.js");
              const { resolveAgentDir } = await import("../agents/agent-scope.js");
              const preparedAuthStoreByAgentId = new Map([
                [
                  "main",
                  loadAuthProfileStoreForRuntime(resolveAgentDir(initialConfig, "main"), {
                    readOnly: true,
                  }),
                ],
                [
                  "work",
                  loadAuthProfileStoreForRuntime(resolveAgentDir(initialConfig, "work"), {
                    inheritedAuthDir: resolveAgentDir(initialConfig, "main"),
                    readOnly: true,
                  }),
                ],
              ]);
              const requirePreparedAuthStore = (agentId: string) => {
                const authStore = preparedAuthStoreByAgentId.get(agentId);
                if (!authStore) {
                  throw new Error(`expected prepared auth store for agent "${agentId}"`);
                }
                return authStore;
              };
              const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
              const models = await import("./server-methods/models-list-result.js");
              const projectionByKey = new Map<
                string,
                Promise<{
                  modelCatalog: ModelCatalogEntry[];
                  metadata: {
                    models: import("../../packages/gateway-protocol/src/index.js").ModelChoice[];
                    swarmEnabled: boolean;
                  };
                }>
              >();
              const projectAgent = (
                context: GatewayRequestContext,
                agentId: string,
                sessionEntry?: Parameters<
                  GatewayRequestContext["readChatMetadata"]
                >[0]["sessionEntry"],
              ) => {
                const profileId = sessionEntry?.authProfileOverride?.trim();
                const profileSource = sessionEntry?.authProfileOverrideSource;
                const legacyUserProfile =
                  profileSource === undefined &&
                  sessionEntry?.authProfileOverrideCompactionCount === undefined;
                const key = [
                  agentId,
                  profileId ?? "",
                  profileId && (profileSource === "user" || legacyUserProfile) ? profileId : "",
                ].join("\0");
                const existing = projectionByKey.get(key);
                if (existing) {
                  return existing;
                }
                const projector = createModelCatalogDecisions({
                  cfg: initialConfig,
                  agentId,
                  snapshot: catalogSnapshot,
                  metadataSnapshot: pluginMetadataSnapshot,
                  preparedAuthStore: requirePreparedAuthStore(agentId),
                  ...(profileId ? { preferredProfileId: profileId } : {}),
                  ...(profileId && (profileSource === "user" || legacyUserProfile)
                    ? { pinnedProfileId: profileId }
                    : {}),
                });
                const projection = Promise.all([
                  projector.projectCatalog(),
                  models.buildModelsListResult({
                    source: { kind: "gateway", context },
                    agentId,
                    params: { view: "configured" },
                    preloadedCatalog: {
                      agentId,
                      config: initialConfig,
                      snapshot: catalogSnapshot,
                    },
                    preloadedOnly: true,
                    catalogProjector: projector,
                  }),
                ]).then(([modelCatalog, metadata]) => ({
                  modelCatalog,
                  metadata: { ...metadata, swarmEnabled: false },
                }));
                projectionByKey.set(key, projection);
                return projection;
              };
              const context = createDirectChatContext({
                loadGatewayModelCatalogSnapshot: vi
                  .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
                  .mockResolvedValue({
                    agentId: "work",
                    agentDir: "/tmp/chat-work-agent",
                    catalogComplete: false,
                    workspaceDir: "/tmp/chat-work-workspace",
                    config: initialConfig,
                    ...catalogSnapshot,
                  }),
                getRuntimeConfig: () => initialConfig,
                readPreparedGatewayModelCatalog: async () => catalogSnapshot,
                readChatStartupProjection: vi.fn(async ({ agentId, sessionEntry }) => {
                  const [neutralProjection, sessionProjection] = await Promise.all([
                    projectAgent(context, agentId),
                    projectAgent(context, agentId, sessionEntry),
                  ]);
                  preparedThinkingPolicy.fallback = sessionProjection.modelCatalog.some(
                    (entry) => entry.reasoning === true,
                  )
                    ? "base"
                    : "off";
                  return {
                    metadata: sessionProjection.metadata,
                    sessionModelCatalog: sessionProjection.modelCatalog,
                    defaultModelCatalog: neutralProjection.modelCatalog,
                  };
                }),
              });
              const expiredPreferenceEvaluation = createModelCatalogDecisions({
                cfg: initialConfig,
                agentId: "work",
                snapshot: catalogSnapshot,
                metadataSnapshot: pluginMetadataSnapshot,
                preparedAuthStore: requirePreparedAuthStore("work"),
                preferredProfileId: "openai:expired",
              }).evaluateEntry(subscriptionRoute, catalogSnapshot.routeVariants);
              expect(expiredPreferenceEvaluation).toMatchObject({
                availability: true,
                selectedProfileId: "openai:api",
                selectedRoute: { authRequirement: "api-key" },
              });
              // Main only has subscription auth; work's neutral default selects API auth.
              // Keep the Off-only default control separate from work's locked session profile.
              await callDirectChat("chat.startup", {
                id: "startup-main-neutral-route",
                params: { sessionKey: "agent:main:main" },
                respond: captureChatResponse(responses),
                context,
              });
              expect(responses).toHaveLength(1);
              expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
              const mainPayload = responses[0]?.payload as {
                defaults?: GatewaySessionsDefaults;
                sessionInfo?: { thinkingLevels?: Array<{ id: string }> };
              };
              expect(mainPayload.defaults).toMatchObject({
                modelProvider: "openai",
                model: "gpt-5.5",
              });
              expect(mainPayload.defaults?.thinkingLevels?.map((level) => level.id)).toEqual([
                "off",
              ]);
              expect(mainPayload.sessionInfo?.thinkingLevels?.map((level) => level.id)).toEqual([
                "off",
              ]);
              responses.length = 0;
              await callDirectChat("chat.startup", {
                id: "startup-dual-route-catalog",
                params: { sessionKey: "agent:work:main" },
                respond: captureChatResponse(responses),
                context,
              });

              expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
              expect(responses).toHaveLength(1);
              expect(responses[0]?.ok).toBe(true);
              const payload = responses[0]?.payload as
                | {
                    metadata?: { models?: unknown[] };
                    sessionInfo?: { thinkingLevels?: Array<{ id?: string }> };
                    defaults?: { thinkingLevels?: Array<{ id?: string }> };
                  }
                | undefined;
              expect(payload?.metadata?.models).toEqual([
                expect.objectContaining({
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  provider: "openai",
                  agentRuntime: {
                    id: "codex",
                    cloudPlacementSupported: false,
                    devicePlacementSupported: false,
                    source: "implicit",
                  },
                  contextWindow: 400_000,
                  reasoning: false,
                  available: true,
                }),
              ]);
              expect(payload?.sessionInfo?.thinkingLevels?.map((level) => level.id)).toEqual([
                "off",
              ]);
              expect(payload?.defaults?.thinkingLevels?.map((level) => level.id)).toEqual([
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "ultra",
              ]);
              const serialized = JSON.stringify(responses[0]?.payload);
              expect(serialized).not.toContain("private-route-token");
              expect(serialized).not.toContain("platform-api-key");
              expect(serialized).not.toContain("chatgpt-access");
              expect(serialized).not.toContain("supportedReasoningEfforts");
              expect(serialized).not.toContain(platformRoute.baseUrl);
              expect(serialized).not.toContain(subscriptionRoute.baseUrl);

              for (const [index, [sessionKey, sessionId, expectedRoute]] of [
                ["agent:work:auto-preferred", "sess-work-auto-preferred", "subscription"],
                ["agent:work:auto", "sess-work-auto", "platform"],
                ["agent:work:legacy-auto", "sess-work-legacy-auto", "platform"],
              ].entries()) {
                await writeMainSessionTranscript(
                  [
                    createTextTranscriptEvent("user", "route reasoning", {
                      id: "route-message",
                      parentId: null,
                    }),
                  ],
                  sessionId,
                  { agentId: "work", sessionKey },
                );
                responses.length = 0;
                await callDirectChat("chat.startup", {
                  id: `startup-preferred-route-${index}`,
                  params: { sessionKey },
                  respond: ((ok, responsePayload, error) => {
                    responses.push({ ok, payload: responsePayload, error });
                  }) as RespondFn,
                  context,
                });

                expect(responses).toHaveLength(1);
                expect(responses[0]?.ok).toBe(true);
                const preferredPayload = responses[0]?.payload as
                  | {
                      metadata?: { models?: Array<{ contextWindow?: number }> };
                      defaults?: GatewaySessionsDefaults;
                      sessionInfo?: {
                        agentRuntime?: unknown;
                        thinkingLevel?: string;
                        thinkingDefault?: string;
                        thinkingLevels?: Array<{ id?: string }>;
                        thinkingOptions?: string[];
                      };
                    }
                  | undefined;
                expect(preferredPayload?.metadata?.models?.[0]?.contextWindow, sessionKey).toBe(
                  expectedRoute === "subscription" ? 400_000 : 1_000_000,
                );
                const thinkingLevels = preferredPayload?.sessionInfo?.thinkingLevels?.map(
                  (level) => level.id,
                );
                if (expectedRoute === "subscription") {
                  expect(thinkingLevels, sessionKey).toEqual(["off"]);
                } else {
                  expect(thinkingLevels, sessionKey).toContain("high");
                }
                expect(preferredPayload?.sessionInfo?.thinkingLevel ?? null).toBeNull();
                let cursor: string | undefined;
                for (const mode of ["page", "delta"] as const) {
                  responses.length = 0;
                  await callDirectChat("chat.history", {
                    id: `history-preferred-route-${index}-${mode}`,
                    params: { sessionKey, ...(mode === "delta" ? { cursor } : {}) },
                    respond: captureChatResponse(responses),
                    context,
                  });
                  expect(responses).toHaveLength(1);
                  expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
                  const history = responses[0]?.payload as {
                    kind?: string;
                    deltaCursor?: string;
                    thinkingLevel?: string;
                    defaults?: GatewaySessionsDefaults;
                    sessionInfo?: NonNullable<typeof preferredPayload>["sessionInfo"];
                  };
                  const label = `${sessionKey} ${mode}`;
                  if (mode === "delta") {
                    expect(history.kind, label).toBe("delta");
                  } else {
                    expect(history.deltaCursor, label).toEqual(expect.any(String));
                    cursor = history.deltaCursor;
                    expect(history.defaults, `${label} neutral defaults`).toEqual(
                      preferredPayload?.defaults,
                    );
                    expect
                      .soft(history.thinkingLevel, `${label} effective thinking`)
                      .toBe(preferredPayload?.sessionInfo?.thinkingDefault);
                  }
                  expect(
                    history.sessionInfo?.thinkingLevel ?? null,
                    `${label} override`,
                  ).toBeNull();
                  expect(history.sessionInfo?.agentRuntime, `${label} runtime`).toEqual(
                    preferredPayload?.sessionInfo?.agentRuntime,
                  );
                  expect
                    .soft(history.sessionInfo?.thinkingDefault, `${label} default`)
                    .toBe(preferredPayload?.sessionInfo?.thinkingDefault);
                  expect
                    .soft(history.sessionInfo?.thinkingLevels, `${label} supported levels`)
                    .toEqual(preferredPayload?.sessionInfo?.thinkingLevels);
                  expect
                    .soft(history.sessionInfo?.thinkingOptions, `${label} supported options`)
                    .toEqual(preferredPayload?.sessionInfo?.thinkingOptions);
                }
              }
            },
            { config, compatibleConfigs: [config], env: process.env },
          );
        } finally {
          preparedThinkingPolicy.fallback = "off";
          testState.agentConfig = previousAgentConfig;
          testState.agentsConfig = previousAgentsConfig;
          testState.sessionStorePath = undefined;
        }
      },
    );
  });
  test.each(["chat.startup"] as const)(
    "%s scopes metadata to agent session keys without explicit agentId",
    async (method) => {
      openDirectChatSession({ fresh: true });
      try {
        const fileConfig = {
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "main" },
              model: {
                primary: "openai/gpt-main",
              },
              models: {
                "openai/gpt-main": {},
              },
            },
            entries: {
              main: {},
              work: {
                model: {
                  primary: "minimax/MiniMax-M2.7-highspeed",
                },
                models: {
                  "minimax/MiniMax-M2.7-highspeed": {},
                },
              },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://openai.example.com/v1",
                models: [{ id: "gpt-main", name: "GPT Main" }],
              },
              minimax: {
                baseUrl: "https://minimax.example.com/v1",
                models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
              },
            },
          },
        } as unknown as OpenClawConfig;
        await writeGatewayConfig(fileConfig);
        await writeSessionStore({
          entries: {
            "agent:work:main": {
              sessionId: "sess-work",
              updatedAt: Date.now(),
            },
          },
        });
        const config = getRuntimeConfig();
        const responses: CapturedChatResponse[] = [];
        const metadata = {
          models: [
            {
              id: "MiniMax-M2.7-highspeed",
              name: "MiniMax M2.7 Highspeed",
              provider: "minimax",
            },
          ],
          swarmEnabled: false,
        };
        const readChatStartupProjection = vi.fn(async () => ({
          metadata,
          sessionModelCatalog: metadata.models,
          defaultModelCatalog: metadata.models,
        }));
        const context = createDirectChatContext({
          loadGatewayModelCatalogSnapshot: vi
            .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
            .mockImplementation(async () => {
              await Promise.resolve();
              await Promise.resolve();
              const entries = [
                {
                  id: "gpt-main",
                  name: "GPT Main",
                  provider: "openai",
                },
                {
                  id: "MiniMax-M2.7-highspeed",
                  name: "MiniMax M2.7 Highspeed",
                  provider: "minimax",
                },
              ];
              return {
                agentId: "work",
                agentDir: "/tmp/chat-work-agent",
                catalogComplete: false,
                workspaceDir: "/tmp/chat-work-workspace",
                config,
                entries,
                routeVariants: entries,
              };
            }),
          getRuntimeConfig: () => config,
          readChatStartupProjection,
        });
        await callDirectChat(method, {
          id: "startup-agent-scoped-metadata",
          params: { sessionKey: "agent:work:main" },
          respond: captureChatResponse(responses),
          context,
        });

        expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        expect(readChatStartupProjection).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "work",
            sessionEntry: expect.objectContaining({ sessionId: "sess-work" }),
          }),
        );
        expect(context.readChatMetadata).not.toHaveBeenCalled();
        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok).toBe(true);
        const payload = responses[0]?.payload as
          | {
              metadata?: {
                models?: Array<{ id?: string; provider?: string }>;
              };
              sessionInfo?: { key?: string; sessionId?: string };
              defaults?: { modelProvider?: string; model?: string };
            }
          | undefined;
        expect(payload?.sessionInfo).toMatchObject({
          key: "agent:work:main",
          sessionId: "sess-work",
        });
        expect(payload?.defaults).toMatchObject({
          model: "MiniMax-M2.7-highspeed",
          modelProvider: "minimax",
        });
        if (method === "chat.startup") {
          expect(payload?.metadata?.models).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "MiniMax-M2.7-highspeed",
                provider: "minimax",
              }),
            ]),
          );
        } else {
          expect(payload).not.toHaveProperty("metadata");
        }
      } finally {
        testState.sessionStorePath = undefined;
      }
    },
  );

  test("chat.metadata coalesces configured models and text commands", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await writeGatewayConfig({
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "main" },
            model: {
              primary: "openai/gpt-main",
              fallbacks: ["openai/gpt-fallback"],
            },
            models: {
              "openai/gpt-main": {},
            },
          },
          entries: {
            main: {},
            work: {
              model: {
                primary: "minimax/MiniMax-M2.7-highspeed",
              },
              tools: { swarm: { enabled: true } },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [
                { id: "gpt-main", name: "GPT Main" },
                { id: "gpt-fallback", name: "GPT Fallback" },
              ],
            },
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      });
      await connectOk(ws, { prePairDevice: true });

      const metadata = await rpcReq<{
        commands?: Array<{ name?: string; textAliases?: string[] }>;
        models?: Array<{ id?: string; provider?: string }>;
        swarmEnabled?: boolean;
      }>(ws, "chat.metadata", { agentId: "work" });

      expect(metadata.ok).toBe(true);
      expect(metadata.payload?.swarmEnabled).toBe(true);
      expect(metadata.payload?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "MiniMax-M2.7-highspeed",
            provider: "minimax",
          }),
        ]),
      );
      expect(metadata.payload?.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "model",
            textAliases: expect.arrayContaining(["/model"]),
          }),
        ]),
      );
    });
  });

  test("chat.send returns in_flight when duplicate attachment send wins parsing race", async () => {
    openDirectChatSession();
    const dispatchRelease = createDeferred();
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });

      const firstCatalogSnapshot =
        createDeferred<
          Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>
        >();
      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        loadGatewayModelCatalogSnapshot: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
          .mockImplementationOnce(() => firstCatalogSnapshot.promise)
          .mockResolvedValue(createChatVisionModelCatalogSnapshot()),
      });
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      const params = makeChatSendParams({
        message: "see image",
        idempotencyKey: "idem-attachment-race",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: pngB64,
          },
        ],
      });
      const callSend = (id: string) =>
        callDirectChat("chat.send", {
          id,
          params,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      const first = Promise.resolve(callSend("first"));
      await waitForFast(() => {
        expect(context.loadGatewayModelCatalogSnapshot).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("duplicate");
      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
      ]);

      firstCatalogSnapshot.resolve(createChatVisionModelCatalogSnapshot());
      await first;

      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
        {
          id: "first",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "started" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.addChatRun).toHaveBeenCalledTimes(1);
      dispatchRelease.resolve();
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      dispatchRelease.resolve();
      await resetDirectChatSession();
    }
  });

  test("chat.send discards prepared inbound media when a hook blocks the turn", async () => {
    openDirectChatSession();
    const attachments = await import("./chat-attachments.js");
    const discard = attachments.discardPreparedInboundMedia;
    const discarded = createDeferred();
    const cleanup = vi
      .spyOn(attachments, "discardPreparedInboundMedia")
      .mockImplementation((...args) => {
        const pending = discard(...args);
        if (args[0].length > 0) {
          discarded.resolve(pending);
        }
        return pending;
      });
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });
      const context = createDirectChatContext();
      const inboundDir = path.join(getMediaDir(), "inbound");
      const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
      // A before_agent_run block persists only the redacted reason — no media
      // markers — so dispatch must discard the prepared refs on settle.
      dispatchInboundMessageMock.mockImplementationOnce(async (params: unknown) => {
        const replyOptions = (params as { replyOptions?: GetReplyOptions }).replyOptions;
        replyOptions?.userTurnTranscriptRecorder?.markBlocked();
      });
      const responses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "blocked-turn-media",
        params: makeChatSendParams({
          message: "blocked turn with media",
          idempotencyKey: "idem-blocked-turn-media",
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "notes.txt",
              content: Buffer.from("offloaded inbound media").toString("base64"),
            },
          ],
        }),
        client: {
          connId: "conn-owner",
          connect: {
            ...makeGatewayWebchatClient(),
            device: { id: "dev-owner" },
            scopes: ["operator.write"],
          },
        } as never,
        respond: captureChatResponse(responses),
        context,
      });
      expect(responses[0]?.ok, JSON.stringify(responses[0])).toBe(true);
      await discarded.promise;
      const remaining = await fs.readdir(inboundDir).catch(() => []);
      expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([]);
    } finally {
      cleanup.mockRestore();
      await resetDirectChatSession();
    }
  });

  test("chat.send retains durably admitted media when later setup throws before the ACK", async () => {
    await withDirectChatSession(async (_sessionDir, storePath) => {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });
      const context = createDirectChatContext({
        // addChatRun runs after durable input admission but before the ACK.
        addChatRun: vi.fn(() => {
          throw new Error("setup exploded before ack");
        }),
      });
      const inboundDir = path.join(getMediaDir(), "inbound");
      const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
      const responses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "setup-error-media",
        params: makeChatSendParams({
          message: "setup error with media",
          idempotencyKey: "idem-setup-error-media",
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "notes.txt",
              content: Buffer.from("offloaded inbound media").toString("base64"),
            },
          ],
        }),
        client: {
          connId: "conn-owner",
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              version: "1.0.0",
              platform: "node",
            },
            device: { id: "dev-owner" },
            scopes: ["operator.write"],
          },
        } as never,
        respond: captureChatResponse(responses),
        context,
      });
      expect(responses).toEqual([
        {
          ok: false,
          payload: expect.objectContaining({ status: "error" }),
          error: expect.anything(),
        },
      ]);
      await getDirectChatSessionWorkRelease();
      const pending = await listSessionPendingInputs({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        storePath,
      });
      expect(pending).toMatchObject({
        total: 1,
        items: [{ state: "interrupted", runId: "idem-setup-error-media" }],
      });
      const media = readPersistedMediaFacts(
        expectDefined(pending.items[0]?.message, "Expected the retained pending input"),
      );
      expect(media).toHaveLength(1);
      const retainedUrl = expectDefined(media?.[0]?.url, "Expected the pending attachment URL");
      expect(retainedUrl).toMatch(/^media:\/\/inbound\//);
      const retainedPath = await resolveMediaReferenceLocalPath(retainedUrl);
      await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("offloaded inbound media");
      const remaining = await fs.readdir(inboundDir);
      expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([
        path.basename(retainedPath),
      ]);
    });
  });

  test("chat.abort cancels chat.send while lifecycle admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    try {
      await writeStoredMainSession({});
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: CapturedChatResponse[] = [];
      const abortResponses: CapturedChatResponse[] = [];
      const context = createDirectChatContext();
      const runId = "idem-lifecycle-wait-abort";
      const collidingFinalKey = `chat:pending:${runId}`;
      const collidingFinalEntry = {
        ts: Date.now(),
        ok: true,
        payload: { runId: `pending:${runId}`, status: "ok" },
      };
      context.dedupe.set(collidingFinalKey, collidingFinalEntry);
      const params = makeChatSendParams({
        message: "do not dispatch",
        idempotencyKey: runId,
      });
      const client = {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes: ["operator.write"],
        },
      } as never;
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          client,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);
      expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
      expect(context.chatAbortControllers.has(runId)).toBe(false);

      const retryResponses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "retry",
        params,
        client,
        respond: captureChatResponse(retryResponses),
        context,
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: { runId, status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);

      await callDirectChat("chat.abort", {
        id: "abort",
        params: makeMainSessionParams({ runId }),
        client,
        respond: captureChatResponse(abortResponses),
        context,
      });
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: [runId] },
          error: undefined,
        },
      ]);
      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await resetDirectChatSession();
    }
  });

  test("chat.send rejects stale lifecycle work after admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    try {
      await writeStoredMainSession({});
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: CapturedChatResponse[] = [];
      const context = createDirectChatContext();
      const runId = "idem-stale-lifecycle";
      const params = makeChatSendParams({
        message: "do not resume after restart",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      rotateAgentEventLifecycleGeneration();
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "restart",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await resetDirectChatSession();
    }
  });

  test("chat.send does not recreate a session deleted while admission waits", async () => {
    openDirectChatSession({ fresh: true });
    const performDeletion = createDeferred();
    let mutation: Promise<void> | undefined;
    try {
      await writeStoredMainSession({});
      const [{ deleteSessionEntryLifecycle }, { loadSessionEntry: loadGatewaySessionEntry }] =
        await Promise.all([
          import("../config/sessions/session-accessor.js"),
          import("./session-utils.js"),
        ]);
      const seededSession = loadGatewaySessionEntry("main");
      const seededSessionId = seededSession.entry?.sessionId;
      expect(seededSessionId).toBe("sess-main");
      const mutationStarted = createDeferred();
      mutation = runExclusiveSessionLifecycleMutation("delete", {
        scope: seededSession.storePath,
        identities: [seededSession.canonicalKey, seededSessionId],
        run: async () => {
          mutationStarted.resolve();
          await performDeletion.promise;
          // Read the authoritative row inside the mutation. Admission startup
          // may refresh metadata before it blocks, but this test deletes that
          // same session generation rather than a stale pre-admission snapshot.
          const deletionSession = loadGatewaySessionEntry("main");
          const deletionEntry = expectDefined(
            deletionSession.entry,
            "session deletion test invariant",
          );
          expect(deletionEntry.sessionId).toBe(seededSessionId);
          const deletion = await deleteSessionEntryLifecycle({
            agentId: "main",
            archiveTranscript: false,
            expectedEntry: deletionEntry,
            expectedSessionId: seededSessionId,
            requireWriteSuccess: true,
            storePath: deletionSession.storePath,
            target: {
              canonicalKey: deletionSession.canonicalKey,
              storeKeys: deletionSession.storeKeys,
            },
          });
          expect(deletion.deleted).toBe(true);
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{
        ok: boolean;
        payload?: unknown;
        error?: unknown;
        meta?: unknown;
      }> = [];
      const context = createDirectChatContext();
      const runId = "idem-deleted-during-admission";
      const params = makeChatSendParams({
        message: "do not recreate the deleted session",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: ((ok, payload, error, meta) => {
            sendResponses.push({ ok, payload, error, meta });
          }) as RespondFn,
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      performDeletion.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: false,
          payload: undefined,
          error: expect.objectContaining({
            message: expect.stringMatching(/deleted while starting work/i),
          }),
          meta: undefined,
        },
      ]);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      performDeletion.resolve();
      await Promise.allSettled(mutation ? [mutation] : []);
      await resetDirectChatSession();
    }
  });

  test("chat.send does not enter a replacement session after reset while admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    try {
      await writeStoredMainSession({
        sessionId: "sess-before-reset",
      });
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("reset", {
        scope: storePath,
        identities: ["agent:main:main", "sess-before-reset"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: CapturedChatResponse[] = [];
      const context = createDirectChatContext();
      const runId = "idem-reset-during-admission";
      const params = makeChatSendParams({
        message: "do not enter the replacement session",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      await writeStoredMainSession({
        sessionId: "sess-after-reset",
      });
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toHaveLength(1);
      expect(sendResponses[0]?.ok).toBe(false);
      expect(sendResponses[0]?.error).toMatchObject({
        message: expect.stringMatching(/changed while starting work/i),
      });
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await resetDirectChatSession();
    }
  });

  test("chat.send does not consume a replacement pending reservation", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    const releaseTerminalMutation = createDeferred();
    try {
      await writeStoredMainSession({});
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: CapturedChatResponse[] = [];
      const context = createDirectChatContext();
      const runId = "idem-replaced-reservation";
      const pendingKey = pendingChatSendDedupeKey(runId);
      const params = makeChatSendParams({
        message: "only the replacement may run",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingKey)).toBe(true);
      }, FAST_WAIT_OPTS);
      const original = context.dedupe.get(pendingKey);
      const originalPayload = original?.payload as Record<string, unknown>;
      const replacement = {
        ts: Date.now(),
        ok: true,
        payload: {
          ...originalPayload,
          attemptId: "replacement-attempt",
          expiresAtMs: Date.now() + 120_000,
        },
      };
      context.dedupe.set(pendingKey, replacement);

      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: { runId, status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(context.dedupe.get(pendingKey)).toBe(replacement);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      const terminalMutationStarted = createDeferred();
      const terminalMutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          terminalMutationStarted.resolve();
          await releaseTerminalMutation.promise;
        },
      });
      await terminalMutationStarted.promise;
      const terminalRunId = "idem-terminal-replacement";
      const terminalPendingKey = pendingChatSendDedupeKey(terminalRunId);
      const terminalParams = makeChatSendParams({
        message: "preserve the replacement result",
        idempotencyKey: terminalRunId,
      });
      const terminalResponses: CapturedChatResponse[] = [];
      const terminalSend = Promise.resolve(
        callDirectChat("chat.send", {
          id: "terminal-send",
          params: terminalParams,
          respond: captureChatResponse(terminalResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(terminalPendingKey)).toBe(true);
      }, FAST_WAIT_OPTS);
      const terminalResult = {
        ts: Date.now(),
        ok: true,
        payload: { runId: terminalRunId, status: "ok", summary: "replacement completed" },
      };
      context.dedupe.delete(terminalPendingKey);
      context.dedupe.set(`chat:${terminalRunId}`, terminalResult);

      releaseTerminalMutation.resolve();
      await terminalMutation;
      await terminalSend;

      expect(terminalResponses).toEqual([
        { ok: true, payload: terminalResult.payload, error: undefined },
      ]);
      expect(context.dedupe.get(`chat:${terminalRunId}`)).toBe(terminalResult);
      expect(context.chatRunState.runs.get(terminalRunId)?.abortMarker).toBeUndefined();
    } finally {
      releaseMutation.resolve();
      releaseTerminalMutation.resolve();
      await resetDirectChatSession();
    }
  });

  test("chat.send exposes inline image uploads as managed media without duplicating vision input", async () => {
    openDirectChatSession();
    try {
      testState.agentConfig = { model: { primary: "test-provider/vision-model" } };
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });

      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalogSnapshot: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
          .mockResolvedValue(createChatVisionModelCatalogSnapshot()),
      });
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      let captured: { ctx?: Record<string, unknown>; replyOptions?: GetReplyOptions } | undefined;
      dispatchInboundMessageMock.mockImplementation(async (...args: unknown[]) => {
        const [params] = args as [
          {
            ctx: Record<string, unknown>;
            replyOptions?: GetReplyOptions;
          },
        ];
        if (params.replyOptions?.runId === "idem-inline-image-managed-media") {
          captured = {
            ctx: params.ctx,
            replyOptions: params.replyOptions,
          };
        }
      });

      const responses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "inline-image-managed-media",
        params: makeChatSendParams({
          message: "inspect the uploaded file",
          idempotencyKey: "idem-inline-image-managed-media",
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              fileName: "dot.png",
              content: pngB64,
            },
          ],
        }),
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses[0]?.ok).toBe(true);
      await waitForFast(() => expect(captured).toBeDefined(), FAST_WAIT_OPTS);
      expect(captured?.replyOptions?.images).toEqual([
        { type: "image", data: pngB64, mimeType: "image/png", sourceIndex: 0, fileName: "dot.png" },
      ]);
      expect(captured?.ctx?.media).toEqual([
        expect.objectContaining({
          path: expect.any(String),
          contentType: "image/png",
          hydrationSuppressed: true,
        }),
      ]);
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test.each(configuredImageModelCases)(
    "chat.send preserves text-only image uploads as MediaPaths even with configured imageModel: $id",
    async ({ id, imageModel }) => {
      openDirectChatSession();
      try {
        testState.agentConfig = {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-haiku-4-6"],
          },
          imageModel,
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        };
        await writeStoredMainSession({
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
        });

        const context = createDirectChatContext({
          getRuntimeConfig,
          loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
            async () => [
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                input: ["text"],
              },
              {
                id: "gpt-4o",
                name: "GPT-4o",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "gpt-4o-mini",
                name: "GPT-4o mini",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "claude-haiku-4-6",
                name: "Claude Haiku 4.6",
                provider: "anthropic",
                input: ["text"],
              },
            ],
          ),
        });
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
        let captured: { ctx?: Record<string, unknown>; replyOptions?: GetReplyOptions } | undefined;
        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [params] = args as [
            {
              ctx: Record<string, unknown>;
              replyOptions?: GetReplyOptions;
            },
          ];
          captured = {
            ctx: params.ctx,
            replyOptions: params.replyOptions,
          };
        });

        const responses: CapturedChatResponse[] = [];
        await callDirectChat("chat.send", {
          id: `configured-image-model-${id}`,
          params: makeChatSendParams({
            message: "see image",
            idempotencyKey: `idem-configured-image-model-${id}`,
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: pngB64,
              },
            ],
          }),
          respond: captureChatResponse(responses),
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        await waitForFast(() => expect(captured).toBeDefined(), FAST_WAIT_OPTS);
        expect(captured?.replyOptions?.images).toBeUndefined();
        expect(captured?.ctx?.media).toEqual([
          expect.objectContaining({
            path: expect.any(String),
            contentType: "image/png",
            workspaceDir: expect.any(String),
          }),
        ]);
        await getDirectChatSessionWorkRelease();
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      } finally {
        dispatchInboundMessageMock.mockReset();
        testState.agentConfig = undefined;
        testState.sessionStorePath = undefined;
      }
    },
  );

  registerChatConnectionIdentityTest({
    withDirectChatSession,
    prepareSession: () => writeStoredMainSession(makeDoneSessionEntry()),
    waitForSessionWork: getDirectChatSessionWorkRelease,
    sendControlUiChat,
    readTranscript: () =>
      loadTranscriptEventsSync(makeMainSessionScope(testState.sessionStorePath)),
  });

  test("chat.send preserves a terminal source claim before admitting the next turn", async () => {
    const { storePath } = openDirectChatSession();
    const dispatchRelease = createDeferred();
    const priorRunId = "idem-prior-terminal-claim";
    const nextRunId = "idem-after-terminal-claim";
    const removal = createDeferred();
    try {
      await writeStoredMainSession(
        makeDoneSessionEntry({
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: priorRunId,
          restartRecoveryDeliverySourceRunId: priorRunId,
          restartRecoveryTerminalRunIds: ["idem-older-terminal-claim"],
        }),
      );
      const context = createDirectChatContext({
        removeChatRun: vi.fn((runId) => {
          if (runId === nextRunId) {
            removal.resolve(undefined);
          }
          return undefined;
        }),
      });
      dispatchInboundMessageMock.mockImplementationOnce(async () => dispatchRelease.promise);
      let snapshotAtAck: ReturnType<typeof loadSessionEntry>;
      const freshAdmission = vi.fn(async () => {
        expect(context.chatAbortControllers.get(nextRunId)?.controlUiVisible).not.toBe(false);
        return true;
      });

      await sendControlUiChat({
        context,
        idempotencyKey: nextRunId,
        message: "admit after terminal claim",
        onAdmissionOwned: freshAdmission,
        respond: ((ok, payload) => {
          if (ok && (payload as { status?: unknown } | undefined)?.status === "started") {
            snapshotAtAck = loadSessionEntry(makeMainSessionScope(storePath));
          }
        }) as RespondFn,
      });

      expect(freshAdmission).toHaveBeenCalledTimes(1);
      expect(context.chatAbortControllers.get(nextRunId)?.controlUiVisible).toBeUndefined();
      expect(snapshotAtAck).toMatchObject({
        restartRecoveryDeliveryRunId: nextRunId,
        restartRecoveryDeliverySourceRunId: nextRunId,
        restartRecoveryTerminalRunIds: ["idem-older-terminal-claim", priorRunId],
        lifecycleRunId: nextRunId,
      });
      expect(snapshotAtAck?.status).toBeUndefined();

      const retryResponses: Array<{ ok: boolean; payload?: unknown; meta?: unknown }> = [];
      const replayAdmission = vi.fn(async () => true);
      await sendControlUiChat({
        context,
        idempotencyKey: priorRunId,
        message: "must not execute again",
        onAdmissionOwned: replayAdmission,
        respond: ((ok, payload, _error, meta) =>
          retryResponses.push({ ok, payload, meta })) as RespondFn,
      });
      expect(replayAdmission).not.toHaveBeenCalled();
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: { runId: priorRunId, status: "ok" },
          meta: { cached: true, runId: priorRunId },
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      dispatchRelease.resolve(undefined);
      await removal.promise;
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      dispatchRelease.resolve(undefined);
      await resetDirectChatSession();
    }
  });

  test("chat.send runs an admission-owned callback for only one concurrent retry", async () => {
    openDirectChatSession();
    const dispatchRelease = createDeferred();
    const runId = "idem-concurrent-admission-owner";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockImplementationOnce(async () => dispatchRelease.promise);
      const firstAdmission = vi.fn(async () => true);
      const secondAdmission = vi.fn(async () => true);
      const responses: Array<{ ok: boolean; payload?: unknown; meta?: unknown }> = [];
      const send = (onAdmissionOwned: () => Promise<boolean>) =>
        sendControlUiChat({
          context,
          idempotencyKey: runId,
          message: "admit exactly once",
          onAdmissionOwned,
          respond: ((ok, payload, _error, meta) =>
            responses.push({ ok, payload, meta })) as RespondFn,
        });

      await Promise.all([send(firstAdmission), send(secondAdmission)]);

      expect(firstAdmission.mock.calls.length + secondAdmission.mock.calls.length).toBe(1);
      expect(responses).toHaveLength(2);
      expect(responses.every((response) => response.ok)).toBe(true);
      expect(
        responses.filter(
          (response) =>
            (response.payload as { status?: unknown } | undefined)?.status === "started",
        ),
      ).toHaveLength(1);

      dispatchRelease.resolve(undefined);
      await getDirectChatSessionWorkRelease();
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      dispatchRelease.resolve(undefined);
      await resetDirectChatSession();
    }
  });

  test("chat.abort still sees a replacement while its admission callback is running", async () => {
    openDirectChatSession();
    const callbackEntered = createDeferred();
    const releaseCallback = createDeferred();
    const runId = "idem-visible-during-admission-callback";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext({ chatQueuedTurns: new Map() });
      const sendResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      const sendPromise = sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "remain publicly abortable",
        onAdmissionOwned: async () => {
          callbackEntered.resolve(undefined);
          await releaseCallback.promise;
          return true;
        },
        respond: captureChatResult(sendResponses),
      });
      await callbackEntered.promise;
      expect(context.chatAbortControllers.get(runId)?.controlUiVisible).not.toBe(false);

      const abortResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      await callDirectChat("chat.abort", {
        id: "abort-visible-replacement",
        params: makeMainSessionParams(),
        client: createControlUiClient(),
        isWebchatConnect: () => true,
        respond: captureChatResult(abortResponses),
        context,
      });

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: [runId] },
        },
      ]);
      releaseCallback.resolve(undefined);
      await sendPromise;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          }),
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseCallback.resolve(undefined);
      await resetDirectChatSession();
    }
  });

  test.each([
    { caseName: "tombstones an explicit abort", retryable: false, stopReason: "rpc" },
    { caseName: "retains a restart interruption", retryable: true, stopReason: "restart" },
  ])("chat.send $caseName after SQLite admission commits", async ({ retryable, stopReason }) => {
    const { storePath } = openDirectChatSession();
    const runId = `idem-restart-safe-abort-${stopReason}`;
    let stopListening: (() => void) | undefined;
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const scope = makeMainSessionScope(storePath);
      const context = createDirectChatContext();
      const abortCommittedTurn = vi.fn(() => {
        const activeRun = expectDefined(
          context.chatAbortControllers.get(runId),
          "expected admitted chat run",
        );
        activeRun.abortStopReason = stopReason;
        activeRun.controller.abort();
      });
      // The transcript notification follows the atomic user-turn and recovery-claim commit.
      stopListening = onSessionTranscriptUpdate((update) => {
        if (
          update.target.sessionKey === scope.sessionKey &&
          update.target.sessionId === scope.sessionId &&
          isRecord(update.message) &&
          update.message.role === "user" &&
          update.message.idempotencyKey === `${runId}:user`
        ) {
          abortCommittedTurn();
        }
      });
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "persist, then stop",
        respond: captureChatResult(responses),
      });
      stopListening();
      expect(abortCommittedTurn).toHaveBeenCalledOnce();
      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason,
          }),
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const stored = loadSessionEntry(scope);
      expect(stored).toMatchObject({
        abortedLastRun: !retryable,
        lastRunId: runId,
        sessionId: "sess-main",
        status: "killed",
      });
      expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
      if (retryable) {
        expect(stored?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
        expect(stored?.restartRecoveryDeliveryRequestFingerprint).toEqual(
          expect.stringMatching(/^hmac-sha256:v1:/u),
        );
        expect(stored?.restartRecoveryDeliveryRunId).toBe(runId);
        expect(stored?.restartRecoveryDeliverySourceRunId).toBe(runId);
        expect(stored?.restartRecoverySourceIngress).toBe("control-ui");
        expect(stored?.restartRecoveryTerminalRunIds).toBeUndefined();
      } else {
        expect(stored?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
        expect(stored?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
        expect(stored?.restartRecoverySourceIngress).toBeUndefined();
        expect(stored?.restartRecoveryTerminalRunIds).toEqual([runId]);
      }
      expect(loadTranscriptEventsSync(scope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              content: "persist, then stop",
              idempotencyKey: `${runId}:user`,
              role: "user",
            }),
          }),
        ]),
      );

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      if (retryable) {
        dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      }
      await sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "persist, then stop",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: retryable
            ? expect.objectContaining({ runId, status: "started" })
            : { runId, status: "ok" },
        },
      ]);
      if (retryable) {
        await getDirectChatSessionWorkRelease();
        expect(retryContext.removeChatRun).toHaveBeenCalledTimes(1);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
        const retryOptions = (
          dispatchInboundMessageMock.mock.calls[0]?.[0] as
            | { replyOptions?: GetReplyOptions }
            | undefined
        )?.replyOptions;
        expect(retryOptions?.suppressNextUserMessagePersistence).toBe(true);
      } else {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
      expect(
        loadTranscriptEventsSync(scope).filter((event) => {
          if (
            typeof event !== "object" ||
            event === null ||
            !("type" in event) ||
            event.type !== "message" ||
            !("message" in event)
          ) {
            return false;
          }
          const message = event.message;
          return (
            typeof message === "object" &&
            message !== null &&
            "idempotencyKey" in message &&
            message.idempotencyKey === `${runId}:user`
          );
        }),
      ).toHaveLength(1);
    } finally {
      stopListening?.();
      await resetDirectChatSession();
    }
  });

  test("chat.send keeps a durable Control UI retry pending when recovery remains abandoned", async () => {
    const { storePath } = openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-duplicate";
    try {
      await writeSessionStore({ entries: {} });
      await replaceSessionEntry(
        { sessionKey: "main", storePath },
        {
          sessionId: "sess-main",
          status: "interrupted",
          abortedLastRun: true,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliverySourceRunId: idempotencyKey,
          updatedAt: Date.now(),
        },
      );
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "main",
          storePath,
        },
        {
          message: {
            role: "user",
            content: "already admitted",
            idempotencyKey: `${idempotencyKey}:user`,
          },
        },
      );
      const context = createDirectChatContext();
      const responses: Array<{ error?: unknown; ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "already admitted",
        respond: captureChatResponse(responses),
      });

      expect(responses).toEqual([
        {
          error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
          ok: false,
          payload: undefined,
        },
      ]);
      expect(restartRecoveryMocks.retryRestartAbortedMainSessionRecovery).toHaveBeenCalledWith({
        canonicalSessionKey: "agent:main:main",
        cfg: expect.any(Object),
        expectedRecoveryRunId: "recovery-run",
        expectedRecoverySourceRunId: idempotencyKey,
        expectedSessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
        gatewayRuntime: expect.any(Object),
      });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(
        loadExactSessionEntry({ sessionKey: "agent:main:main", storePath })?.entry,
      ).toMatchObject({
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
        sessionId: "sess-main",
        status: "interrupted",
      });
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      await resetDirectChatSession();
    }
  });

  test("chat.send retires a durable retry after recovery re-dispatch succeeds", async () => {
    const { storePath } = openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-recovered-retry";
    try {
      await writeStoredMainSession({
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockImplementationOnce(
        async ({ sessionKey, storePath: recoveryStorePath }) => {
          await patchSessionEntryCore({ sessionKey, storePath: recoveryStorePath }, () => ({
            abortedLastRun: false,
            status: undefined,
            updatedAt: Date.now(),
          }));
          return { started: 1, settled: 0, failed: 0, skipped: 0 };
        },
      );
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "already admitted",
        respond: captureChatResult(responses),
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: { runId: idempotencyKey, status: "ok" },
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const recoveredSession = loadSessionEntry(makeMainSessionScope(storePath));
      expect(recoveredSession).toMatchObject({
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      expect(recoveredSession?.status).toBeUndefined();
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      await resetDirectChatSession();
    }
  });

  test("chat.send suppresses a durable retry settled while lifecycle admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const idempotencyKey = "idem-recovery-settled-during-admission";
    const releaseMutation = createDeferred();
    let mutation: Promise<void> | undefined;
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const mutationStarted = createDeferred();
      mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: ["agent:main:main", "sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown; meta?: unknown }> = [];
      const send = sendControlUiChat({
        context,
        idempotencyKey,
        message: "already recovered",
        respond: ((ok, payload, _error, meta) =>
          responses.push({ ok, payload, meta })) as RespondFn,
      });
      await waitForFast(
        () => expect(context.dedupe.has(pendingChatSendDedupeKey(idempotencyKey))).toBe(true),
        FAST_WAIT_OPTS,
      );
      await patchSessionEntryCore({ sessionKey: "agent:main:main", storePath }, () => ({
        restartRecoveryTerminalRunIds: [idempotencyKey],
        updatedAt: Date.now(),
      }));
      releaseMutation.resolve();
      await Promise.all([send, mutation]);

      expect(responses).toEqual([
        {
          ok: true,
          payload: { runId: idempotencyKey, status: "ok" },
          meta: { cached: true, runId: idempotencyKey },
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(context.chatAbortControllers.has(idempotencyKey)).toBe(false);
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled(mutation ? [mutation] : []);
      await resetDirectChatSession();
    }
  });

  test("chat.send does not re-dispatch an archived durable recovery claim", async () => {
    openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-archived-retry";
    try {
      await writeStoredMainSession({
        archivedAt: Date.now(),
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      const context = createDirectChatContext();
      const responses: Array<{ error?: unknown; ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "must stay archived",
        respond: captureChatResponse(responses),
      });

      expect(responses).toEqual([
        {
          error: expect.objectContaining({ code: "INVALID_REQUEST", retryable: false }),
          ok: false,
          payload: undefined,
        },
      ]);
      expect(restartRecoveryMocks.retryRestartAbortedMainSessionRecovery).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      await resetDirectChatSession();
    }
  });

  test("chat.send stops automatic retry when durable recovery ownership changes", async () => {
    openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-replaced-retry";
    try {
      await writeStoredMainSession({
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockImplementationOnce(
        async ({ sessionKey, storePath: recoveryStorePath }) => {
          await patchSessionEntryCore({ sessionKey, storePath: recoveryStorePath }, () => ({
            sessionId: "replacement-session",
            restartRecoveryDeliveryRunId: "replacement-recovery",
            restartRecoveryDeliverySourceRunId: "replacement-source",
            updatedAt: Date.now(),
          }));
          return { started: 0, settled: 0, failed: 0, skipped: 0 };
        },
      );
      const context = createDirectChatContext();
      const responses: Array<{ error?: unknown; ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "must not dispatch replacement ownership",
        respond: captureChatResponse(responses),
      });

      expect(responses).toEqual([
        {
          error: expect.objectContaining({ code: "UNAVAILABLE", retryable: false }),
          ok: false,
          payload: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      await resetDirectChatSession();
    }
  });

  test("chat.send retries a transient post-admission projection failure under the same run", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-projection-retry";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      const agentStarts = vi.fn();
      let recoveredAuthority: ReturnType<typeof bindActiveOperatorTurnAuthority> = undefined;
      dispatchInboundMessageMock
        .mockRejectedValueOnce(new SessionTranscriptProjectionUnavailableError("sess-main"))
        .mockImplementationOnce(async (params: unknown) => {
          recoveredAuthority = bindActiveOperatorTurnAuthority(runId);
          recoveredAuthority?.assertActive();
          const options = (params as { replyOptions?: GetReplyOptions }).replyOptions;
          options?.onAgentRunStart?.(runId);
          agentStarts();
          return {};
        });

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        localClient: true,
        message: "retry projection before starting the model",
        respond: captureChatResult(responses),
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(agentStarts).toHaveBeenCalledOnce();
      expect(recoveredAuthority).toMatchObject({ source: "local" });
      expect(context.broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state: "error" }),
        expect.anything(),
      );
      expect(
        dispatchInboundMessageMock.mock.calls.map(
          ([params]) => (params as { replyOptions?: GetReplyOptions }).replyOptions?.runId,
        ),
      ).toEqual([runId, runId]);
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: runId,
      });
    } finally {
      await resetDirectChatSession();
    }
  });

  test("chat.send releases an unadopted durable claim after dispatch rejection", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-dispatch-error";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockRejectedValueOnce(new Error("dispatch rejected"));

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "retry me after dispatch failure",
        respond: captureChatResult(responses),
      });
      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      const failed = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);

      const collisionContext = createDirectChatContext();
      const collisionResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      await sendControlUiChat({
        context: collisionContext,
        idempotencyKey: runId,
        message: "changed text under the same run id",
        respond: captureChatResult(collisionResponses),
      });
      expect(collisionResponses).toEqual([
        {
          ok: false,
          payload: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        abortedLastRun: false,
        status: "failed",
      });

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      await sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "retry me after dispatch failure",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await getDirectChatSessionWorkRelease();
      expect(retryContext.removeChatRun).toHaveBeenCalledTimes(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(
        (
          dispatchInboundMessageMock.mock.calls[1]?.[0] as
            | { replyOptions?: GetReplyOptions }
            | undefined
        )?.replyOptions?.suppressNextUserMessagePersistence,
      ).toBe(true);
    } finally {
      await resetDirectChatSession();
    }
  });

  test("chat.send releases a durable claim after synchronous post-admission failure", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-setup-error";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      let responseCount = 0;

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "retry me after setup failure",
        respond: ((ok, payload) => {
          responseCount += 1;
          if (responseCount === 1) {
            throw new Error("response transport failed");
          }
          responses.push({ ok, payload });
        }) as RespondFn,
      });

      expect(responses).toEqual([{ ok: false, payload: expect.objectContaining({ runId }) }]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const failed = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);
    } finally {
      await resetDirectChatSession();
    }
  });

  test("chat.send leaves a post-admission routing rejection retryable", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-routing-change";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const initialRuntimeConfig = getRuntimeConfig();
      const changedRuntimeConfig = {
        ...initialRuntimeConfig,
        session: {
          ...initialRuntimeConfig.session,
          scope: initialRuntimeConfig.session?.scope === "global" ? "per-sender" : "global",
        },
      } as const;
      context.getRuntimeConfig = () =>
        loadSessionEntry(makeMainSessionScope(storePath))?.restartRecoveryDeliveryRunId === runId
          ? changedRuntimeConfig
          : initialRuntimeConfig;
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        expectedSessionRoutingContract: resolveSessionRoutingContract(initialRuntimeConfig),
        idempotencyKey: runId,
        message: "retry me after routing changes",
        respond: captureChatResult(responses),
      });
      expect(responses).toEqual([{ ok: false, payload: undefined }]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const failed = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      await sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "retry me after routing changes",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await getDirectChatSessionWorkRelease();
      expect(retryContext.removeChatRun).toHaveBeenCalledTimes(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(
        (
          dispatchInboundMessageMock.mock.calls[0]?.[0] as
            | { replyOptions?: GetReplyOptions }
            | undefined
        )?.replyOptions?.suppressNextUserMessagePersistence,
      ).toBe(true);
    } finally {
      await resetDirectChatSession();
    }
  });

  test.each([
    {
      caseName: "pending final delivery",
      runId: "idem-pending-final-delivery",
      entry: {
        pendingFinalDelivery: {
          kind: "replayable" as const,
          text: "older reply",
          createdAt: Date.now(),
          context: {
            channel: "whatsapp",
            to: "+15551234567",
          },
        },
      },
    },
    {
      caseName: "an aborted-run hint",
      runId: "idem-aborted-run-hint",
      entry: { abortedLastRun: true },
    },
  ])("chat.send leaves $caseName outside restart-safe admission", async ({ entry, runId }) => {
    const { storePath } = openDirectChatSession();
    try {
      await writeStoredMainSession(
        makeDoneSessionEntry({
          ...entry,
          updatedAt: Date.now(),
        }),
      );
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      const ackSnapshot: { entry: ReturnType<typeof loadSessionEntry> } = { entry: undefined };

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "new Control UI turn",
        respond: ((ok, payload) => {
          if (ok && (payload as { status?: unknown } | undefined)?.status === "started") {
            ackSnapshot.entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
          }
        }) as RespondFn,
      });

      expect(ackSnapshot.entry).toMatchObject({
        ...entry,
        status: "done",
      });
      expect(ackSnapshot.entry?.restartRecoveryDeliveryRunId).toBeUndefined();
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      await resetDirectChatSession();
    }
  });

  test("chat.send starts the next WebChat turn after the prior internal run finishes", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
      });
      dispatchInboundMessageMock.mockResolvedValue(undefined);

      const callSend = (id: string, message: string, idempotencyKey: string) =>
        callDirectChat("chat.send", {
          id,
          params: makeChatSendParams({ idempotencyKey, message }),
          client: createControlUiClient(["operator.write"]),
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      await callSend("first", "first message", "idem-sequential-a");
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);

      await callSend("second", "second message", "idem-sequential-b");
      await getDirectChatSessionWorkRelease();
      expect(context.removeChatRun).toHaveBeenCalledTimes(2);

      expect(responses).toEqual([
        {
          id: "first",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-sequential-a",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
        {
          id: "second",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-sequential-b",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      const dispatchOptions = dispatchInboundMessageMock.mock.calls.map(([params]) => {
        return (params as { replyOptions?: GetReplyOptions }).replyOptions;
      });
      expect(dispatchOptions[0]?.runId).toBe("idem-sequential-a");
      expect(dispatchOptions[1]?.runId).toBe("idem-sequential-b");
      expect(dispatchOptions[0]?.promptCacheKey).toEqual(
        expect.stringMatching(/^openclaw-webchat-[a-f0-9]{32}$/u),
      );
      expect(dispatchOptions[1]?.promptCacheKey).toBe(dispatchOptions[0]?.promptCacheKey);
      expect(dispatchOptions[0]?.promptCacheKey).not.toContain("main");
      expect(dispatchOptions[0]?.promptCacheKey).not.toContain("sess-main");
      expect(context.addChatRun).toHaveBeenCalledTimes(2);
    });
  });

  test.for(["fulfilled", "rejected", "dropped"] as const)(
    "chat.send keeps a queued input open through %s dispatch until its owner terminates",
    async (settlement, { signal }) => {
      await withDirectChatSession(async (_sessionDir, storePath) => {
        await writeStoredMainSession({});
        const runId = `idem-queued-followup-${settlement}`;
        const dispatchRelease = createDeferred();
        const dispatchStarted = createDeferred();
        const dispatchSettled = createDeferred();
        const terminal = createDeferred();
        const broadcast = vi.fn((_event: string, payload: unknown) => {
          if (_event === "chat" && (payload as { runId?: string }).runId === runId) {
            terminal.resolve();
          }
        });
        const context = createDirectChatContext({
          loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
          chatQueuedTurns: new Map(),
          broadcast,
          removeChatRun: vi.fn(() => {
            dispatchSettled.resolve();
            return undefined;
          }),
        });
        let options: InternalGetReplyOptions | undefined;
        dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
          options = (args as { replyOptions?: InternalGetReplyOptions }).replyOptions;
          options?.turnAdoptionLifecycle?.onDeferred?.();
          dispatchStarted.resolve();
          await dispatchRelease.promise;
          if (settlement === "rejected") {
            throw new Error("post-enqueue bookkeeping failed");
          }
          return {};
        });
        const { createAgentTurnService } = await import("./agent-turn/agent-turn-service.js");
        const service = createAgentTurnService({ context, isWebchatConnect: () => true });
        const chatEvents = () =>
          broadcast.mock.calls.flatMap(([event, payload]) =>
            event === "chat" && (payload as { runId?: string }).runId === runId ? [payload] : [],
          );
        try {
          await callDirectChat("chat.send", {
            id: "queued-followup",
            params: makeChatSendParams({ message: "queued prompt", idempotencyKey: runId }),
            client: makeTuiClient(),
            isWebchatConnect: () => true,
            respond: vi.fn() as RespondFn,
            context,
          });
          await withinTest(dispatchStarted.promise, signal);
          expect(options?.turnAdoptionLifecycle?.ownerKey).toBe("connection:conn-tui");
          expect(chatEvents()).toEqual([]);
          dispatchRelease.resolve();
          await withinTest(dispatchSettled.promise, signal);
          expect(chatEvents()).toEqual([]);
          expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
            ok: true,
            payload: { status: "accepted" },
          });
          await expect(service.waitForTurn({ runId, timeoutMs: 0 })).resolves.toMatchObject({
            result: { runId, status: "pending", timeoutPhase: "queue", providerStarted: false },
          });
          expect(context.chatQueuedTurns.has(runId)).toBe(true);
          expect(isSessionWorkAdmissionActive(storePath, ["agent:main:main", "sess-main"])).toBe(
            true,
          );

          // Live queued identity still fences replay if its receipt has been evicted.
          context.dedupe.delete(`chat:${runId}`);
          const replayRespond = vi.fn() as RespondFn;
          await callDirectChat("chat.send", {
            id: "queued-followup-replay",
            params: makeChatSendParams({ message: "queued prompt", idempotencyKey: runId }),
            client: makeTuiClient(),
            isWebchatConnect: () => true,
            respond: replayRespond,
            context,
          });
          expect(replayRespond).toHaveBeenCalledWith(
            true,
            { runId, status: "in_flight" },
            undefined,
            { cached: true, runId },
          );
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();

          const lifecycle = expectDefined(
            options?.turnAdoptionLifecycle,
            "missing queued lifecycle",
          );
          if (settlement === "dropped") {
            options?.onFollowupQueueDisposition?.("queue-cap-old");
            expect(context.logGateway.info).toHaveBeenCalledWith(
              "chat queue turn intentionally skipped",
              { runId, sessionKey: "agent:main:main", outcome: "skipped", reason: "queue-cap-old" },
            );
          } else {
            const deliver = expectDefined(
              options?.onQueuedFollowupReplyBatch,
              "missing queued reply delivery",
            );
            await lifecycle.onAdopted();
            options?.onAgentRunStart?.("queued-followup-agent-run");
            await withinTest(
              Promise.resolve(
                deliver({
                  kind: "queued-followup",
                  completion: { kind: "completed" },
                  runId: "queued-followup-agent-run",
                  originatingChannel: "webchat",
                  payloads: [{ text: "queued follow-up answer" }],
                }),
              ),
              signal,
            );
          }
          await withinTest(terminal.promise, signal);
          lifecycle.onSettled?.();
          await getDirectChatSessionWorkRelease();
          expect(chatEvents()).toEqual([
            expect.objectContaining({
              runId,
              ...(settlement === "dropped"
                ? { state: "error", errorMessage: "Queued input was dropped (queue-cap-old)." }
                : {
                    state: "final",
                    message: expect.objectContaining({
                      content: [{ type: "text", text: "queued follow-up answer" }],
                    }),
                  }),
            }),
          ]);
          await expect(service.waitForTurn({ runId, timeoutMs: 0 })).resolves.toMatchObject({
            result: {
              runId,
              status: settlement === "dropped" ? "error" : "ok",
              endedAt: expect.any(Number),
            },
          });
          expect(context.chatQueuedTurns.has(runId)).toBe(false);
          expect(isSessionWorkAdmissionActive(storePath, ["agent:main:main", "sess-main"])).toBe(
            false,
          );
          if (settlement !== "dropped") {
            expect(context.removeChatRun).toHaveBeenCalledWith(
              "queued-followup-agent-run",
              runId,
              "agent:main:main",
            );
          }
        } finally {
          dispatchRelease.resolve();
          context.chatQueuedTurns.get(runId)?.controller.abort();
          options?.turnAdoptionLifecycle?.onSettled?.();
          await getDirectChatSessionWorkRelease();
        }
      });
    },
  );

  test("chat.send emits operator-only post-ACK server timing milestones", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: CapturedChatResponse[] = [];
      const broadcastToConnIds = vi.fn();
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        broadcastToConnIds,
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: GetReplyOptions }).replyOptions;
        replyOptions?.onModelSelected?.({
          provider: "openai",
          model: "gpt-5.5",
          thinkLevel: undefined,
        });
        replyOptions?.onAgentRunStart?.("agent-run-1");
        return {};
      });

      await callDirectChat("chat.send", {
        id: "operator-timing",
        params: makeChatSendParams({
          message: "measure",
          idempotencyKey: "idem-server-timing",
        }),
        client: createControlUiClient(["operator.write"], { connId: "conn-control-ui" }),
        isWebchatConnect: () => true,
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-server-timing",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
      ]);
      await waitForFast(
        () => {
          const phases = broadcastToConnIds.mock.calls
            .filter(([event]) => event === "chat.send_timing")
            .map(([, payload]) => (payload as { phase?: unknown }).phase);
          expect(phases).toEqual(
            expect.arrayContaining([
              "dispatch-started",
              "model-selected",
              "agent-run-started",
              "dispatch-completed",
              "post-dispatch-completed",
            ]),
          );
        },
        { timeout: 2_000, interval: 5 },
      );
      for (const [event, payload, connIds, opts] of broadcastToConnIds.mock.calls) {
        expect(event).toBe("chat.send_timing");
        expect(connIds).toEqual(new Set(["conn-control-ui"]));
        expect(opts).toEqual({ dropIfSlow: true });
        expect(payload).toMatchObject({
          runId: "idem-server-timing",
          sessionKey: "agent:main:main",
          ackToPhaseMs: expect.any(Number),
          receivedToPhaseMs: expect.any(Number),
        });
      }
      const timingPayloads = broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(timingPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "model-selected",
            provider: "openai",
            model: "gpt-5.5",
          }),
          expect.objectContaining({
            phase: "agent-run-started",
            agentRunId: "agent-run-1",
            dispatchStartedToPhaseMs: expect.any(Number),
          }),
        ]),
      );
    });
  });

  test("chat.send emits first-assistant timing for direct final replies", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: CapturedChatResponse[] = [];
      const broadcast = vi.fn();
      const broadcastToConnIds = vi.fn();
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        broadcast,
        broadcastToConnIds,
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const dispatcher = (
          args as {
            dispatcher?: {
              sendFinalReply: (payload: { text: string }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
            };
          }
        ).dispatcher;
        dispatcher?.sendFinalReply({ text: "direct reply" });
        dispatcher?.markComplete();
        await dispatcher?.waitForIdle();
        return {};
      });

      await callDirectChat("chat.send", {
        id: "operator-direct-timing",
        params: makeChatSendParams({
          message: "measure direct",
          idempotencyKey: "idem-direct-server-timing",
        }),
        client: createControlUiClient(["operator.write"], { connId: "conn-control-ui" }),
        isWebchatConnect: () => true,
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-direct-server-timing",
            status: "started",
          }),
          error: undefined,
        },
      ]);
      await waitForFast(
        () => {
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "chat.send_timing",
            expect.objectContaining({
              phase: "first-assistant-event",
              runId: "idem-direct-server-timing",
              sessionKey: "agent:main:main",
              ackToPhaseMs: expect.any(Number),
              dispatchStartedToPhaseMs: expect.any(Number),
              receivedToPhaseMs: expect.any(Number),
            }),
            new Set(["conn-control-ui"]),
            { dropIfSlow: true },
          );
          expect(broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({
              runId: "idem-direct-server-timing",
              state: "final",
              message: expect.objectContaining({
                content: expect.arrayContaining([
                  expect.objectContaining({
                    text: "direct reply",
                  }),
                ]),
              }),
            }),
            { sessionKeys: ["agent:main:main"] },
          );
        },
        { timeout: 2_000, interval: 5 },
      );

      const firstAssistantTimingCallIndex = broadcastToConnIds.mock.calls.findIndex(
        ([event, payload]) =>
          event === "chat.send_timing" &&
          (payload as { phase?: unknown }).phase === "first-assistant-event",
      );
      expect(firstAssistantTimingCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        broadcastToConnIds.mock.invocationCallOrder[firstAssistantTimingCallIndex],
      ).toBeLessThan(
        expectDefined(
          broadcast.mock.invocationCallOrder[0],
          "broadcast.mock.invocationCallOrder[0] test invariant",
        ),
      );
    });
  });

  test("chat.history does not surface an older stale assistant when overreading for pair context", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeStoredMainSession({
        sessionStartedAt,
      });
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
      await writeMainSessionTranscript([
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:29.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        makeTranscriptTextEvent("older stale announce reply", {
          timestamp: "2026-05-16T16:00:30.000Z",
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        makeTranscriptTextEvent("newer stale announce reply", {
          timestamp: "2026-05-16T16:00:33.000Z",
        }),
        makeTranscriptTextEvent("fresh turn", {
          role: "user",
          timestamp: "2026-05-23T04:03:10.000Z",
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 3 });
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("older stale announce reply");
      expect(serialized).not.toContain("newer stale announce reply");
      expect(serialized).toContain("fresh turn");
    });
  });

  test("chat.history offset pages backfill after filtering stale announce replies", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
      await writeStoredMainSession({
        sessionStartedAt,
      });
      await writeMainSessionTranscript([
        makeTranscriptTextEvent("older visible turn", {
          role: "user",
          timestamp: "2026-05-23T04:03:10.000Z",
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        makeTranscriptTextEvent("stale announce reply", {
          timestamp: "2026-05-16T16:00:33.000Z",
        }),
        makeTranscriptTextEvent("latest visible reply", {
          timestamp: "2026-05-23T04:03:20.000Z",
        }),
      ]);

      const page = await rpcReq<HistoryPage>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 1,
          offset: 1,
          maxChars: 100,
        }),
      );
      expect(page.ok).toBe(true);
      expect(JSON.stringify(page.payload?.messages)).toContain("older visible turn");
      expect(JSON.stringify(page.payload)).not.toContain("stale announce reply");
      expect(page.payload?.nextOffset).toBeUndefined();
      expect(page.payload?.hasMore).toBe(false);
    });
  });

  test("chat.history offset pages preserve a hidden heartbeat boundary from overread context", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      await writeStoredMainSession({});
      await writeMainSessionTranscript([
        makeTranscriptTextEvent(HEARTBEAT_PROMPT, { role: "user" }),
        makeTranscriptTextEvent("heartbeat run output"),
        makeTranscriptTextEvent("newest output"),
      ]);

      const page = await rpcReq<{
        messages?: Array<{
          content?: Array<{ text?: string }>;
          __openclaw?: { turnBoundary?: boolean };
        }>;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 1,
          offset: 1,
        }),
      );

      expect(page.ok).toBe(true);
      expect(page.payload?.messages).toHaveLength(1);
      expect(page.payload?.messages?.[0]?.content?.[0]?.text).toBe("heartbeat run output");
      expect(page.payload?.messages?.[0]?.["__openclaw"]?.turnBoundary).toBe(true);
    });
  });

  test("chat.send omits ACK server timing for public WebChat clients", async () => {
    await withGatewayChatHarness(
      async ({ ws, createSessionDir }) => {
        await connectOk(ws, makeGatewayWebchatClient(GATEWAY_CLIENT_NAMES.WEBCHAT_UI));

        await createSessionDir();
        await writeMainSessionStore();
        mockGetReplyFromConfigOnce(async () => undefined);

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            idempotencyKey: "idem-public-webchat",
          }),
        );

        expect(sendRes.ok).toBe(true);
        expect(sendRes.payload).toMatchObject({
          runId: "idem-public-webchat",
          status: "started",
        });
        expect(
          (sendRes.payload as { serverTiming?: unknown } | undefined)?.serverTiming,
        ).toBeUndefined();
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.send rejects Control UI reconnect resume marker from public WebChat clients", async () => {
    await withGatewayChatHarness(
      async ({ ws }) => {
        await connectOk(ws, makeGatewayWebchatClient(GATEWAY_CLIENT_NAMES.WEBCHAT_UI));

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            sessionId: "sess-main",
            __controlUiReconnectResume: true,
            message: "hello after reconnect",
            idempotencyKey: "idem-public-webchat-resume",
          }),
        );
        expect(sendRes.ok).toBe(false);
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("projects persisted media facts through Gateway history and sessions_history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const invalidClaims = [
        "media://inbound/nested/file.png",
        "media://inbound/nested%2Ffile.png",
        "media://inbound/nested%5Cfile.png",
        "media://inbound/file%00.png",
        "media://inbound/",
        "media://inbound/.",
        "media://inbound/..",
        ["media://user", "password@inbound/claim.png"].join(":"),
        "media://inbound/claim.png?signature=private-secret",
        "media://inbound/claim.png#private-fragment",
      ];
      const persisted = buildPersistedUserTurnMessage({
        text: "inspect mixed attachments",
        timestamp: Date.now(),
        media: [
          {
            kind: "video",
            url: "media://inbound/video-claim",
            contentType: "video/mp4",
            fileName: "managed-video.mp4",
            durationMs: 5678,
          },
          {
            kind: "image",
            url: "media://inbound/image-claim",
            contentType: "image/png",
            fileName: "managed-image.png",
            width: 640,
            height: 480,
          },
          {
            kind: "image",
            path: "/private/media/local-image.png",
            workspaceDir: "/private/workspace",
            contentType: "image/png",
            fileName: "local-image.png",
            sizeBytes: 42,
            width: 640,
            height: 480,
            messageId: "local-source-id",
          },
          {
            kind: "audio",
            url: "https://media-user@media.example/audio.wav?signature=private-signature#audio-fragment",
            contentType: "audio/wav",
            fileName: "remote-audio.wav",
            durationMs: 1234,
          },
          {
            kind: "document",
            url: "not a media reference",
            contentType: "application/pdf",
            fileName: "metadata-only.pdf",
          },
          ...invalidClaims.map((claim, index) => ({
            kind: "image" as const,
            path: claim,
            contentType: "image/png",
            fileName: `invalid-claim-${index}.png`,
          })),
        ],
        mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 1 }] },
      }) as unknown as Record<string, unknown>;
      const metadata = persisted["__openclaw"] as Record<string, unknown>;
      const facts = metadata.media as Array<Record<string, unknown>>;
      Object.assign(expectDefined(facts[2], "local media fact"), {
        data: "private-inline-data",
        blob: "private-inline-blob",
        filePath: "/private/media/alternate-image.png",
        source: "telegram-attachment-1",
      });
      metadata.upstreamUserText = "private upstream prompt";
      metadata.keepMe = { durable: true };
      await writeMainSessionTranscript([{ id: "persisted-media", message: persisted }]);

      const historyMessages = await fetchHistoryMessages(ws);
      const tool = createSessionsHistoryTool({
        config: {},
        callGateway: async <T = Record<string, unknown>>(request: {
          method: string;
          params?: unknown;
        }) => {
          const response = await rpcReq<T & Record<string, unknown>>(
            ws,
            request.method,
            request.params,
          );
          expect(response.ok).toBe(true);
          return expectDefined(response.payload, `${request.method} payload`);
        },
      });
      const toolResult = await tool.execute("persisted-media", { sessionKey: "main" });
      const sessionsHistory = (toolResult.details as { messages: unknown[] }).messages;

      for (const [boundary, messages] of [
        ["chat.history", historyMessages],
        ["sessions_history", sessionsHistory],
      ] as const) {
        expect(messages, boundary).toHaveLength(1);
        expect(messages[0], boundary).toMatchObject({
          role: "user",
          content: "inspect mixed attachments",
          __openclaw: {
            keepMe: { durable: true },
            mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 1 }] },
            media: [
              {
                kind: "video",
                url: "media://inbound/video-claim",
                contentType: "video/mp4",
                fileName: "managed-video.mp4",
                durationMs: 5678,
              },
              {
                kind: "image",
                url: "media://inbound/image-claim",
                contentType: "image/png",
                fileName: "managed-image.png",
                width: 640,
                height: 480,
              },
              {
                kind: "image",
                contentType: "image/png",
                fileName: "local-image.png",
                sizeBytes: 42,
                width: 640,
                height: 480,
                messageId: "local-source-id",
                source: "telegram-attachment-1",
              },
              {
                kind: "audio",
                url: "https://media.example/audio.wav",
                contentType: "audio/wav",
                fileName: "remote-audio.wav",
                durationMs: 1234,
              },
              {
                kind: "document",
                contentType: "application/pdf",
                fileName: "metadata-only.pdf",
              },
              ...invalidClaims.map((_, index) => ({
                kind: "image",
                contentType: "image/png",
                fileName: `invalid-claim-${index}.png`,
              })),
            ],
          },
        });
        const projectedMedia = (
          (messages[0] as { __openclaw?: { media?: Array<Record<string, unknown>> } })["__openclaw"]
            ?.media ?? []
        ).map((fact) => fact.path ?? fact.url ?? null);
        expect(projectedMedia, boundary).toEqual([
          "media://inbound/video-claim",
          "media://inbound/image-claim",
          null,
          "https://media.example/audio.wav",
          ...Array.from({ length: invalidClaims.length + 1 }, () => null),
        ]);
        const serialized = JSON.stringify(messages);
        for (const privateValue of [
          "/private/media",
          "/private/workspace",
          "private-inline-data",
          "private-inline-blob",
          "media-user",
          "private-signature",
          "audio-fragment",
          "private upstream prompt",
          "not a media reference",
        ]) {
          expect(serialized, `${boundary}: ${privateValue}`).not.toContain(privateValue);
        }
      }
    });
  });

  test("chat.history keeps recent messages within the production byte budget", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const historyMaxBytes = getMaxChatHistoryMessagesBytes();
      const baseText = "s".repeat(100_000);
      const lines: unknown[] = Array.from({ length: 70 }, (_, index) =>
        createTextTranscriptEvent("user", `small-${index}:${baseText}`, {
          timestamp: Date.now() + index,
        }),
      );
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now() + 1_000,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: { nested: { payload: "z".repeat(300_000) } },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(lines);
      const messages = await fetchHistoryMessages(ws, { maxChars: 100_000 });
      const serialized = JSON.stringify(messages);

      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("small-69:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized).not.toContain("small-0:");
    });
  });

  test("chat.history serves older history past an oversized newest record", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const historyMaxBytes = getMaxChatHistoryMessagesBytes();
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "reachable older message", { timestamp: Date.now() }),
        makeTranscriptTextEvent("NO_REPLY", {
          message: {
            padding: "x".repeat(historyMaxBytes * 2 + 1024),
            timestamp: Date.now() + 1,
          },
        }),
      ]);

      const firstPage = await rpcReq<{
        messages?: unknown[];
        nextOffset?: number;
        hasMore?: boolean;
      }>(ws, "chat.history", makeMainSessionParams({ limit: 1 }));
      expect(firstPage.ok).toBe(true);
      expect(JSON.stringify(firstPage.payload?.messages)).toContain("reachable older message");
      expect(firstPage.payload?.hasMore).toBe(false);
      expect(firstPage.payload?.nextOffset).toBeUndefined();
    });
  });

  test("chat.history preserves usage and cost metadata for assistant messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      await writeMainSessionTranscript([
        makeTranscriptTextEvent("hello", {
          message: {
            timestamp: Date.now(),
            usage: {
              input: 12,
              output: 5,
              totalTokens: 17,
              cost: { input: 0.002, output: 0.01, cacheRead: 0.0003, cacheWrite: 0, total: 0.0123 },
            },
            cost: { input: 0.002, output: 0.01, cacheRead: 0.0003, cacheWrite: 0, total: 0.0123 },
            details: { debug: true },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        role?: string;
        usage?: {
          input?: number;
          output?: number;
          totalTokens?: number;
          cost?: Record<string, number>;
        };
        cost?: Record<string, number>;
      };
      expect(message.role).toBe("assistant");
      expect(message.usage?.input).toBe(12);
      expect(message.usage?.output).toBe(5);
      expect(message.usage?.totalTokens).toBe(17);
      expect(message.usage?.cost).toEqual({
        input: 0.002,
        output: 0.01,
        cacheRead: 0.0003,
        cacheWrite: 0,
        total: 0.0123,
      });
      expect(message.cost).toEqual({
        input: 0.002,
        output: 0.01,
        cacheRead: 0.0003,
        cacheWrite: 0,
        total: 0.0123,
      });
      expect(message.cost?.total).toBe(0.0123);
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history retains a completed command's Guardian review details", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const toolCallId = "exec-guardian-approved";
      const review = {
        id: "review-guardian-approved",
        label: "Guardian",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "The command is local and read-only.",
      };
      await writeMainSessionTranscript([
        {
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: {} }],
          },
        },
        makeTranscriptTextEvent("Command completed.", {
          role: "toolResult",
          message: {
            toolCallId,
            toolName: "exec",
            details: {
              approvalReviews: [review],
              approvalReviewOutcome: "approved",
              internal: "not for display",
            },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: "toolResult",
        toolCallId,
        details: {
          approvalReviews: [review],
          approvalReviewOutcome: "approved",
        },
      });
      expect(messages[1]).not.toHaveProperty("details.internal");
    });
  });

  test("chat.message.get returns archive-backed rows surfaced by history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionId = "sess-archive-backed";
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        sessionId,
        freshStore: true,
      });
      await fs.writeFile(
        `${testSessionFilePath(sessionDir, sessionId)}.reset.2026-02-16T22-26-34.000Z`,
        [
          JSON.stringify({ type: "session", version: 1, id: sessionId }),
          JSON.stringify(
            createTextTranscriptEvent("assistant", "archive abcdefghij", {
              id: "msg-archive-full-assistant",
            }),
          ),
        ].join("\n"),
        "utf-8",
      );

      const historyMessages = await fetchHistoryMessages(ws, { maxChars: 12 });
      expect(JSON.stringify(historyMessages)).toContain("archive abcd\\n...(truncated)...");

      const full = await fetchChatMessage(ws, makeMainMessageParams("msg-archive-full-assistant"));
      expect(full.ok).toBe(true);
      expect(full.unavailableReason).toBeUndefined();
      expect(JSON.stringify(full.message)).toContain("archive abcdefghij");
      expect(JSON.stringify(full.message)).not.toContain("...(truncated)...");
    });
  });

  test("chat.message.get accepts the selected agent for global sessions", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "work" } },
          entries: { main: {}, work: {} },
        },
      });
      await connectOk(ws);
      await createSessionDir({ fresh: true });
      await writeSessionStore({
        agentId: "work",
        entries: {
          global: { sessionId: "sess-global", updatedAt: Date.now() },
        },
      });
      await writeMainSessionTranscript(
        [
          createTextTranscriptEvent("assistant", "global agent content", {
            id: "msg-global-agent",
          }),
        ],
        "sess-global",
        { agentId: "work", sessionKey: "global" },
      );

      const full = await fetchChatMessage(ws, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-global-agent",
      });
      expect(full.ok).toBe(true);
      expect(JSON.stringify(full.message)).toContain("global agent content");
    });
  });

  test("chat.message.get reports oversized archive transcript entries as unavailable", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionId = "sess-oversized-archive";
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        sessionId,
        freshStore: true,
      });
      const oversizedLine = JSON.stringify(
        createTextTranscriptEvent("assistant", "x".repeat(300 * 1024), {
          id: "msg-oversized",
        }),
      );
      await fs.writeFile(
        `${testSessionFilePath(sessionDir, sessionId)}.reset.2026-02-16T22-26-34.000Z`,
        [JSON.stringify({ type: "session", version: 1, id: sessionId }), oversizedLine].join("\n"),
        "utf-8",
      );

      const full = await fetchChatMessage(ws, makeMainMessageParams("msg-oversized"));
      expect(full.ok).toBe(false);
      expect(full.unavailableReason).toBe("oversized");
      expect(full.message).toBeUndefined();
    });
  });

  test("chat.message.get does not return inactive branch entries", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "question", { id: "msg-root", parentId: null }),
        createTextTranscriptEvent("assistant", "stale branch", {
          id: "msg-stale",
          parentId: "msg-root",
        }),
        createTextTranscriptEvent("assistant", "active branch", {
          id: "msg-active",
          parentId: "msg-root",
        }),
        createTextTranscriptEvent("assistant", "side delivery", {
          id: "msg-side-delivery",
          parentId: "msg-active",
        }),
        JSON.stringify({
          type: "leaf",
          id: "active-leaf",
          parentId: "msg-side-delivery",
          targetId: "msg-active",
        }),
      ]);
      await waitForSessionTranscriptIndexReconcile({
        agentId: "main",
        path: path.join(sessionDir, "openclaw-agent.sqlite"),
      });

      const stale = await fetchChatMessage(ws, makeMainMessageParams("msg-stale"));
      expect(stale.ok).toBe(false);
      expect(stale.unavailableReason).toBe("not_found");

      const sideDelivery = await fetchChatMessage(ws, makeMainMessageParams("msg-side-delivery"));
      expect(sideDelivery.ok).toBe(false);
      expect(sideDelivery.unavailableReason).toBe("not_found");

      const active = await fetchChatMessage(ws, makeMainMessageParams("msg-active"));
      expect(active.ok).toBe(true);
      expect(JSON.stringify(active.message)).toContain("active branch");
      expect(JSON.stringify(await fetchHistoryMessages(ws))).not.toContain("side delivery");
    });
  });

  test("chat.history overreads context while scanning past a silent tail", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const sessionStartedAt = Date.now();
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now(), sessionStartedAt },
        },
      });
      // limit 2 reads a 60-record tail, and the scan then walks 100-record
      // chunks, so record 239 of 400 is the first chunk's context boundary.
      const silent = (index: number, count: number) =>
        Array.from({ length: count }, (_, offset) =>
          createTextTranscriptEvent("assistant", "NO_REPLY", {
            timestamp: sessionStartedAt + index + offset,
          }),
        );
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "oldest visible question", {
          timestamp: sessionStartedAt + 1,
        }),
        ...silent(2, 238),
        createTextTranscriptEvent("user", "stale announce", {
          timestamp: sessionStartedAt - 2_000,
          message: { provenance: { kind: "inter_session", sourceTool: "subagent_announce" } },
        }),
        createTextTranscriptEvent("assistant", "stale announce reply", {
          timestamp: sessionStartedAt - 1_000,
        }),
        ...silent(300, 159),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2, maxChars: 100 });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("oldest visible question");
      expect(serialized).not.toContain("stale announce reply");
    });
  });

  test("chat.history returns retryable unavailable while a dirty projection rebuilds", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        JSON.stringify({ message: { role: "user", content: "ready after rebuild" } }),
      ]);
      const databaseOptions = toDatabaseOptions(
        resolveSqliteTranscriptScope(makeMainSessionScope(testState.sessionStorePath)),
      );
      const database = openOpenClawAgentDatabase(databaseOptions);
      // Keep the writer-held rebuild pending until the real RPC observes its dirty state.
      await runExclusiveSqliteSessionWrite(
        databaseOptions,
        async () => {
          const marked = database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run("sess-main");
          expect(marked.changes).toBe(1);
          const rebuilding = await rpcReq(ws, "chat.history", makeMainSessionParams({ limit: 1 }));
          expect(rebuilding.ok).toBe(false);
          expect(rebuilding.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
        },
        "sessions.transcript-index.preflight",
      );

      await waitForSessionTranscriptIndexReconcile(databaseOptions);
      const ready = await rpcReq<{ messages?: unknown[] }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 1,
        }),
      );
      expect(ready.ok).toBe(true);
      expect(JSON.stringify(ready.payload?.messages)).toContain("ready after rebuild");
    });
  });

  test("chat.history backfills older offset pages across a dense silent gap", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const startedAt = Date.now();
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "older visible question", { timestamp: startedAt }),
        createTextTranscriptEvent("assistant", "older visible answer", {
          timestamp: startedAt + 1,
        }),
        ...Array.from({ length: 80 }, (_, index) =>
          createTextTranscriptEvent("assistant", "NO_REPLY", {
            timestamp: startedAt + index + 2,
          }),
        ),
        createTextTranscriptEvent("assistant", "latest visible answer", {
          timestamp: startedAt + 82,
        }),
      ]);

      const firstPage = await rpcReq<HistoryPage>(
        ws,
        "chat.history",
        makeMainSessionParams({ limit: 1, offset: 0, maxChars: 100 }),
      );
      expect(firstPage.ok).toBe(true);
      expect(JSON.stringify(firstPage.payload?.messages)).toContain("latest visible answer");
      expect(firstPage.payload?.nextOffset).toBe(1);

      const olderPage = await rpcReq<HistoryPage>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 2,
          offset: firstPage.payload?.nextOffset,
          maxChars: 100,
        }),
      );
      expect(olderPage.ok).toBe(true);
      expect(olderPage.payload?.messages?.map(readOpenClawSeq)).toEqual([1, 2]);
      expect(JSON.stringify(olderPage.payload?.messages)).not.toContain("NO_REPLY");
      expect(olderPage.payload?.hasMore).toBe(false);
      expect(olderPage.payload?.nextOffset).toBeUndefined();
    });
  });

  test.each([
    {
      boundary: {
        type: "reset",
        id: "reset-boundary",
        reason: "reset",
        firstKeptEntryId: "kept-one",
      },
      expectedFirstSeqs: [3, 4, 12, 20],
      expectedOlderSeqs: [1, 2],
      marker: "Reset",
      totalMessages: 27,
    },
    {
      boundary: {
        type: "compaction",
        id: "compaction-boundary",
        summary: "summary",
        firstKeptEntryId: "old",
      },
      expectedFirstSeqs: [4, 5, 13, 21],
      expectedOlderSeqs: [1, 2, 3],
      marker: "Compaction",
      totalMessages: 28,
    },
  ])(
    "chat.history incrementally fills pages across $boundary.type boundaries",
    async ({ boundary, expectedFirstSeqs, expectedOlderSeqs, marker, totalMessages }) => {
      await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
        await prepareMainHistoryHarness({ ws, createSessionDir });
        const timestamp = Date.now();
        const events: Array<Record<string, unknown>> = [
          {
            type: "message",
            ...createTextTranscriptEvent("user", "discarded old", {
              id: "old",
              parentId: null,
              timestamp,
            }),
          },
          {
            type: "message",
            ...createTextTranscriptEvent("user", "kept one", {
              id: "kept-one",
              parentId: "old",
              timestamp: timestamp + 1,
            }),
          },
          {
            type: "message",
            ...createTextTranscriptEvent("assistant", "kept two", {
              id: "kept-two",
              parentId: "kept-one",
              timestamp: timestamp + 2,
            }),
          },
          {
            ...boundary,
            parentId: "kept-two",
            timestamp: new Date(timestamp + 3).toISOString(),
          },
        ];
        let parentId = boundary.id;
        let eventIndex = 4;
        for (const label of ["visible one", "visible two", "visible three"]) {
          const visibleId = `visible-${eventIndex}`;
          events.push({
            type: "message",
            ...createTextTranscriptEvent("user", label, {
              id: visibleId,
              parentId,
              timestamp: timestamp + eventIndex,
            }),
          });
          parentId = visibleId;
          eventIndex += 1;
          for (let hidden = 0; hidden < 7; hidden += 1) {
            const hiddenId = `hidden-${eventIndex}`;
            events.push({
              type: "message",
              ...createTextTranscriptEvent("assistant", "NO_REPLY", {
                id: hiddenId,
                parentId,
                timestamp: timestamp + eventIndex,
              }),
            });
            parentId = hiddenId;
            eventIndex += 1;
          }
        }
        await writeMainSessionTranscript(events);

        const first = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({ limit: 4, offset: 0 }),
        );
        expect(first.ok).toBe(true);
        expect(
          first.payload?.messages?.map(readOpenClawSeq),
          JSON.stringify(first.payload),
        ).toEqual(expectedFirstSeqs);
        expect(JSON.stringify(first.payload?.messages)).toContain(marker);
        expect(JSON.stringify(first.payload?.messages)).toContain("visible three");
        expect(first.payload).toMatchObject({
          hasMore: true,
          nextOffset: 25,
          totalMessages,
        });

        const older = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({ limit: 4, offset: first.payload?.nextOffset }),
        );
        expect(older.ok).toBe(true);
        expect(older.payload?.messages?.map(readOpenClawSeq)).toEqual(expectedOlderSeqs);
        expect(older.payload?.hasMore).toBe(false);
        expect(older.payload?.nextOffset).toBeUndefined();
      });
    },
  );

  test("chat.history centers a bounded page around a message id", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        JSON.stringify({ type: "model_change", provider: "mock", modelId: "mock" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "off" }),
      ]);
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      for (let index = 0; index < 7; index += 1) {
        await appendTranscriptMessage(makeMainSessionScope(storePath), {
          eventId: `message-${index + 1}`,
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `message ${index + 1} ${"x".repeat(700)}` }],
            timestamp: Date.now() + index,
          },
        });
      }
      await waitForSessionTranscriptIndexReconcile({
        agentId: "main",
        path: path.join(sessionDir, "openclaw-agent.sqlite"),
      });

      const history = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
        offset?: number;
        totalMessages?: number;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 3,
          messageId: "message-3",
          sessionId: "sess-main",
          maxChars: 100,
        }),
      );

      expect(history.ok).toBe(true);
      expect(history.payload?.messages?.map(readOpenClawSeq)).toEqual([2, 3, 4]);
      expect(history.payload?.offset).toBeUndefined();
      expect(history.payload?.nextOffset).toBeUndefined();
      expect(history.payload?.hasMore).toBeUndefined();
      expect(history.payload?.totalMessages).toBeUndefined();
    });
  });

  test("chat.history reopens a search anchor from a prior session id", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const currentSessionStartedAt = Date.now();
      await writeStoredMainSession({
        updatedAt: futureFixtureUpdatedAt(),
        sessionStartedAt: currentSessionStartedAt,
      });
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      const archivedScope = {
        agentId: "main",
        sessionId: "sess-before-reset",
        sessionKey: "agent:main:main",
        storePath,
      };
      await appendTranscriptMessage(archivedScope, {
        eventId: "archived-1",
        parentId: null,
        message: {
          role: "user",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          content: "before anchor",
          timestamp: currentSessionStartedAt - 2_000,
        },
      });
      await appendTranscriptMessage(archivedScope, {
        eventId: "archived-2",
        parentId: "archived-1",
        message: {
          role: "assistant",
          content: "matching anchor",
          timestamp: currentSessionStartedAt - 1_000,
        },
      });
      await appendTranscriptMessage(archivedScope, {
        eventId: "archived-3",
        parentId: "archived-2",
        message: { role: "user", content: "after anchor" },
      });

      const history = await rpcReq<{
        messages?: Array<{ content?: string }>;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 3,
          messageId: "archived-2",
          sessionId: "sess-before-reset",
        }),
      );

      expect(history.ok).toBe(true);
      expect(history.payload?.messages?.map((message) => message.content)).toEqual([
        "matching anchor",
        "after anchor",
      ]);
    });
  });

  test("chat.history rejects offset and message id together", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const history = await rpcReq(
        ws,
        "chat.history",
        makeMainSessionParams({
          offset: 0,
          messageId: "message-1",
        }),
      );

      expect(history.ok).toBe(false);
      expect((history.error as { message?: string } | undefined)?.message).toContain(
        "offset and messageId cannot be used together",
      );
    });
  });

  test("chat.history rejects an anchored session id from another session key", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const history = await rpcReq(
        ws,
        "chat.history",
        makeMainSessionParams({
          messageId: "message-1",
          sessionId: "unknown-session",
        }),
      );

      expect(history.ok).toBe(false);
      expect((history.error as { message?: string } | undefined)?.message).toContain(
        "sessionId does not belong to sessionKey",
      );
    });
  });

  test("chat.history advances past an oversized projected source row", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const projectedSiblingCount = 70;
      const captured: Extract<DiagnosticEventPayload, { type: "payload.large" }>[] = [];
      const unsubscribe = onDiagnosticEvent((event) => {
        if (event.type === "payload.large" && event.surface === "gateway.chat.history") {
          captured.push(event);
        }
      });
      try {
        await writeMainSessionTranscript([
          createTextTranscriptEvent("user", "reachable older message", { timestamp: Date.now() }),
          JSON.stringify({
            id: "oversized-history-source",
            message: {
              role: "assistant",
              // Replay metadata repeats the text; keep each row below the per-message byte cap.
              content: Array.from({ length: projectedSiblingCount }, (_, index) => ({
                type: "text",
                text: `projected sibling ${index + 1} ${"x".repeat(50_000)}`,
                textSignature: JSON.stringify({
                  v: 1,
                  id: `history-progress-${index}`,
                  phase: "commentary",
                }),
              })),
              timestamp: Date.now() + 1,
            },
          }),
        ]);

        const firstPage = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({
            // Keep the older row for paging while selecting every oversized sibling.
            limit: projectedSiblingCount,
            offset: 0,
            maxChars: 100_000,
          }),
        );
        expect(firstPage.ok).toBe(true);
        const firstMessages = firstPage.payload?.messages;
        expect(firstMessages).toHaveLength(1);
        expect(firstPage.payload?.messages).toMatchObject([
          {
            __openclaw: {
              id: "oversized-history-source",
              seq: 2,
              truncated: true,
              reason: "oversized",
            },
          },
        ]);
        expect(firstPage.payload?.hasMore).toBe(true);
        expect(firstPage.payload?.nextOffset).toBeGreaterThan(0);
        expect(
          captured.some((event) => event.action === "truncated" && (event.count ?? 0) > 0),
        ).toBe(true);

        let offset = expectDefined(firstPage.payload?.nextOffset, "second page offset");
        const olderMessages: unknown[] = [];
        for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
          const page = await rpcReq<HistoryPage>(
            ws,
            "chat.history",
            makeMainSessionParams({
              limit: 2,
              offset,
            }),
          );
          expect(page.ok).toBe(true);
          olderMessages.push(...(page.payload?.messages ?? []));
          const nextOffset = page.payload?.nextOffset;
          if (nextOffset === undefined) {
            expect(page.payload?.hasMore).toBe(false);
            break;
          }
          expect(nextOffset).toBeGreaterThan(offset);
          offset = nextOffset;
        }
        expect(JSON.stringify(olderMessages)).toContain("reachable older message");
      } finally {
        unsubscribe();
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
