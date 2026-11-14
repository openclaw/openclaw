import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import {
  createSessionRolloverSpawnLineage,
  SESSION_ROLLOVER_LINEAGE_CASES,
} from "../../config/sessions/session-lineage.test-support.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import { resolveWorkerPlacementSessionTarget } from "../../gateway/server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../../gateway/session-utils-store.js";
import {
  testing as sessionBindingTesting,
  getSessionBindingService,
  registerSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../../sessions/model-overrides.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  isSessionMutationActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { buildCommandContextForTest as buildCommandContext } from "./commands-context.test-support.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import {
  registerSessionInitializationAdmissionTests,
  telegramTurn,
} from "./session.initialization-admission.test-support.js";
import { resolveReplySessionPreprocessingState } from "./session.js";
import { expectSessionParticipantInputs } from "./session.participant.test-support.js";
import {
  expectEntryFields,
  initSessionState,
  readSessionStore as readSessionStoreFast,
  runExplicitResetCases,
  writeSessionStore as writeSessionStoreFast,
  writeTerminalTranscriptSessionStore,
} from "./test/session.test-support.js";

const sessionForkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(),
  nextSessionId: 0,
}));
const channelSummaryMocks = vi.hoisted(() => ({
  buildChannelSummary: vi.fn(async () => [] as string[]),
}));
const browserMaintenanceMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

type ForkSessionParamsForTest = {
  parentEntry: SessionEntry;
  sessionKey: string;
};

vi.mock("./session-fork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-fork.js")>()),
  forkSessionFromParent: sessionForkMocks.forkSessionFromParent,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: channelSummaryMocks.buildChannelSummary,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.7", name: "M2.7" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

// Keep the fixture caller visible when a nested database admission fails.
const previousStackTraceLimit = Error.stackTraceLimit;
Error.stackTraceLimit = 64;
afterAll(() => {
  Error.stackTraceLimit = previousStackTraceLimit;
});

const suiteRoot = useSessionStoreTempDirs(afterAll, "openclaw-session-suite-").make();
let suiteCase = 0;

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string, agentId?: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  const sessionsDir = agentId ? path.join(root, "agents", agentId, "sessions") : root;
  return path.join(sessionsDir, "sessions.json");
}

const TEST_NATIVE_MODEL_PROFILE_ID = "openai:secondary@example.test";

describe("resolveReplySessionPreprocessingState", () => {
  const sessionKey = "agent:main:harness:codex:supervision:media-preflight";

  function resolvePreprocessingState(storePath: string) {
    return resolveReplySessionPreprocessingState({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      ctx: finalizeInboundContext(telegramTurn(sessionKey, "<media:audio>", "media-preflight")),
    });
  }

  // A "missing session id" case is unrepresentable post-flip: sessions rows
  // are NOT NULL on session_id and upsert repairs id-less patches at write
  // time, so the store can never hand preprocessing such an entry.
  it.each([
    ["missing row", undefined],
    [
      "wrong owner",
      {
        sessionId: "native-media-session",
        updatedAt: 1,
        agentHarnessId: "other",
        modelSelectionLocked: true,
      },
    ],
  ] as const)("rejects a reserved %s before preprocessing", async (_label, entry) => {
    const storePath = await makeStorePath(`openclaw-media-preflight-invalid-${_label}-`);
    await writeSessionStoreFast(storePath, entry ? { [sessionKey]: entry } : {});

    await expect(resolvePreprocessingState(storePath)).rejects.toThrow();
  });
});

function setMinimalCurrentConversationBindingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
    ]),
  );
}

