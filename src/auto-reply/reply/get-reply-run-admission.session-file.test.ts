import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { getActiveNativeAttempt } from "../../agents/embedded-agent-runner/run-state.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import type { SessionEntry } from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { resolveFollowupRunToolAuthorityFingerprintAsync } from "./reply-tool-authority.test-support.js";
import { createTypingController } from "./typing.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: vi.fn(async () => undefined),
}));
vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn(async () => undefined),
}));
vi.mock("./queue/drain.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue/drain.js")>()),
  scheduleFollowupDrain: () => {
    throw new Error("Admission fixture must not start a drain");
  },
  kickFollowupDrainIfIdle: () => {
    throw new Error("Admission fixture must not start a drain");
  },
}));
vi.mock("./get-reply-run-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-run-helpers.js")>()),
  loadAgentRunnerRuntime: async () => ({ runReplyAgent: vi.fn() }),
  loadEmbeddedAgentRuntime: async () => ({
    resolveActiveEmbeddedRunSessionIdBySessionFile: (
      await import("../../agents/embedded-agent-runner/runs.js")
    ).resolveActiveEmbeddedRunSessionIdBySessionFile,
    resolveActiveEmbeddedRunBySessionFile: (
      await import("../../agents/embedded-agent-runner/runs.js")
    ).resolveActiveEmbeddedRunBySessionFile,
  }),
  loadSessionUpdatesRuntime: async () => ({
    ensureSkillSnapshot: async ({ sessionEntry }: { sessionEntry: SessionEntry }) => ({
      sessionEntry,
    }),
  }),
}));

async function createAdmissionFixture() {
  const sessionKey = "agent:main:slack:channel:room:thread:100.1";
  const sessionId = "session";
  const storePath = "/tmp/agent/sessions/sessions.json";
  const entry: SessionEntry = { sessionId, updatedAt: 1 };
  const body = "Use the revised request";
  const ctx = finalizeInboundContext({
    SessionKey: sessionKey,
    Provider: "slack",
    ChatType: "channel",
    Body: body,
    RawBody: body,
    CommandBody: body,
    BodyStripped: body,
  });
  const params: Parameters<typeof prepareReplyRunContext>[0] = {
    ctx,
    sessionCtx: ctx,
    conversation: prepareReplyConversation({ ctx, sessionEntry: entry }),
    sessionEntry: entry,
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      rawBodyNormalized: body,
      commandBodyNormalized: body,
    },
    allowTextCommands: true,
    directives: parseInlineSessionDirectives(body),
    defaultActivation: "always",
    modelState: createModelSelectionStateFixture({
      agentCfg: {},
      provider: "anthropic",
      model: "claude",
    }),
    provider: "anthropic",
    model: "claude",
    typing: createTypingController({}),
    defaultModel: "claude",
    timeoutMs: 30_000,
    isNewSession: false,
    resetTriggered: false,
    systemSent: true,
    sessionKey,
    sessionId,
    storePath,
    sessionStore: { [sessionKey]: entry },
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    resolvedThinkLevel: "off",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
  };
  const context = await prepareReplyRunContext(params);
  if (context.kind !== "ready") {
    throw new Error("Expected prepared reply context");
  }
  return { context, entry, sessionKey, sessionId, storePath };
}