function registerCurrentConversationBindingAdapterForTest(params: {
  channel: "slack" | "signal" | "googlechat";
  accountId: string;
}): void {
  const bindings: Array<{
    bindingId: string;
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    conversation: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };
    status: "active";
    boundAt: number;
    metadata?: Record<string, unknown>;
  }> = [];
  registerSessionBindingAdapter({
    channel: params.channel,
    accountId: params.accountId,
    capabilities: { placements: ["current"] },
    bind: async (input) => {
      const record = {
        bindingId: `${input.conversation.channel}:${input.conversation.accountId}:${input.conversation.conversationId}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active" as const,
        boundAt: Date.now(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      bindings.push(record);
      return record;
    },
    listBySession: (targetSessionKey) =>
      bindings.filter((binding) => binding.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (binding) =>
          binding.conversation.channel === ref.channel &&
          binding.conversation.accountId === ref.accountId &&
          binding.conversation.conversationId === ref.conversationId,
      ) ?? null,
  });
}

beforeEach(() => {
  channelSummaryMocks.buildChannelSummary.mockReset().mockResolvedValue([]);
  browserMaintenanceMocks.closeTrackedBrowserTabsForSessions.mockReset().mockResolvedValue(0);
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  sessionForkMocks.nextSessionId = 0;
  sessionForkMocks.forkSessionFromParent
    .mockReset()
    .mockImplementation(async ({ sessionKey }: ForkSessionParamsForTest) => {
      const sessionId = `forked-session-${++sessionForkMocks.nextSessionId}`;
      return { sessionId, sessionFile: sessionKey };
    });
});
afterEach(() => {
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});
describe("initSessionState guarded initialization", () => {
  registerSessionInitializationAdmissionTests({ makeStorePath });

  it("reuses unchanged initialization without losing related entries or later in-process updates", async () => {
    const storePath = await makeStorePath("openclaw-session-accepted-activity-");
    const sessionKey = "agent:main:dashboard:accepted-activity";
    const sessionId = "accepted-activity";
    const storedParentKey = "agent:main:dashboard:stored-parent";
    const modelParentKey = "agent:main:dashboard:model-parent";
    const at = Date.now() - 1_000;
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: at,
        lastInteractionAt: at,
        parentSessionKey: storedParentKey,
      },
      [storedParentKey]: { sessionId: "stored-parent", updatedAt: at, label: "Stored parent" },
      [modelParentKey]: { sessionId: "model-parent", updatedAt: at, modelOverride: "test-model" },
    });
    const params = {
      cfg: { session: { store: storePath } } as OpenClawConfig,
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        ModelParentSessionKey: modelParentKey,
        Provider: "webchat",
        Surface: "webchat",
      },
      recordedSessionActivity: { sessionId, sessionKey, at },
    };
    const initialized = await initSessionState(params);
    expect(initialized.sessionEntry).toMatchObject({ updatedAt: at, lastInteractionAt: at });
    const unchanged = await initSessionState(params);
    expect(unchanged.sessionEntry).toEqual(initialized.sessionEntry);
    expect(unchanged.sessionEntryHandle.get(storedParentKey)).toMatchObject({
      sessionId: "stored-parent",
      label: "Stored parent",
    });
    expect(unchanged.sessionEntryHandle.get(modelParentKey)).toMatchObject({
      sessionId: "model-parent",
      modelOverride: "test-model",
    });

    const updated = expectDefined(
      await upsertSessionEntryCore(
        { storePath, sessionKey },
        { label: "renamed after acceptance", lastInteractionAt: at + 100 },
      ),
      "updated session entry",
    );
    const resumed = await initSessionState(params);
    const expected = {
      label: "renamed after acceptance",
      updatedAt: updated.updatedAt,
      lastInteractionAt: at + 100,
    };
    expect(resumed.sessionEntry).toMatchObject(expected);
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(expected);
  });

  it.each(["session", "key", "reset"] as const)(
    "does not reuse accepted activity after a %s change",
    async (change) => {
      const storePath = await makeStorePath("openclaw-session-replaced-activity-");
      const sessionKey = "agent:main:dashboard:replaced-activity";
      const sessionId = "replaced-activity";
      const at = Date.now() - 1_000;
      await writeSessionStoreFast(storePath, {
        [sessionKey]: { sessionId, updatedAt: at, lastInteractionAt: at },
      });
      const initialized = await initSessionState({
        cfg: { session: { store: storePath } } as OpenClawConfig,
        ctx: {
          Body: change === "reset" ? "/new" : "hello",
          SessionKey: sessionKey,
          Provider: "webchat",
          Surface: "webchat",
        },
        recordedSessionActivity: {
          sessionId: change === "session" ? "previous-session" : sessionId,
          sessionKey: change === "key" ? "agent:main:dashboard:previous" : sessionKey,
          at,
        },
      });
      expect(initialized.sessionEntry.updatedAt).toBeGreaterThan(at);
      expect(initialized.sessionEntry.lastInteractionAt).toBeGreaterThan(at);
      if (change === "reset") {
        expect(initialized.isNewSession).toBe(true);
      }
    },
  );

  it("pins an admitted non-default-agent incognito session to its process-local store", async () => {
    const stateDir = await makeCaseDir("openclaw-session-incognito-init-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "work";
      const sessionId = "incognito-work-session";
      const sessionKey = "agent:work:dashboard:incognito-work-session";
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      await upsertSessionEntryCore(
        { agentId, sessionKey, storePath },
        { sessionId, incognito: true, updatedAt: Date.now() },
      );

      try {
        await expect(
          initSessionState({
            cfg: {
              agents: { entries: { main: {}, [agentId]: {} } },
              session: { store: path.join(stateDir, "durable", "{agentId}", "sessions.json") },
            } as OpenClawConfig,
            ctx: {
              Body: "hello from incognito webchat",
              Provider: "webchat",
              SessionKey: sessionKey,
              Surface: "webchat",
            },
            expectedExistingSessionId: sessionId,
            pinExpectedExistingSession: true,
            requestedSessionId: sessionId,
            resumeRequestedSession: true,
          }),
        ).resolves.toMatchObject({
          sessionId,
          sessionKey,
          storePath,
        });
      } finally {
        memorySessionActorOwners.closeDatabase({ agentId, path: storePath });
      }
    });
  });

  it("rejects inbound work for an archived session", async () => {
    const storePath = await makeStorePath("openclaw-session-init-archived-");
    const sessionKey = "agent:main:telegram:chat:archived";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "archived-session",
        archivedAt: Date.now(),
        updatedAt: 100,
      },
    });

    await expect(
      initSessionState({
        ctx: {
          Body: "blocked while archived",
          SessionKey: sessionKey,
        },
        cfg: { session: { store: storePath } } as OpenClawConfig,
      }),
    ).rejects.toMatchObject({
      name: "SessionWorkStartError",
      reason: "archived",
      retryable: false,
      message:
        'Session "agent:main:telegram:chat:archived" is archived. Restore it before starting new work.',
    });
  });

  it("waits for real settlement when reply cancellation throws after committing abort", async () => {
    const storePath = await makeStorePath("openclaw-session-init-reset-cancel-failure-");
    const sessionKey = "agent:main:matrix:channel:cancel-failure";
    const sessionId = "committed-reset-session";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    });
    const cancellationAttempted = createDeferred();
    const cancel = vi.fn(() => {
      cancellationAttempted.resolve();
      throw new Error("backend cancellation failed");
    });
    const activeReply = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    activeReply.attachBackend({ kind: "embedded", cancel, isStreaming: () => false });
    activeReply.setPhase("running");

    try {
      const initialization = initSessionState({
        ctx: {
          Body: "/new",
          RawBody: "/new",
          CommandBody: "/new",
          From: "@owner:example.test",
          To: "!cancel-failure:example.test",
          ChatType: "channel",
          SessionKey: sessionKey,
          Provider: "matrix",
          Surface: "matrix",
        },
        cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
        commandAuthorized: true,
      });
      await cancellationAttempted.promise;
      activeReply.complete();
      const reset = await initialization;

      expect(reset.resetTriggered).toBe(true);
      expect(cancel).toHaveBeenCalledWith("restart");
      expect(isSessionRunActiveForKey(sessionKey)).toBe(false);
    } finally {
      activeReply.complete();
    }
  });
});

describe("initSessionState thread forking", () => {
  it("forks a new SQLite session from the parent session with native consent preseeded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-");
    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(root, "parent.jsonl");

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
        sandboxMode: "off",
        permissionMode: "full",
        nativeRuntimeConsent: "acp-opencode",
      },
      [threadSessionKey]: {
        sessionId: "preseed-native-session",
        updatedAt: Date.now(),
        nativeRuntimeConsent: "acp-opencode",
      },
    });

    const cfg = {
      agents: { defaults: { sandbox: { mode: "all" } } },
      session: { store: storePath },
    } as OpenClawConfig;

    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        ThreadLabel: threadLabel,
      },
      cfg,
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionId).not.toBe("preseed-native-session");
    expect(result.sessionEntry.displayName).toBe(threadLabel);
    expect(result.sessionEntry.totalTokens).toBeUndefined();
    expect(result.sessionEntry.totalTokensFresh).toBe(false);

    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.forkSource).toEqual({
      sessionKey: parentSessionKey,
      sessionId: parentSessionId,
    });
    expect(result.sessionEntry).not.toHaveProperty("sessionFile");
    expect(result.sessionEntry.permissionMode).toBeUndefined();
    expect(result.sessionEntry.nativeRuntimeConsent).toBeUndefined();
    expect(
      loadSessionEntry({ storePath, sessionKey: threadSessionKey })?.nativeRuntimeConsent,
    ).toBeUndefined();
    expect(
      resolvePreparedSandboxRuntimeStatus({
        cfg,
        sessionKey: threadSessionKey,
        preparedSessionEntry: result.sessionEntry,
      }).sandboxed,
    ).toBe(true);
    const forkCall = mockFirstRecordArg(sessionForkMocks.forkSessionFromParent, "fork session");
    expect(forkCall.parentEntry).toMatchObject({
      sessionId: parentSessionId,
    });
    expect(forkCall.parentEntry).not.toHaveProperty("sessionFile");
    warn.mockRestore();
  });

  it("forks from parent when thread session key already exists but was not forked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-existing-");
    const parentSessionId = "parent-session";
    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        updatedAt: Date.now(),
      },
      [threadSessionKey]: {
        sessionId: "preseed-thread-session",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
        abortedLastRun: true,
      },
    });
    await appendTranscriptMessage(
      { agentId: "main", sessionId: parentSessionId, sessionKey: parentSessionKey, storePath },
      { message: { role: "user", content: "Parent prompt" } },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId: parentSessionId, sessionKey: parentSessionKey, storePath },
      { message: { role: "assistant", content: "Parent reply" } },
    );

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const first = await initSessionState({
      ctx: {
        Body: "Thread reply",
        ThreadLabel: "User title",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "slack" },
      },
      cfg,
    });

    expect(first.sessionEntry.sessionId).not.toBe("preseed-thread-session");
    expect(first.sessionEntry.forkedFromParent).toBe(true);
    expect(first.sessionEntry.forkSource).toEqual({
      sessionKey: parentSessionKey,
      sessionId: parentSessionId,
    });
    expect(first.sessionEntry.totalTokens).toBeUndefined();
    expect(first.sessionEntry.totalTokensFresh).toBe(false);
    expect(first.sessionEntry.abortedLastRun).toBe(false);

    const second = await initSessionState({
      ctx: {
        Body: "Thread reply 2",
        ThreadLabel: "Changed thread label",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
    });

    expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
    expect(second.sessionEntry.displayName).toBe("User title");
    expect(second.sessionEntry.forkedFromParent).toBe(true);
    expect(second.sessionEntry.totalTokens).toBeUndefined();
    expect(second.sessionEntry.totalTokensFresh).toBe(false);
    warn.mockRestore();
  });

  it("skips fork and creates fresh session when parent tokens exceed threshold", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-");
    const parentSessionId = "parent-overflow";
    const parentSessionFile = path.join(root, "parent.jsonl");

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:456";
    // Set totalTokens well above PARENT_FORK_MAX_TOKENS (100_000)
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
        totalTokens: 170_000,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "slack" },
      },
      cfg,
    });

    // Should be marked as forked (to prevent re-attempts) but NOT actually forked from parent
    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.forkSource).toBeUndefined();
    // Session ID should NOT match the parent — it should be a fresh UUID
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    // Session file should NOT be the parent's file (it was not forked)
    expect(result.sessionEntry.sessionFile).not.toBe(parentSessionFile);
    expect(result.sessionEntry.totalTokens).toBe(0);
    expect(result.sessionEntry.totalTokensFresh).toBe(true);
  });
});

describe("initSessionState RawBody", () => {
  it.each([
    { name: "newline", trigger: "/steer", command: "/steer\n", resets: true },

    { name: "non-boundary suffix", trigger: "/steer", command: "/steering ", resets: false },

    { name: "no-argument alias with payload", trigger: "/id", command: "/id ", resets: true },
  ])(
    "matches configured reset trigger boundaries with $name",
    async ({ trigger, command, resets }) => {
      const root = await makeCaseDir("openclaw-configured-reset-boundary-");
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:telegram:dm:reset-boundary";
      const sessionId = "existing-reset-boundary-session";
      await writeSessionStoreFast(storePath, {
        [sessionKey]: { sessionId, updatedAt: Date.now(), systemSent: true },
      });
      const previous = expectDefined(loadSessionEntry({ storePath, sessionKey }), "seeded session");
      const payload = "new task\nkeep this complete instruction";
      const body = `${command}${payload}`;

      const result = await initSessionState({
        ctx: {
          RawBody: body,
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg: { session: { store: storePath, resetTriggers: [trigger] } },
        commandAuthorized: true,
      });

      expect(result.resetTriggered).toBe(resets);
      expect(result.isNewSession).toBe(resets);
      expect(result.sessionId).toBe(sessionId);
      if (resets) {
        expect(result.sessionEntry.lifecycleRevision).not.toBe(previous.lifecycleRevision);
        expect(result.bodyStripped).toBe(payload);
      } else {
        expect(result.sessionEntry.lifecycleRevision).toBe(previous.lifecycleRevision);
        expect(result.bodyStripped).toBeUndefined();
      }
      expect(result.sessionCtx.agentText).toBe(resets ? payload : body);
    },
  );

  it.each([
    {
      name: "group mention prefix and bracketed multiline payload",
      body: "@openclaw/new review [Q3]\n[Current message - respond to this]\nand explain /new syntax",
      resetTriggers: ["/new"],
      expected: "review [Q3]\n[Current message - respond to this]\nand explain /new syntax",
      omitBotUsername: true,
      sessionKey: "agent:main:whatsapp:group:g1",
    },
    {
      name: "custom trigger and command suffix",
      body: "/fresh@openclaw keep [this]\nline",
      resetTriggers: ["/fresh"],
      expected: "keep [this]\nline",
    },
    {
      name: "empty payload",
      body: "/new@openclaw",
      resetTriggers: ["/new"],
      expected: "",
      omitBotUsername: true,
    },
  ])(
    "preserves reset payloads with $name",
    async ({ body, resetTriggers, expected, omitBotUsername, sessionKey }) => {
      const storePath = await makeStorePath("openclaw-suffixed-reset-message-");
      const result = await initSessionState({
        ctx: {
          RawBody: body,
          BotUsername: omitBotUsername ? undefined : "openclaw",
          ChatType: omitBotUsername ? "group" : "direct",
          SessionKey: sessionKey ?? "agent:main:telegram:dm:s1",
        },
        cfg: {
          session: {
            store: storePath,
            resetTriggers,
          },
          messages: {
            groupChat: {
              mentionPatterns: [String.raw`@openclaw`],
            },
          },
        } as OpenClawConfig,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.bodyStripped).toBe(expected);
      expect(result.sessionCtx.agentText).toBe(expected);
    },
  );

  it("supports a bounded Body-only legacy envelope without searching flat history", async () => {
    const storePath = await makeStorePath("openclaw-body-only-reset-");
    const cfg = {
      session: { store: storePath, resetTriggers: ["/new"] },
    } as OpenClawConfig;

    const legacy = await initSessionState({
      ctx: {
        Body: "[Telegram id:456] İpek: /NEW: keep [Q3]\nline 2",
        ChatType: "direct",
        SenderName: "İpek",
        SessionKey: "agent:main:telegram:dm:legacy",
      },
      cfg,
    });
    expect(legacy.resetTriggered).toBe(true);
    expect(legacy.bodyStripped).toBe("keep [Q3]\nline 2");

    const flatHistory = await initSessionState({
      ctx: {
        Body: [
          "[Chat messages since your last reply - for context]",
          "[Telegram id:123] Other: /new old text",
          "",
          "[Current message - respond to this]",
          "[Telegram id:456] İpek: /new current text",
        ].join("\n"),
        ChatType: "direct",
        SessionKey: "agent:main:telegram:dm:flat-history",
      },
      cfg,
    });
    expect(flatHistory.resetTriggered).toBe(false);
    expect(flatHistory.bodyStripped).toBeUndefined();
  });

  it("does not treat transcript-only or explicitly empty raw text as a reset command", async () => {
    const storePath = await makeStorePath("openclaw-audio-reset-");
    const cfg = {
      session: { store: storePath, resetTriggers: ["/new"] },
    } as OpenClawConfig;

    const transcriptOnly = await initSessionState({
      ctx: {
        Body: "/new spoken payload",
        Transcript: "/new spoken payload",
        ChatType: "direct",
        SessionKey: "agent:main:whatsapp:dm:audio-transcript",
      },
      cfg,
    });
    expect(transcriptOnly.resetTriggered).toBe(false);

    const explicitEmptyRaw = await initSessionState({
      ctx: {
        Body: "/new spoken payload",
        RawBody: "",
        Transcript: "/new spoken payload",
        ChatType: "direct",
        SessionKey: "agent:main:whatsapp:dm:audio-empty-raw",
      },
      cfg,
    });
    expect(explicitEmptyRaw.triggerBodyNormalized).toBe("");
    expect(explicitEmptyRaw.resetTriggered).toBe(false);

    const explicitCommandWithEmptyRaw = await initSessionState({
      ctx: {
        Body: "/new spoken payload",
        BodyForCommands: "/new spoken payload",
        RawBody: "",
        ChatType: "direct",
        SessionKey: "agent:main:whatsapp:dm:command-empty-raw",
      },
      cfg,
    });
    expect(explicitCommandWithEmptyRaw.triggerBodyNormalized).toBe("/new spoken payload");
    expect(explicitCommandWithEmptyRaw.resetTriggered).toBe(false);
  });

  it.each([
    {
      selection: "user",
      entry: {
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideSource: "user" as const,
        agentRuntimeOverride: "native-runtime",
      },
      expected: {
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideSource: "user",
        agentRuntimeOverride: "native-runtime",
      },
    },
    {
      selection: "configured default",
      entry: { modelOverrideSource: "default" as const },
      expected: { modelOverrideSource: "default" },
    },
    {
      selection: "automatic fallback (#92562)",
      entry: {
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o-mini",
      },
      expected: { providerOverride: undefined, modelOverride: undefined },
    },
  ])(
    "preserves $selection policy and workspace across daily rollover (#90119, #159452)",
    async ({ entry, expected }) => {
      // Regression: a user-set /model override persisted on a session that then
      // goes stale at the daily reset boundary must survive the implicit
      // rollover. Previously the carryover was gated on resetTriggered, so the
      // next non-/new turn dropped the override and reverted to the default
      // model despite the "Model set to ... for this session" ack.
      const root = await makeCaseDir("openclaw-daily-rollover-model-");
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:discord:channel:daily-rollover";
      const existingSessionId = "session-before-daily-reset";
      // Stale under the configured daily reset (atHour 4): started ~48h ago so
      // sessionStartedAt < today's reset boundary.
      const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;

      const preserved = {
        thinkingLevel: "medium",
        verboseLevel: "on",
        traceLevel: "high",
        reasoningLevel: "low",
        ttsAuto: "always",
        responseUsage: "full",
        pinnedAt: 123,
        groupActivation: "always",
        label: "Other",
        autoLabel: "Device",
        displayName: "Dashboard Chat",
        deviceFolder: { deviceId: "rollover-device", path: "/existing/project" },
        pendingDeliveryNotice: {
          createdAt: staleStartedAt,
          context: { channel: "telegram", to: "chat-1", accountId: "default" },
          intentId: "intent-rollover",
          state: "owed",
        },
      } as const;
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: staleStartedAt,
          sessionStartedAt: staleStartedAt,
          lastInteractionAt: staleStartedAt,
          systemSent: true,
          ...preserved,
          ...entry,
          repositoryWorkspaceId: "repo-workspace-159452",
        },
      });

      const cfg = {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          // Ordinary message — NOT a reset trigger.
          RawBody: "hello again",
          ChatType: "channel",
          SessionKey: sessionKey,
        },
        cfg,
      });

      // The session rolled over implicitly (stale), not via /new.
      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      // The user override must survive.
      expectEntryFields(result.sessionEntry, expected);
      expect(result.sessionEntry.repositoryWorkspaceId).toBe("repo-workspace-159452");

      expect(result.sessionEntry).toMatchObject(preserved);
      const store = readSessionStoreFast(storePath);
      expect(store[sessionKey]).toMatchObject(preserved);
      expectEntryFields(expectDefined(store[sessionKey], "stored selection"), expected);
      expect(store[sessionKey]?.repositoryWorkspaceId).toBe("repo-workspace-159452");
    },
  );

  it.each([
    { trigger: "/reset", required: false },
    { trigger: "/reset", required: true },
  ] as const)(
    "preserves chat permission choices through $trigger without renewing consent (required=$required)",
    async ({ trigger, required }) => {
      const storePath = await makeStorePath("openclaw-rollover-permissions-");
      const sessionKey = "agent:main:signal:direct:rollover-permissions";
      const updatedAt = Date.now();
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: "permission-session",
          updatedAt,
          sessionStartedAt: updatedAt,
          lastInteractionAt: updatedAt,
          permissionMode: "full",
          sandboxMode: "off",
          nativeRuntimeConsent: "acp-opencode",
          ...(required ? { sandbox: "required" } : {}),
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { sandbox: { mode: "all" } } },
        session: {
          store: storePath,
          reset: { mode: "idle", idleMinutes: 60 },
        },
      };
      const result = await initSessionState({
        cfg,
        ctx: {
          RawBody: trigger,
          ChatType: "direct",
          SessionKey: sessionKey,
        },
      });
      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(true);
      const stored = expectDefined(
        loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
        "rolled-over session",
      );
      expect(stored.permissionMode).toBe("full");
      expect(stored.nativeRuntimeConsent).toBeUndefined();
      expect(
        resolvePreparedSandboxRuntimeStatus({ cfg, sessionKey, preparedSessionEntry: stored }),
      ).toMatchObject({ sandboxed: required, sandboxRequired: required });
    },
  );

  it.each([
    { trigger: "/reset", idle: false },
    { trigger: "/new", idle: false },
    { trigger: "continue", idle: true },
  ] as const)(
    "keeps a project session folder without a worktree through $trigger",
    async ({ trigger, idle }) => {
      const storePath = await makeStorePath("openclaw-rollover-project-");
      const sessionKey = "agent:main:dashboard:project-rollover";
      const updatedAt = idle ? Date.now() - 120_000 : Date.now();
      const project = {
        projectId: "project-1",
        spawnedCwd: "/work/project/packages/app",
        sessionRoot: "/work/project",
      };
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: "project-session",
          updatedAt,
          sessionStartedAt: updatedAt,
          lastInteractionAt: updatedAt,
          ...project,
        },
      });
      const result = await initSessionState({
        cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 1 } } },
        ctx: { RawBody: trigger, ChatType: "direct", SessionKey: sessionKey },
      });
      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(!idle);
      expect(result.sessionEntry).toMatchObject(project);
      expect(loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })).toMatchObject(
        project,
      );
    },
  );

  it("preserves the session-owned worktree binding across an implicit daily stale rollover (#159452)", async () => {
    // Regression: a worker-placed session's worktree reference was dropped at
    // the implicit daily/idle rollover boundary even though the underlying
    // worktree stays live, so the next worker dispatch failed with "dispatch
    // requires a session-owned workspace". A session entry cannot carry both
    // `worktree` and `repositoryWorkspaceId` (worker placement rejects that
    // combination before dispatch), so this case covers the worktree binding
    // and proves the placement boundary resolves after rollover.
    const storePath = await makeStorePath("openclaw-daily-rollover-worktree-");
    const sessionKey = "agent:main:dashboard:worktree-rollover";
    const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;
    const worktree = { id: "worktree-159452", branch: "main", repoRoot: "/repo" };

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "session-before-worktree-rollover",
        updatedAt: staleStartedAt,
        sessionStartedAt: staleStartedAt,
        lastInteractionAt: staleStartedAt,
        systemSent: true,
        worktree,
      },
    });

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        RawBody: "hello again",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.worktree).toEqual(worktree);

    const store = readSessionStoreFast(storePath) as Record<string, { worktree?: unknown }>;
    expect(store[sessionKey]?.worktree).toEqual(worktree);

    // Boundary proof: worker placement, which failed with "dispatch requires
    // a session-owned workspace" before the fix, now resolves the rolled-over
    // entry against its live worktree.
    setRuntimeConfigSnapshot(cfg, cfg);
    onTestFinished(clearRuntimeConfigSnapshot);
    using placement = await resolveWorkerPlacementSessionTarget({
      sessionRuntime: {
        resolveGatewaySessionStoreTargetInWorker,
        resolveCanonicalSessionEntryFromStoreKeys,
        managedWorktrees: {
          findLiveByOwner: async (_kind, ownerId) => ({
            id: worktree.id,
            ownerId,
            path: worktree.repoRoot,
          }),
        },
      },
      config: cfg,
      sessionId: result.sessionEntry.sessionId,
      sessionKey,
      agentId: "main",
      errorMessage: "placement identity changed",
    });
    expect(placement.workspace).toEqual({ kind: "local", path: worktree.repoRoot });
  });

  it.each(["required"] as const)(
    "stamps trusted creation provenance for a new session (sandbox=%s)",
    async (sandbox) => {
      const root = await makeCaseDir("openclaw-session-creation-provenance-");
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:dashboard:created";

      const result = await withEnvAsync(
        { OPENCLAW_STATE_DIR: path.join(root, "state") },
        async () => {
          const initialized = await initSessionState({
            ctx: {
              RawBody: "hello",
              ChatType: "direct",
              SessionKey: sessionKey,
              SessionCreation: {
                via: "operator",
                actor: { type: "human", id: "profile-ada" },
                sandbox,
              },
            },
            cfg: { session: { store: storePath } } as OpenClawConfig,
          });
          const { events } = await listSessionStateEventsSince(sessionKey, "main", 0, 20);
          expect(events.find((event) => event.kind === "created")).toMatchObject({
            actorType: "human",
            actorId: "profile-ada",
          });
          expect(
            listSessionParticipantsReadOnly({ agentId: "main", storePath }).get(sessionKey),
          ).toBeUndefined();
          expect(
            loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })?.sandbox,
          ).toBe(sandbox);
          await initSessionState({
            ctx: {
              RawBody: "another participant",
              ChatType: "direct",
              SessionKey: sessionKey,
              SessionCreation: {
                via: "operator",
                actor: { type: "human", id: "profile-other" },
                sandbox: "required",
              },
            },
            cfg: { session: { store: storePath } } as OpenClawConfig,
          });
          const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
          expect(persisted).toMatchObject({
            createdActor: { type: "human", id: "profile-ada" },
            createdAt: initialized.sessionEntry.createdAt,
          });
          expect(persisted?.sandbox).toBe(sandbox);
          expect(
            listSessionParticipantsReadOnly({ agentId: "main", storePath }).get(sessionKey),
          ).toBeUndefined();
          return initialized;
        },
      );
      expect(result.sessionEntry).toMatchObject({
        createdVia: "operator",
        createdActor: { type: "human", id: "profile-ada" },
        createdAt: expect.any(Number),
      });
      expect(result.sessionEntry.sandbox).toBe(sandbox);
    },
  );

  it("records accepted inputs once and keeps creation hints separate from participation", async () => {
    await expectSessionParticipantInputs(
      await makeCaseDir("openclaw-session-participant-admission-"),
    );
  });

  it.each(SESSION_ROLLOVER_LINEAGE_CASES)(
    "keeps spawned-run lineage only for a $name rollover",
    async (testCase) => {
      const storePath = await makeStorePath("openclaw-daily-rollover-lineage-");
      const sessionKey = testCase.sessionKey;
      const existingSessionId = "session-before-daily-reset-lineage";
      const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;
      const spawnLineage = createSessionRolloverSpawnLineage(testCase);
      const threadProvenance = {
        parentSessionKey: "agent:main:main",
        parentSessionId: "parent-session",
        parentSessionLifecycleRevision: "parent-generation",
        forkedFromParent: true,
        forkSource: {
          sessionKey: "agent:main:root",
          sessionId: "root-transcript-generation",
        },
        createdVia: testCase.createdVia,
        createdActor: { type: "agent", id: "agent:main:main" },
        createdAt: staleStartedAt - 1_000,
        sandbox: "required",
      } as const;

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: staleStartedAt,
          sessionStartedAt: staleStartedAt,
          lastInteractionAt: staleStartedAt,
          ...threadProvenance,
          ...spawnLineage,
        },
      });

      const result = await initSessionState({
        ctx: {
          RawBody: "continue child work",
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg: {
          session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
        } as OpenClawConfig,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionEntry.previousSessionId).toBeUndefined();
      expectEntryFields(result.sessionEntry, threadProvenance);
      if (testCase.preservesSpawnLineage) {
        expectEntryFields(result.sessionEntry, spawnLineage);
      } else {
        for (const field of Object.keys(spawnLineage)) {
          expect(result.sessionEntry).not.toHaveProperty(field);
        }
      }
    },
  );

  it("prefers native command target sessions over bound slash sessions", async () => {
    const storePath = await makeStorePath("native-command-target-session-");
    const boundSlashSessionKey = "slack:slash:123";
    const targetSessionKey = "agent:main:main";
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: "slack",
      accountId: "default",
    });
    await getSessionBindingService().bind({
      targetSessionKey: boundSlashSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "channel:ops",
      },
      placement: "current",
    });

    const result = await initSessionState({
      ctx: {
        Body: `/model openai/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        CommandBody: `/model openai/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        Provider: "slack",
        Surface: "slack",
        AccountId: "default",
        SenderId: "U123",
        From: "slack:U123",
        To: "channel:ops",
        OriginatingTo: "channel:ops",
        SessionKey: boundSlashSessionKey,
        CommandSource: "native",
        CommandTargetSessionKey: targetSessionKey,
      },
      cfg,
    });

    expect(result.sessionKey).toBe(targetSessionKey);
    expect(result.sessionCtx.SessionKey).toBe(targetSessionKey);
  });

  it.each([
    { name: "adopted agent target", targetSessionKey: "agent:main:external-runtime:thread-17" },

    {
      name: "ACP unbind",
      targetSessionKey: "agent:claude:acp:thread-17",
      command: "/session unbind",
    },
    {
      name: "ACP reset",
      targetSessionKey: "agent:claude:acp:thread-17",
      command: "/new",
      reset: true,
    },
  ])("keeps escaped commands on the core session for $name", async (scenario) => {
    const { targetSessionKey } = scenario;
    const command = "command" in scenario ? scenario.command : "/fixture status";
    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({ channel: "slack", accountId: "default" });
    const storePath = await makeStorePath("openclaw-plugin-command-session-");
    const sourceSessionKey = "agent:main:slack:source";
    const sourceSessionId = "source-command-session";
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    };
    await writeSessionStoreFast(storePath, {
      [sourceSessionKey]: { sessionId: sourceSessionId, updatedAt: Date.now() },
    });
    if (targetSessionKey.startsWith("agent:")) {
      await writeSessionStoreFast(storePath, {
        [targetSessionKey]: {
          sessionId: "plugin-owned-session",
          updatedAt: Date.now(),
          label: "Plugin-owned state must remain untouched",
        },
      });
    }
    const targetBefore = { ...readSessionStoreFast(storePath) }[targetSessionKey];
    const binding = await getSessionBindingService().bind({
      targetSessionKey,
      targetKind: "session",
      conversation,
      metadata:
        "command" in scenario
          ? undefined
          : {
              pluginBindingOwner: "plugin",
              pluginId: "fixture-runtime",
              pluginRoot: "/plugins/fixture-runtime",
            },
    });
    const ctx = {
      Body: command,
      RawBody: command,
      CommandBody: command,
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: sourceSessionKey,
      Provider: "slack",
      Surface: "slack",
      AccountId: "default",
      From: "slack:user:U123",
      To: "user:U123",
      OriginatingTo: "user:U123",
      SenderId: "U123",
      ChatType: "direct",
    };
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx,
      cfg,
      expectedExistingSessionId: sourceSessionId,
      pinExpectedExistingSession: true,
    });

    expect(result.sessionKey).toBe(sourceSessionKey);
    expect(result.sessionId).toBe(sourceSessionId);
    if ("reset" in scenario) {
      // The bound ACP handler owns reset; preprocessing must not rotate its transport session.
      expect(result.resetTriggered).toBe(false);
      expect(result.isNewSession).toBe(false);
    }
    expect(result.sessionCtx.SessionKey).toBe(sourceSessionKey);
    expect(
      await resolveReplySessionPreprocessingState({ cfg, ctx: finalizeInboundContext(ctx) }),
    ).toMatchObject({
      sessionKey: sourceSessionKey,
      sessionEntry: { sessionId: result.sessionId },
    });
    expect({ ...readSessionStoreFast(storePath) }[targetSessionKey]).toEqual(targetBefore);
    expect(getSessionBindingService().resolveByConversation(conversation)).toEqual(binding);
  });

  it("does not apply a source admission id to a bound conversation target", async () => {
    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: "slack",
      accountId: "default",
    });
    const storePath = await makeStorePath("openclaw-bound-admission-id-");
    const sourceSessionKey = "agent:main:slack:source";
    const sourceSessionId = "source-admission-session";
    const boundSessionKey = "agent:main:plugin-binding:codex:bound-target";
    const boundSessionId = "bound-target-session";
    await writeSessionStoreFast(storePath, {
      [sourceSessionKey]: { sessionId: sourceSessionId, updatedAt: Date.now() },
      [boundSessionKey]: { sessionId: boundSessionId, updatedAt: Date.now() },
    });
    await getSessionBindingService().bind({
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "hello",
        SessionKey: sourceSessionKey,
        Provider: "slack",
        Surface: "slack",
        From: "slack:user:U123",
        To: "user:U123",
        OriginatingTo: "user:U123",
        SenderId: "U123",
        ChatType: "direct",
      },
      cfg: { session: { store: storePath } } as OpenClawConfig,
      expectedExistingSessionId: sourceSessionId,
      pinExpectedExistingSession: true,
      newlyCreatedSessionId: sourceSessionId,
    });

    expect(result.sessionKey).toBe(boundSessionKey);
    expect(result.sessionId).toBe(boundSessionId);
    expect(result.isNewSession).toBe(false);
  });
});

describe("initSessionState reset policy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "pins a durably admitted session across an idle reset boundary",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-pinned-admission",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      expectedExistingSessionId: "existing",
      pinExpectedExistingSession: true,
      expectedNew: false,
    },
    {
      name: "reuses an idle-expired session when a reconnecting client requests current session resume",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-requested-session",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      requestedSessionId: "existing",
      resumeRequestedSession: true,
      expectedNew: false,
    },
    {
      name: "does not reuse an idle-expired session for a stale asserted session id",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-stale-requested-session",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      requestedSessionId: "stale",
      resumeRequestedSession: true,
      expectedNew: true,
    },
  ])("$name", async (scenario) => {
    vi.setSystemTime(scenario.now);
    const storePath = await makeStorePath(`openclaw-reset-${scenario.slug}-`);
    const sessionKey = scenario.slug.startsWith("idle-")
      ? "agent:main:main"
      : `agent:main:whatsapp:dm:${scenario.slug}`;
    const existingSessionId = `${scenario.slug}-session-id`;
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: scenario.updatedAt },
    });

    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey, Provider: "internal", Surface: "internal" },
      cfg: { session: { store: storePath, ...scenario.session } } as OpenClawConfig,
      requestedSessionId:
        "requestedSessionId" in scenario && scenario.requestedSessionId === "existing"
          ? existingSessionId
          : "requestedSessionId" in scenario && scenario.requestedSessionId === "stale"
            ? "webchat-stale-session-id"
            : undefined,
      resumeRequestedSession:
        "resumeRequestedSession" in scenario ? scenario.resumeRequestedSession : undefined,
      expectedExistingSessionId:
        "expectedExistingSessionId" in scenario ? existingSessionId : undefined,
      pinExpectedExistingSession:
        "pinExpectedExistingSession" in scenario ? scenario.pinExpectedExistingSession : undefined,
    });

    expect(result.isNewSession).toBe(scenario.expectedNew);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it.each([
    {
      name: "non-main terminal rows ignore later transcript mutations",
      sessionKey: "agent:main:whatsapp:dm:terminal-entry",
      updatedAtOffsetMs: -5_000,
      endedAtOffsetMs: -6_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: false,
    },

    {
      name: "main killed terminal rows rotate after a later transcript mutation",
      sessionKey: "agent:main:main",
      status: "killed" as const,
      updatedAtOffsetMs: -10_000,
      endedAtOffsetMs: -11_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: true,
    },

    {
      name: "failed main terminal rows recover on visible turns when the transcript exists",
      sessionKey: "agent:main:main",
      status: "failed" as const,
      updatedAtOffsetMs: -10_000,
      endedAtOffsetMs: -11_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: false,
      expectRecovered: true,
    },
  ])("$name", async (scenario) => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-terminal-entry-");
    const storePath = path.join(root, "sessions.json");
    const existingSessionId = "terminal-entry-old";
    const now = Date.now();
    const terminalUpdatedAt = now + scenario.updatedAtOffsetMs;
    const terminalEndedAt = now + scenario.endedAtOffsetMs;
    await writeTerminalTranscriptSessionStore({
      storePath,
      sessionKey: scenario.sessionKey,
      sessionId: existingSessionId,
      status: scenario.status,
      updatedAt: terminalUpdatedAt,
      endedAt: terminalEndedAt,
      transcriptMutationOrder: scenario.transcriptMutationOrder,
    });

    if (scenario.expectRecovered) {
      await upsertSessionEntryCore(
        { storePath, sessionKey: scenario.sessionKey },
        { abortedLastRun: true },
      );
    }

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: scenario.sessionKey },
      cfg,
    });

    expect(result.isNewSession).toBe(scenario.expectNewSession);
    const persisted = readSessionStoreFast(storePath);
    const entry = persisted[scenario.sessionKey];
    if (scenario.expectNewSession) {
      expect(result.sessionId).toBe(existingSessionId);
      expect(entry?.sessionId).toBe(existingSessionId);
      expect(entry?.status).toBeUndefined();
      expect(entry?.startedAt).toBeUndefined();
      expect(entry?.endedAt).toBeUndefined();
      expect(entry?.runtimeMs).toBeUndefined();
    } else if (scenario.expectRecovered) {
      expect(result.abortedLastRun).toBe(false);
      expect(entry?.abortedLastRun).toBeUndefined();
      expect(result.sessionId).toBe(existingSessionId);
      expect(entry?.status).toBeUndefined();
      expect(entry?.startedAt).toBeUndefined();
      expect(entry?.endedAt).toBeUndefined();
      expect(entry?.runtimeMs).toBeUndefined();
    } else {
      expect(result.sessionId).toBe(existingSessionId);
      expect(entry?.status).toBe(scenario.status ?? "done");
      expect(entry?.endedAt).toBe(terminalEndedAt);
    }
  });

  it.each([true, false])(
    "applies stale /reset soft only when authorized (%s)",
    async (authorized) => {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
      const storePath = await makeStorePath("openclaw-reset-soft-stale-");
      const sessionKey = "agent:main:whatsapp:dm:soft-stale";
      const existingSessionId = "soft-stale-session-id";

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
        },
      });

      const cfg = {
        session: {
          store: storePath,
          reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
        },
      } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "/reset soft",
          RawBody: "/reset soft",
          CommandBody: "/reset soft",
          ...(!authorized ? { Provider: "whatsapp", Surface: "whatsapp" } : {}),
          SessionKey: sessionKey,
        },
        cfg,
        ...(!authorized ? { commandAuthorized: false } : {}),
      });

      expect(result.resetTriggered).toBe(false);
      expect(result.isNewSession).toBe(!authorized);
      expect(result.sessionId).toBe(existingSessionId);
    },
  );
});

describe("initSessionState browser tab cleanup", () => {
  it("includes the peer-scoped runtime key for direct-message cleanup", async () => {
    const storePath = await makeStorePath("openclaw-tab-cleanup-peer-key-");
    const canonicalKey = "agent:main:main";
    const existingSessionId = "tab-peer-key-session-id";
    await writeSessionStoreFast(storePath, {
      [canonicalKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "12345",
        Provider: "telegram",
        ChatType: "direct",
      },
      cfg,
    });

    expect(result.isNewSession).toBe(true);
    const cleanupParams = mockFirstRecordArg(
      browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
      "closeTrackedBrowserTabsForSessions",
    );
    expect(cleanupParams.sessionKeys).toEqual([
      `agent:main:${existingSessionId}`,
      canonicalKey,
      "agent:main:telegram:default:direct:12345",
    ]);
  });
});

describe("initSessionState reset authorization", () => {
  it.each<{
    name: string;
    body?: string;
    source?: "text" | "native";
    feishuDirect?: boolean;
    admitted?: boolean;
    enforceOwner?: boolean;
    senderId?: string;
    allowFrom?: Record<string, string[]>;
    scopes?: string[];
    allowed: boolean;
    generalAuthorized?: boolean;
  }>([
    { name: "channel-admitted non-owner /reset", body: "/reset", allowed: true },

    {
      name: "Feishu per-channel-peer DM /new",
      feishuDirect: true,
      senderId: "ou_guest",
      allowed: true,
    },

    ...["/reset soft Create a note"].map((body) => ({
      name: `non-admitted sender stays silent for ${body}`,
      body,
      admitted: false,
      allowed: false,
    })),
    { name: "unrelated provider command policy", allowFrom: { telegram: [] }, allowed: true },
    {
      name: "empty provider command allowlist overrides global grant",
      allowFrom: { "*": ["*"], buzz: [] },
      allowed: false,
    },
    {
      name: "explicit command grant without channel admission",
      admitted: false,
      allowFrom: { buzz: ["guest"] },
      allowed: true,
      generalAuthorized: true,
    },

    {
      name: "native wildcard does not bypass plugin owner enforcement",
      source: "native",
      enforceOwner: true,
      allowFrom: { "*": ["*"] },
      allowed: false,
    },
    {
      name: "plugin owner can reset",
      enforceOwner: true,
      senderId: "owner",
      allowed: true,
      generalAuthorized: true,
    },
    { name: "internal operator.write cannot reset", scopes: ["operator.write"], allowed: false },
    {
      name: "internal operator.admin can reset",
      scopes: ["operator.admin"],
      allowed: true,
      generalAuthorized: true,
    },
  ])(
    "keeps durable reset and acknowledgement consistent: $name",
    async ({
      body = "/new",
      source = "text",
      feishuDirect = false,
      admitted = true,
      enforceOwner = false,
      senderId = "guest",
      allowFrom,
      scopes,
      allowed,
      generalAuthorized = false,
    }) => {
      const provider = feishuDirect
        ? "feishu"
        : scopes
          ? "webchat"
          : enforceOwner
            ? "whatsapp"
            : "buzz";
      const storePath = await makeStorePath("openclaw-reset-authority-");
      const cfg = {
        session: {
          store: storePath,
          idleMinutes: 999,
          ...(feishuDirect ? { dmScope: "per-channel-peer" } : {}),
        },
        channels: { [provider]: { allowFrom: ["*"] } },
        commands: { ownerAllowFrom: ["owner"], allowFrom },
      } as OpenClawConfig;
      const route = resolveAgentRoute({
        cfg,
        channel: provider,
        accountId: "default",
        peer: feishuDirect
          ? { kind: "direct", id: senderId }
          : { kind: "group", id: "reset-authority" },
      });
      const sessionKey = route.sessionKey;
      const siblingSessionKey = feishuDirect
        ? resolveAgentRoute({
            cfg,
            channel: "feishu",
            accountId: "default",
            peer: { kind: "direct", id: "ou_other" },
          }).sessionKey
        : undefined;
      const existingSessionId = "existing-reset-session";
      const lifecycleRevision = "before-reset";
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          lifecycleRevision,
          updatedAt: Date.now(),
          cliSessionIds: { "claude-cli": "existing-cli-binding" },
        },
        ...(siblingSessionKey
          ? {
              [siblingSessionKey]: {
                sessionId: "untouched-peer-session",
                lifecycleRevision: "untouched-peer-generation",
                updatedAt: Date.now(),
              },
            }
          : {}),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: provider,
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: provider, label: provider }),
              commands: { enforceOwnerForCommands: enforceOwner },
            },
          },
        ]),
      );
      try {
        const ctx = finalizeInboundContext({
          Body: body,
          RawBody: body,
          CommandBody: body,
          CommandSource: source,
          CommandAuthorized: admitted,
          SenderId: senderId,
          From: feishuDirect ? "feishu:" + senderId : provider + ":group:reset-authority",
          To: feishuDirect ? "user:" + senderId : "bot",
          ChatType: feishuDirect ? "direct" : "group",
          AccountId: "default",
          SessionKey: sessionKey,
          Provider: provider,
          Surface: provider,
          GatewayClientScopes: scopes,
        });
        const initialized = await initSessionState({ ctx, cfg, commandAuthorized: admitted });
        const command = buildCommandContext({
          ctx,
          cfg,
          agentId: "main",
          sessionKey,
          isGroup: initialized.isGroup,
          triggerBodyNormalized: initialized.triggerBodyNormalized,
          commandAuthorized: admitted,
        });
        const acknowledgement = await maybeHandleResetCommand({
          ...initialized,
          ctx,
          cfg,
          command,
          agentId: "main",
          directives: parseInlineSessionDirectives(""),
          elevated: { enabled: false, allowed: false, failures: [] },
          workspaceDir: path.dirname(storePath),
          defaultGroupActivation: () => "mention",
          resolvedVerboseLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          provider: "openai",
          model: "test-model",
          contextTokens: 0,
        });
        const stored = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
        const resets = (
          await loadTranscriptEvents({ storePath, sessionId: existingSessionId })
        ).filter((event) => isRecord(event) && event.type === "reset");
        expect.soft(command.isAuthorizedSender).toBe(generalAuthorized);
        expect
          .soft(command.senderIsOwner)
          .toBe(senderId === "owner" || scopes?.includes("operator.admin") === true);
        expect.soft(initialized.resetTriggered).toBe(allowed);
        expect.soft(initialized.isNewSession).toBe(allowed);
        expect.soft(initialized.isGroup).toBe(!feishuDirect);
        expect.soft(initialized.sessionKey).toBe(sessionKey);
        if (siblingSessionKey) {
          expect.soft(route.dmScope).toBe("per-channel-peer");
          expect.soft(sessionKey).not.toBe(route.mainSessionKey);
          expect.soft(siblingSessionKey).not.toBe(sessionKey);
          expect
            .soft(
              loadSessionEntry({
                storePath,
                sessionKey: siblingSessionKey,
                readConsistency: "latest",
              }),
            )
            .toMatchObject({
              sessionId: "untouched-peer-session",
              lifecycleRevision: "untouched-peer-generation",
            });
        }
        expect.soft(stored?.sessionId).toBe(existingSessionId);
        expect.soft(stored?.lifecycleRevision !== lifecycleRevision).toBe(allowed);
        expect
          .soft(stored?.cliSessionIds)
          .toEqual(allowed ? undefined : { "claude-cli": "existing-cli-binding" });
        expect.soft(resets).toHaveLength(allowed ? 1 : 0);
        if (allowed) {
          expect.soft(resets[0]).toMatchObject({ type: "reset", reason: body.slice(1) });
        }
        expect.soft(acknowledgement?.shouldContinue).toBe(false);
        if (allowed) {
          expect.soft(acknowledgement?.reply).toEqual({
            text: body === "/new" ? "✅ New session started." : "✅ Session reset.",
            isStatusNotice: true,
          });
        } else if (scopes) {
          expect.soft(acknowledgement?.reply?.text).toMatch(/not authorized/i);
          expect.soft(acknowledgement?.reply?.text).toContain("operator.admin");
        } else {
          expect.soft(acknowledgement?.reply).toBeUndefined();
        }
      } finally {
        resetPluginRuntimeStateForTest();
      }
    },
  );
});

describe("initSessionState reset triggers in Slack channels", () => {
  it("supports mention-prefixed Slack reset commands and preserves args", async () => {
    setMinimalCurrentConversationBindingRegistryForTests();
    const existingSessionId = "existing-session-123";
    const sessionKey = "agent:main:slack:channel:c2";
    const body = "<@U123> /new take notes";
    const storePath = await makeStorePath("openclaw-slack-channel-new-");
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        BodyForCommands: "/new take notes",
        CommandBody: body,
        From: "slack:channel:C1",
        To: "channel:C1",
        ChatType: "channel",
        SessionKey: sessionKey,
        Provider: "slack",
        Surface: "slack",
        SenderId: "U123",
        SenderName: "Owner",
        WasMentioned: true,
      },
      cfg,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.bodyStripped).toBe("take notes");
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  it("rejects replacement of a model-locked session", async () => {
    const storePath = await makeStorePath("openclaw-reset-model-locked-");
    const sessionKey = "agent:main:telegram:dm:tombstone-model-locked";
    const existingSessionId = "existing-tombstone-model-locked-session";
    const existingEntry = {
      sessionId: existingSessionId,
      updatedAt: Date.now(),
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      status: "failed" as const,
      pluginExtensions: {
        codex: { threadId: "codex-thread-1" },
      },
    };
    await writeSessionStoreFast(storePath, { [sessionKey]: existingEntry });

    await expect(
      initSessionState({
        ctx: telegramTurn(sessionKey, "/new", "model-locked"),
        cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_RESET_MESSAGE);

    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(existingEntry);
  });

  it("does not implicitly expire a model-locked session", async () => {
    const storePath = await makeStorePath("openclaw-expiry-model-locked-");
    const sessionKey = "agent:main:telegram:dm:model-locked-expiry";
    const existingSessionId = "existing-model-locked-expiry-session";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 60 * 60 * 1000,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: { threadId: "codex-thread-expiry" },
        },
      },
    });

    const result = await initSessionState({
      ctx: telegramTurn(sessionKey, "continue", "model-locked-expiry"),
      cfg: {
        session: { store: storePath, idleMinutes: 1 },
      } as OpenClawConfig,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: { threadId: "codex-thread-expiry" },
      },
    });
  });

  it.each([
    {
      name: "selected model, auth profile, and runtime caches",
      preserved: {
        providerOverride: "minimax",
        modelOverride: "m2.7",
        verboseLevel: "on",
        category: "Channels",
        icon: "🦞",
        color: "blue",
        pinnedAt: 123,
        deviceFolder: { deviceId: "rollover-device", path: "/existing/project" },
        authProfileOverride: "20251001",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
        usageFamilyKey: "family:reset-model-selection",
        usageFamilySessionIds: ["ancestor-session", "existing-model-selection"],
      },
      removed: {
        visibility: "draft",
        boardFace: "dashboard",
        boardPresentation: "expanded",
        cliSessionIds: { "claude-cli": "cli-session-123" },
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-123", authProfileId: "anthropic:default" },
        },
        claudeCliSessionId: "cli-session-123",
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: Date.now(),
          provider: "anthropic",
          model: "claude-sonnet-4.6",
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 64_000,
          contextTokenBudget: 128_000,
          promptBudgetBeforeReserve: 112_000,
          reserveTokens: 16_000,
          effectiveReserveTokens: 16_000,
          remainingPromptBudgetTokens: 48_000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 8,
          unwindowedMessageCount: 8,
        },
        memoryFlush: { kind: "failed", compactionCount: 2, failureCount: 3 },
        skillsSnapshot: {
          prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
          skills: [{ name: "stale" }],
          version: 0,
        },
        modelProvider: "openai",
        model: "gpt-5.4-mini",
        contextTokens: 400_000,
        contextTokensSource: "runtime",
        cacheRead: 1_000,
        cacheWrite: 2_000,
        fallbackNotice: {
          kind: "active",
          selectedModel: "openai/gpt-5.4-mini",
          activeModel: "minimax/m2.7",
          reason: "rate limit",
        },
        systemPromptReport: {
          source: "run",
          generatedAt: 1,
          provider: "openai",
          model: "gpt-5.4-mini",
          systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      },
    },
  ])("resets $name across /new and /reset", async ({ preserved, removed }) => {
    const storePath = await makeStorePath("openclaw-reset-model-selection-");
    const sessionKey = "agent:main:telegram:dm:reset-model-selection";
    const sessionId = "existing-model-selection";
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId,
      entry: {
        ...preserved,
        ...removed,
        totalTokens: 64_000,
        totalTokensFresh: false,
        compactionCount: 3,
      },
    });
    const expected = {
      ...preserved,
      ...Object.fromEntries(Object.keys(removed).map((key) => [key, undefined])),
      totalTokens: 0,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    for (const { name, result, stored } of cases) {
      expect(result, name).toMatchObject({ isNewSession: true, resetTriggered: true, sessionId });
      expectEntryFields(result.sessionEntry, expected, name);
      expectEntryFields(
        expectDefined(stored[sessionKey], "stored model selection"),
        expected,
        name,
      );
    }
  });

  it("requires operator.admin when Provider is internal even if Surface carries external metadata", async () => {
    const storePath = await makeStorePath("openclaw-internal-reset-provider-authoritative-");
    const sessionKey = "agent:main:telegram:dm:provider-authoritative";
    const existingSessionId = "existing-session-provider-authoritative";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        Provider: "webchat",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        GatewayClientScopes: ["operator.write"],
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it.each(["/new"] as const)(
    "retains the transcript but clears prior context on %s",
    async (command) => {
      const slug = command.slice(1);
      const storePath = await makeStorePath(`openclaw-archive-old-${slug}-`);
      const sessionKey = `agent:main:telegram:dm:user-archive-${slug}`;
      const existingSessionId = `existing-session-archive-${slug}`;
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: Date.now(),
          verboseLevel: "on",
        },
      });
      await appendTranscriptMessage(
        { agentId: "main", sessionId: existingSessionId, sessionKey, storePath },
        { message: { role: "user", content: "kept question" } },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId: existingSessionId, sessionKey, storePath },
        { message: { role: "assistant", content: "kept answer" } },
      );

      const cfg = {
        session: { store: storePath, idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: telegramTurn(sessionKey, command, "user-archive"),
        cfg,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(true);
      expect(result.sessionId).toBe(existingSessionId);
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: existingSessionId,
        sessionKey,
        storePath,
      });
      const resetEvent = events.findLast((event) => (event as { type?: unknown }).type === "reset");
      expect(resetEvent).toMatchObject({ reason: slug });
      expect(resetEvent).not.toHaveProperty("firstKeptEntryId");
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    },
  );

  it("keeps the initiating reply admission during an in-band rollover", async () => {
    const storePath = await makeStorePath("openclaw-rollover-initiator-");
    const sessionKey = "agent:main:telegram:dm:rollover-initiator";
    const existingSessionId = "session-before-initiating-rollover";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now() },
    });
    const onInterrupt = vi.fn();
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, existingSessionId],
      assertAllowed: () => {},
      onInterrupt,
    });

    try {
      const result = await admission.run(
        async () =>
          await initSessionState({
            ctx: telegramTurn(sessionKey, "/reset", "user-rollover-initiator"),
            cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
          }),
      );
      expect(result.sessionId).toBe(existingSessionId);
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  });

  it("cancels a competing admitted rollover without deadlocking the session", async () => {
    const storePath = await makeStorePath("openclaw-rollover-contenders-");
    const sessionKey = "agent:main:telegram:dm:rollover-contenders";
    const existingSessionId = "session-before-competing-rollovers";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now() },
    });
    const controllers = [new AbortController(), new AbortController()];
    const admissions = await Promise.all(
      controllers.map(
        async (controller) =>
          await beginSessionEffect({
            scope: storePath,
            identities: [sessionKey, existingSessionId],
            assertAllowed: () => {},
            onInterrupt: () => controller.abort(new Error("competing rollover interrupted")),
          }),
      ),
    );
    const runRollover = async (index: number) => {
      const admission = expectDefined(admissions[index], "admissions[index] test invariant");
      const controller = expectDefined(controllers[index], "controllers[index] test invariant");
      try {
        return await admission.run(
          async () =>
            await initSessionState({
              ctx: telegramTurn(sessionKey, "/new", `user-rollover-contender-${index}`),
              cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
              signal: controller.signal,
            }),
        );
      } finally {
        admission.release();
      }
    };

    const outcomes = await Promise.allSettled([runRollover(0), runRollover(1)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(readSessionStoreFast(storePath)[sessionKey]?.sessionId).toBe(existingSessionId);
  });

  it.each([
    {
      name: "reuses a fresh replacement without interrupting its work",
      body: "continue",
      expectedInterruption: false,
    },
    {
      name: "reacquires a changed identity before an explicit reset",
      body: "/new",
      expectedInterruption: true,
    },
  ])("$name", async ({ body, expectedInterruption }) => {
    const storePath = await makeStorePath("openclaw-rollover-revalidation-");
    const sessionKey = "agent:main:telegram:dm:rollover-revalidation";
    const staleSessionId = "stale-session-before-revalidation";
    const replacementSessionId = "fresh-replacement-before-revalidation";
    const postDrainSessionId = "replacement-created-during-drain";
    const finalGapSessionId = "replacement-created-before-destructive-write";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: staleSessionId,
        updatedAt: Date.now() - 10 * 60_000,
      },
    });

    let replacementInterrupted = false;
    let replacementIdentityFenced = false;
    let postDrainIdentityFenced = false;
    let finalGapIdentityFenced = false;
    let postDrainAdmission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    let finalGapAdmission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    let postDrainFinalization = Promise.resolve();
    let finalGapRebind = Promise.resolve();
    let releaseReplacementAdmission = () => {};
    const replacementAdmission = await beginSessionEffect({
      scope: storePath,
      identities: [replacementSessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        replacementInterrupted = true;
        replacementIdentityFenced = isSessionMutationActive(storePath, [replacementSessionId]);
        if (!expectedInterruption) {
          releaseReplacementAdmission();
          return;
        }
        postDrainFinalization = runExclusiveSessionStoreWrite(storePath, async () => {
          await writeSessionStoreFast(storePath, {
            [sessionKey]: { sessionId: postDrainSessionId, updatedAt: Date.now() },
          });
        })
          .then(async () => {
            let releasePostDrainAdmission = () => {};
            postDrainAdmission = await beginSessionEffect({
              scope: storePath,
              identities: [postDrainSessionId],
              assertAllowed: () => {},
              onInterrupt: () => {
                postDrainIdentityFenced = isSessionMutationActive(storePath, [postDrainSessionId]);
                releasePostDrainAdmission();
                finalGapRebind = runExclusiveSessionStoreWrite(storePath, async () => {
                  await writeSessionStoreFast(storePath, {
                    [sessionKey]: { sessionId: finalGapSessionId, updatedAt: Date.now() },
                  });
                  let releaseFinalGapAdmission = () => {};
                  finalGapAdmission = await beginSessionEffect({
                    scope: storePath,
                    identities: [finalGapSessionId],
                    assertAllowed: () => {},
                    onInterrupt: () => {
                      finalGapIdentityFenced = isSessionMutationActive(storePath, [
                        finalGapSessionId,
                      ]);
                      releaseFinalGapAdmission();
                    },
                  });
                  releaseFinalGapAdmission = finalGapAdmission.release;
                });
              },
            });
            releasePostDrainAdmission = postDrainAdmission.release;
          })
          .finally(releaseReplacementAdmission);
      },
    });
    releaseReplacementAdmission = replacementAdmission.release;

    const { resolve: signalMutationStarted, promise: mutationStarted } = createDeferred();
    const { resolve: releaseMutation, promise: mutationGate } = createDeferred();
    const blockingMutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, staleSessionId],
      run: async () => {
        signalMutationStarted();
        await mutationGate;
      },
    });
    await mutationStarted;

    const { resolve: signalWriterStarted, promise: writerStarted } = createDeferred();
    const { resolve: releaseWriter, promise: writerGate } = createDeferred();
    const blockingWriter = runExclusiveSessionStoreWrite(storePath, async () => {
      signalWriterStarted();
      await writerGate;
    });
    await writerStarted;

    const initialization = initSessionState({
      ctx: telegramTurn(sessionKey, body, "user-rollover-revalidation"),
      cfg: {
        session: { store: storePath, reset: { mode: "idle", idleMinutes: 1 } },
      } as OpenClawConfig,
    });
    const replaceSession = runExclusiveSessionStoreWrite(storePath, async () => {
      await writeSessionStoreFast(storePath, {
        [sessionKey]: { sessionId: replacementSessionId, updatedAt: Date.now() },
      });
    });

    try {
      releaseWriter();
      await blockingWriter;
      await replaceSession;
      releaseMutation();
      await blockingMutation;

      const result = await initialization;
      await postDrainFinalization;
      await finalGapRebind;
      expect(replacementInterrupted).toBe(expectedInterruption);
      if (expectedInterruption) {
        expect(replacementIdentityFenced).toBe(true);
        expect(postDrainIdentityFenced).toBe(true);
        expect(finalGapIdentityFenced).toBe(true);
        expect(result.sessionId).toBe(finalGapSessionId);
      } else {
        expect(result.sessionId).toBe(replacementSessionId);
      }
    } finally {
      releaseWriter();
      releaseMutation();
      replacementAdmission.release();
      postDrainAdmission?.release();
      finalGapAdmission?.release();
      await Promise.allSettled([blockingWriter, replaceSession, blockingMutation, initialization]);
      await postDrainFinalization.catch(() => {});
      await finalGapRebind.catch(() => {});
    }
  });

  it.each([
    {
      label: "daily-stale session",
      entry: {
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        sessionStartedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
      expectedUpdatedAt: new Date(2026, 0, 18, 5, 0, 0).getTime(),
    },
    {
      label: "legacy pending-reset session",
      entry: { updatedAt: 0 },
      expectedUpdatedAt: 0,
    },
  ])("defers implicit rollover for a $label with an active run", async (scenario) => {
    vi.useFakeTimers();
    const existingSessionId = `active-${scenario.label.replaceAll(" ", "-")}`;
    const sessionKey = `agent:main:telegram:dm:${existingSessionId}`;
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await makeStorePath("openclaw-active-stale-");
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          lifecycleRevision: "active-revision",
          ...scenario.entry,
        },
      });
      operation = createReplyOperation({
        sessionKey,
        sessionId: existingSessionId,
        resetTriggered: false,
      });
      operation.setPhase("running");

      const result = await initSessionState({
        ctx: telegramTurn(sessionKey, "hello while active", "user-active-stale"),
        cfg: {
          session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
        } as OpenClawConfig,
      });

      expect(result).toMatchObject({
        isNewSession: false,
        previousSessionEntry: undefined,
        sessionId: existingSessionId,
        sessionEntry: {
          lifecycleRevision: "active-revision",
          updatedAt: scenario.expectedUpdatedAt,
        },
      });
      expect(readSessionStoreFast(storePath)[sessionKey]).toMatchObject({
        lifecycleRevision: "active-revision",
        updatedAt: scenario.expectedUpdatedAt,
      });
    } finally {
      operation?.complete();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "the current turn's queued reservation",
      slug: "queued-stale",
      sessionId: "queued-stale-session",
      queued: true,
    },
    {
      name: "a different active session id",
      slug: "active-other-stale",
      sessionId: "inactive-stale-session",
      queued: false,
    },
  ])("does not defer stale boundary append for $name", async ({ slug, sessionId, queued }) => {
    vi.useFakeTimers();
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await makeStorePath(`openclaw-${slug}-archive-`);
      const sessionKey = `agent:main:telegram:dm:${slug}-user`;
      const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");
      operation = createReplyOperation({
        sessionKey,
        sessionId: queued ? sessionId : "different-active-session",
        resetTriggered: false,
      });
      const initialize = () =>
        initSessionState({
          ctx: telegramTurn(sessionKey, "hello after boundary", `user-${slug}`),
          cfg: { session: { store: storePath, reset: { mode: "daily", atHour: 4 } } },
        });
      let result: Awaited<ReturnType<typeof initSessionState>>;
      if (queued) {
        const initialization = runWithReplyOperationLifecycleAdmission(operation, initialize);
        void initialization.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        result = await initialization;
        expect(operation.phase).toBe("queued");
      } else {
        operation.setPhase("running");
        result = await initialize();
      }

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).toBe(sessionId);
      expect(result.previousSessionEntry?.sessionId).toBe(sessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${sessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    } finally {
      operation?.complete();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "honors provider-owned CLI reset policy (configured: %s)",
    async (configured) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
        const storePath = await makeStorePath("openclaw-cli-implicit-reset-");
        const sessionKey = "agent:main:telegram:dm:claude-cli-user";
        const existingSessionId = "provider-owned-session";
        const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);
        const cliBinding = {
          sessionId: "claude-session-1",
          authProfileId: "anthropic:claude-cli",
          mcpResumeHash: "mcp-resume-hash",
        };

        await writeSessionStoreFast(storePath, {
          [sessionKey]: {
            sessionId: existingSessionId,
            updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
            modelProvider: "claude-cli",
            model: "claude-opus-4-6",
            cliSessionBindings: {
              "claude-cli": cliBinding,
            },
            cliSessionIds: {
              "claude-cli": cliBinding.sessionId,
            },
            claudeCliSessionId: cliBinding.sessionId,
          },
        });
        await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

        const cfg = {
          session: {
            store: storePath,
            ...(configured ? { reset: { mode: "idle", idleMinutes: 1 } } : {}),
          },
        } as OpenClawConfig;
        const result = await initSessionState({
          ctx: telegramTurn(sessionKey, "hello", "claude-cli-user"),
          cfg,
        });

        expect(result.isNewSession).toBe(configured);
        expect(result.sessionId).toBe(existingSessionId);
        if (configured) {
          expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
        } else {
          expect(result.sessionEntry.cliSessionBindings?.["claude-cli"]).toEqual(cliBinding);
        }
        const transcriptStat = await fs.stat(transcriptPath).catch(() => null);
        if (!transcriptStat) {
          throw new Error("expected transcript file to remain after stale reset");
        }
        const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
          entry.startsWith(`${existingSessionId}.jsonl.reset.`),
        );
        expect(archived).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("drainFormattedSystemEvents", () => {
  it("keeps channel summary lines prefixed as trusted system output on new main sessions", async () => {
    channelSummaryMocks.buildChannelSummary.mockResolvedValue([
      "WhatsApp: linked\n  - default (line one\nline two)",
    ]);

    const result = await drainFormattedSystemEvents({
      cfg: { channels: {} } as OpenClawConfig,
      agentId: "main",
      sessionKey: "agent:main:main",
      isMainSession: true,
      isNewSession: true,
    });

    expect(result).toContain("System: WhatsApp: linked");
    for (const line of result!.split("\n")) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("leaves tagged cron events queued during heartbeat runs instead of re-rendering them (#44922)", async () => {
    try {
      // A `sessionTarget: "main"` cron systemEvent is enqueued tagged `cron:<jobId>`
      // and is surfaced by the heartbeat's dedicated reminder prompt. The generic
      // render must not also emit it as a raw `System:` line during that heartbeat
      // run, or the model sees the same text twice.
      enqueueSystemEvent("Reminder: rotate API keys", {
        sessionKey: "agent:main:main",
        contextKey: "cron:rotate-keys",
      });
      const generic = expectDefined(
        enqueueSystemEventEntry("Model switched.", { sessionKey: "agent:main:main" }),
        "queued generic event",
      );

      const result = await drainFormattedSystemEvents({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
        events: [generic],
      });

      expect(result).toContain("Model switched.");
      expect(result).not.toContain("rotate API keys");
      // The cron event stays queued so the heartbeat path remains its single owner.
      expect(peekSystemEvents("agent:main:main")).toEqual(["Reminder: rotate API keys"]);
    } finally {
      resetSystemEventsForTest();
    }
  });
});

describe("initSessionState stale threadId fallback", () => {
  it("preserves explicit transport thread routing in non-thread sessions", async () => {
    const storePath = await makeStorePath("transport-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "reply from Slack DM thread",
        SessionKey: "agent:main:main",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U1",
        AccountId: "default",
        TransportThreadId: "650.000",
      },
      cfg,
    });

    expect(result.sessionEntry.lastThreadId).toBe("650.000");
    expect(result.sessionEntry.deliveryContext?.threadId).toBe("650.000");
  });

  it("preserves external thread routing for internal turns and clears it for external non-thread turns", async () => {
    const storePath = await makeStorePath("internal-thread-route-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const sessionKey = "agent:main:main";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "session-internal-thread-route",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: {
            channel: "imessage",
            accountId: "imessage-default",
            target: { to: "+15551234567", chatType: "direct" },
            thread: { id: "thread-42", kind: "thread", source: "session" },
          },
          context: {
            channel: "imessage",
            to: "+15551234567",
            accountId: "imessage-default",
            threadId: "thread-42",
          },
          origin: {
            provider: "webchat",
            to: "+15551234567",
            accountId: "imessage-default",
            threadId: "thread-42",
            chatType: "direct",
            surface: "webchat",
          },
        },
      },
    });

    const internal = await initSessionState({
      ctx: {
        Body: "internal control-ui turn",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
      },
      cfg,
    });
    expect(internal.sessionEntry.lastThreadId).toBe("thread-42");
    expect(internal.sessionEntry.deliveryContext).toEqual({
      channel: "imessage",
      to: "+15551234567",
      accountId: "imessage-default",
      threadId: "thread-42",
    });

    const plainExternal = await initSessionState({
      ctx: {
        Body: "plain external turn",
        SessionKey: sessionKey,
        OriginatingChannel: "imessage",
        OriginatingTo: "+15551234567",
        AccountId: "imessage-default",
      },
      cfg,
    });
    expect(plainExternal.sessionEntry.lastThreadId).toBeUndefined();
    expect(plainExternal.sessionEntry.deliveryContext).toEqual({
      channel: "imessage",
      to: "+15551234567",
      accountId: "imessage-default",
    });
  });
});

describe("initSessionState dmScope delivery migration", () => {
  it.each([
    {
      name: "retires stale main-session delivery route when dmScope uses per-channel DM keys",
      legacyTo: "6101296751",
      expectRetired: true,
    },
    {
      name: "keeps legacy main-session delivery route when current DM target does not match",
      legacyTo: "1111",
      expectRetired: false,
    },
  ])("$name", async ({ legacyTo, expectRetired }) => {
    const storePath = await makeStorePath("dm-scope-main-route-");
    await writeSessionStoreFast(storePath, {
      "agent:main:main": {
        sessionId: "legacy-main",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: legacyTo,
        lastAccountId: "default",
        deliveryContext: { channel: "telegram", to: legacyTo, accountId: "default" },
      },
    });
    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:telegram:direct:6101296751",
        OriginatingChannel: "telegram",
        OriginatingTo: "6101296751",
        AccountId: "default",
      },
      cfg: {
        session: { store: storePath, dmScope: "per-channel-peer" },
      } as OpenClawConfig,
    });

    const persisted = readSessionStoreFast(storePath);
    const legacy = persisted["agent:main:main"];
    if (expectRetired) {
      expect(result.sessionKey).toBe("agent:main:telegram:direct:6101296751");
      expect(legacy?.sessionId).toBe("legacy-main");
      expect(legacy?.route).toBeUndefined();
      expect(legacy?.deliveryContext).toBeUndefined();
      expect(legacy?.lastChannel).toBeUndefined();
      expect(legacy?.lastTo).toBeUndefined();
      expect(persisted[result.sessionKey]?.deliveryContext?.to).toBe("6101296751");
    } else {
      expect(legacy?.deliveryContext).toEqual({
        channel: "telegram",
        to: legacyTo,
        accountId: "default",
      });
      expect(legacy?.lastTo).toBe(legacyTo);
    }
  });
});
describe("initSessionState internal channel routing preservation", () => {
  it("clears stale thread routing on non-thread system-event sessions", async () => {
    const storePath = await makeStorePath("system-event-clears-stale-thread-");
    const sessionKey = "agent:main:mattermost:channel:chan1";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "sess-system-event-stale-thread",
        updatedAt: Date.now(),
        lastChannel: "mattermost",
        lastTo: "channel:CHAN1",
        lastAccountId: "default",
        lastThreadId: "stale-root",
        deliveryContext: {
          channel: "mattermost",
          to: "channel:CHAN1",
          accountId: "default",
          threadId: "stale-root",
        },
        route: {
          channel: "mattermost",
          accountId: "default",
          target: { to: "channel:CHAN1" },
          thread: { id: "stale-root", kind: "thread", source: "session" },
        },
        origin: {
          provider: "mattermost",
          to: "channel:CHAN1",
          accountId: "default",
          threadId: "stale-root",
        },
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "heartbeat tick",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
    });

    expect(result.sessionEntry.lastChannel).toBe("mattermost");
    expect(result.sessionEntry.lastTo).toBe("channel:CHAN1");
    const persisted = readSessionStoreFast(storePath);
    for (const entry of [result.sessionEntry, persisted[sessionKey]]) {
      expect(entry?.lastThreadId).toBeUndefined();
      expect(entry?.deliveryContext).toEqual({
        channel: "mattermost",
        to: "channel:CHAN1",
        accountId: "default",
      });
      expect(entry?.route).toEqual({
        channel: "mattermost",
        accountId: "default",
        target: { to: "channel:CHAN1" },
      });
      expect(entry?.origin).toEqual({
        provider: "mattermost",
        to: "channel:CHAN1",
        accountId: "default",
      });
    }
  });

  it.each([
    {
      name: "lets direct webchat turns own routing for sessions with no prior external route",
      prefix: "webchat-direct-route-noext-",
      sessionKey: "agent:main:main",
      seed: {},
      session: { dmScope: "per-channel-peer" as const },
      ctx: {
        Body: "reply from control ui",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        Surface: "webchat",
      },
      expected: { delivery: { kind: "internal" } },
    },

    {
      name: "uses the configured default account for persisted routing when AccountId is omitted",
      prefix: "default-account-routing-context-",
      sessionKey: "agent:main:discord:channel:24680",
      config: { channels: { discord: { defaultAccount: "work" } } },
      ctx: { Body: "hello", OriginatingChannel: "discord", OriginatingTo: "channel:24680" },
      expected: { lastAccountId: "work" },
      expectedDelivery: { accountId: "work" },
    },
  ])("$name", async (scenario) => {
    const storePath = await makeStorePath(scenario.prefix);
    const seed = "seed" in scenario ? scenario.seed : undefined;
    if (seed) {
      await writeSessionStoreFast(storePath, {
        [scenario.sessionKey]: {
          sessionId: `session-${scenario.prefix}`,
          updatedAt: Date.now(),
          ...seed,
        },
      });
    }
    const result = await initSessionState({
      ctx: { SessionKey: scenario.sessionKey, ...scenario.ctx },
      cfg: {
        ...("config" in scenario ? scenario.config : {}),
        session: { store: storePath, ...("session" in scenario ? scenario.session : {}) },
      } as OpenClawConfig,
    });

    expectEntryFields(result.sessionEntry, scenario.expected, scenario.name);
    const expectedDelivery = "expectedDelivery" in scenario ? scenario.expectedDelivery : undefined;
    if (expectedDelivery) {
      expect(result.sessionEntry.deliveryContext, scenario.name).toMatchObject(expectedDelivery);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