function nativeRun(overrides: Partial<Parameters<typeof attachActiveEmbeddedRun>[1]> = {}) {
  return {
    queueMessage: vi.fn(async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
    ...overrides,
  };
}

afterEach(() => vi.clearAllMocks());

describe("prepared reply transcript identity", () => {
  it.for(["steer", "followup", "interrupt"] as const)(
    "preserves sessionless native %s admission with an alias-only effect",
    async (mode, { signal }) => {
      const { context, sessionId, storePath } = await createAdmissionFixture();
      const sessionFile = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
      const native = nativeRun();
      const interrupted = createDeferred();
      const effect = await beginSessionEffect({
        scope: storePath,
        identities: [sessionId],
        onInterrupt: () => {
          native.abort();
          interrupted.resolve();
        },
      });
      const registration = attachActiveEmbeddedRun(
        sessionId,
        native,
        undefined,
        sessionFile,
        "main",
      );
      if (!registration) {
        throw new Error("Expected native registration");
      }
      const cleanup = createDeferred();
      if (mode === "interrupt") {
        vi.useFakeTimers();
        registration.runCleanupSettlement = cleanup.promise;
      }
      const pending = prepareReplyRunAdmission({
        ...context,
        effectiveQueueMode: mode,
        params: {
          ...context.params,
          ctx: { ...context.params.ctx, SessionKey: undefined },
          sessionCtx: { ...context.params.sessionCtx, SessionKey: undefined },
          sessionKey: undefined,
          sessionStore: undefined,
        },
      });
      try {
        expect(isSessionRunActive(sessionId)).toBe(false);
        expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
        if (mode === "interrupt") {
          await withinTest(
            awaitGateBeforeSettlement(
              interrupted.promise,
              pending,
              "Sessionless interrupt bypassed its active native producer",
            ),
            signal,
          );
          expect(native.abort).toHaveBeenCalledOnce();
          let admitted = false;
          void pending.then(
            () => {
              admitted = true;
            },
            () => {},
          );
          detachActiveEmbeddedRun(sessionId, native);
          effect.release();
          await vi.advanceTimersByTimeAsync(0);
          expect(admitted).toBe(false);
          cleanup.resolve();
        }
        const prepared = await withinTest(pending, signal);
        expect(prepared).toMatchObject({
          kind: "ready",
          isActive: true,
          shouldSteer: mode === "steer",
          shouldFollowup: mode !== "interrupt",
          resolvedQueue: { mode },
        });
        if (prepared.kind !== "ready") {
          throw new Error("Expected prepared sessionless reply");
        }
        expect(await prepared.isRunActive()).toBe(mode !== "interrupt");
        detachActiveEmbeddedRun(sessionId, native);
        expect(await prepared.isRunActive()).toBe(false);
        expect(native.queueMessage).not.toHaveBeenCalled();
      } finally {
        detachActiveEmbeddedRun(sessionId, native);
        effect.release();
        cleanup.resolve();
        await pending.catch(() => {});
        vi.useRealTimers();
      }
    },
  );

  it.for(["steer", "interrupt"] as const)(
    "keeps source-less %s admission on its physical store when session identities collide",
    async (mode, { signal }) => {
      const { context, sessionKey, sessionId, storePath } = await createAdmissionFixture();
      const interrupted = createDeferred();
      const startTurn = (scope: string) => {
        const target = captureSessionTarget({
          storeScope: scope,
          sessionKey,
          incarnation: sessionId,
          agentId: "main",
        });
        const operation = createReplyOperation({
          sessionKey,
          sessionId,
          target,
          routeThreadId: scope === storePath ? "selected-thread" : "foreign-thread",
          resetTriggered: false,
        });
        const native = nativeRun({
          abort: vi.fn(() => interrupted.resolve()),
        });
        attachActiveEmbeddedRun(sessionId, native, sessionKey, undefined, "main", operation);
        return { operation, native, target };
      };
      const foreign = startTurn("/tmp/foreign/sessions/sessions.json");
      const selected = startTurn(storePath);
      const turns = [foreign, selected];
      const older = createQueueTestRun({ prompt: "Foreign queued request" });
      older.run = {
        ...older.run,
        agentId: "main",
        sessionId,
        sessionKey,
        config: { session: { store: foreign.target.storeScope } },
      };
      enqueueFollowupRun(sessionKey, older, { mode: "followup" }, "none", undefined, false);
      const preparedContext = {
        ...context,
        effectiveQueueMode: mode,
        params: {
          ...context.params,
          ctx: {
            ...context.params.ctx,
            ChatType: "direct",
            MessageThreadId: "selected-thread",
          },
        },
      };
      const pending = prepareReplyRunAdmission(preparedContext);
      try {
        if (mode === "interrupt") {
          await withinTest(
            awaitGateBeforeSettlement(
              interrupted.promise,
              pending,
              "Admission skipped the selected store's active producer",
            ),
            signal,
          );
          expect(selected.native.abort).toHaveBeenCalledOnce();
          expect(foreign.native.abort).not.toHaveBeenCalled();
          detachActiveEmbeddedRun(sessionId, selected.native, sessionKey);
          selected.operation.complete();
        }
        const prepared = await withinTest(pending, signal);
        expect(prepared).toMatchObject({
          kind: "ready",
          isActive: true,
          shouldSteer: mode === "steer",
          hasQueuedFollowups: false,
        });
        if (prepared.kind !== "ready") {
          throw new Error("Expected a prepared reply");
        }
        expect(await prepared.isRunActive()).toBe(mode === "steer");
        detachActiveEmbeddedRun(sessionId, selected.native, sessionKey);
        selected.operation.complete();
        expect(await prepared.isRunActive()).toBe(false);
        expect(foreign.operation.result).toBeNull();
        expect(foreign.operation.abortSignal.aborted).toBe(false);
        expect(getExistingFollowupQueue(sessionKey, foreign.target)?.items).toEqual([older]);
        expect(await prepareReplyRunAdmission(preparedContext)).toMatchObject({
          kind: "ready",
          isActive: false,
          hasQueuedFollowups: false,
        });
      } finally {
        clearFollowupQueue(sessionKey, older.controllerInput?.mailbox);
        for (const { native, operation } of turns) {
          detachActiveEmbeddedRun(sessionId, native, sessionKey);
          operation.complete();
        }
        await pending.catch(() => {});
      }
    },
  );

  it("carries an inherited thinking request through admission to candidate selection", async () => {
    const { context, entry } = await createAdmissionFixture();
    entry.thinkingLevel = "high";
    const catalog = [{ provider: "fixture", id: "basic", name: "Basic", reasoning: false }];
    const result = await prepareReplyRunAdmission({
      ...context,
      thinkingRuntime: "openclaw",
      params: {
        ...context.params,
        provider: "fixture",
        model: "basic",
        resolvedThinkLevel: "high",
        modelState: {
          ...context.params.modelState,
          allowedModelCatalog: catalog,
          resolveThinkingCatalog: async () => catalog,
        },
      },
    });

    expect(result).toMatchObject({ kind: "ready", resolvedThinkLevel: "high" });
    expect(entry.thinkingLevel).toBe("high");
  });

  it.each(["steer", "followup"] as const)(
    "preserves %s admission and transcript authority despite an older queued followup",
    async (mode) => {
      const { context, sessionKey, sessionId, storePath } = await createAdmissionFixture();
      const older = createQueueTestRun({ prompt: "Earlier followup", messageId: `older-${mode}` });
      older.run = {
        ...older.run,
        agentId: "main",
        config: { session: { store: storePath } },
      };
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.setPhase("running");
      enqueueFollowupRun(sessionKey, older, { mode: "followup" }, "message-id", undefined, false);
      try {
        const prepared = await prepareReplyRunAdmission({ ...context, effectiveQueueMode: mode });
        expect(prepared).toMatchObject({
          kind: "ready",
          isActive: true,
          shouldSteer: mode === "steer",
          shouldFollowup: true,
        });
        expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([older]);
        if (prepared.kind !== "ready") {
          throw new Error("Expected a prepared reply");
        }
        const incoming = createQueueTestRun({ prompt: "Use the revised request" });
        incoming.run = {
          ...incoming.run,
          agentId: "main",
          sessionKey,
          sessionId,
          sessionFile: prepared.preparedSessionState.sessionFile,
        };
        const queued = {
          ...incoming,
          run: {
            ...incoming.run,
            sessionFile:
              normalizeOptionalString(incoming.run.sessionKey) ?? incoming.run.sessionFile,
          },
        };
        expect(await resolveFollowupRunToolAuthorityFingerprintAsync(incoming)).toBe(
          await resolveFollowupRunToolAuthorityFingerprintAsync(queued),
        );
        expect(prepared.preparedSessionState.sessionFile).toBe(sessionKey);
      } finally {
        operation.complete();
        clearFollowupQueue(sessionKey);
      }
    },
  );

  it.each([false, true])(
    "keeps caller-only model auth selection off the shared session (fast=%s)",
    async (fast) => {
      const { context, entry } = await createAdmissionFixture();
      entry.authProfileOverride = "fixture:shared";
      entry.authProfileOverrideSource = "user";
      vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(async (params) => {
        expect(params.storePath).toBeUndefined();
        expect(params.sessionEntry).not.toBe(entry);
        if (!params.sessionEntry) {
          throw new Error("Expected an auth selection snapshot");
        }
        params.sessionEntry.authProfileOverride = "fixture:turn";
        return { profileId: "fixture:turn", source: "auto", routeRequirement: undefined };
      });

      const result = await prepareReplyRunAdmission({
        ...context,
        useFastReplyRuntime: fast,
        params: {
          ...context.params,
          provider: "fixture",
          model: "allowed",
          modelState: { ...context.params.modelState, operatorModelOverride: true },
        },
      });
      expect(result).toMatchObject({ kind: "ready", authProfileId: "fixture:turn" });
      expect(resolveSessionAuthSelection).toHaveBeenCalledOnce();
      expect(entry.authProfileOverride).toBe("fixture:shared");
    },
  );
});
