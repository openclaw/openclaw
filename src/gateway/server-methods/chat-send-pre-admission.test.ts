import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  loadSessionEntry,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  prepareUserProfileCatalog,
  readResidentUserProfileId,
} from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import {
  prepareChatSendRetryComparison,
  resolveChatSendRequestConflict,
  respondChatSendRetry,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";

const submittedInput = vi.hoisted(() =>
  vi.fn<() => Promise<Awaited<ReturnType<typeof readSessionSubmittedInput>>>>(),
);
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  readSessionSubmittedInput: vi.fn(
    async (_scope: unknown, _key: string, options?: { includeSource: true }) => {
      const message = await submittedInput();
      return message && options?.includeSource
        ? { message, source: "transcript" as const }
        : message;
    },
  ),
}));
vi.mock("./chat-restart-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-restart-recovery.js")>()),
  resolveDurableChatClaim: vi.fn(),
}));

const { resolveDurableChatClaim: recoverDurableChatClaim } = await vi.importActual<
  typeof import("./chat-restart-recovery.js")
>("./chat-restart-recovery.js");

type RetryParams = Parameters<typeof respondChatSendRetry>[0];

function createFixture() {
  const runId = "mention-run";
  const sessionKey = "agent:main:mentions";
  const rawMessage = "Hi @Bob";
  const respond = vi.fn();
  const params: Parameters<typeof runChatSendPreAdmission>[0] = {
    context: createDirectChatContext(),
    respond,
    client: null,
    request: {
      rawMessage,
      requestIdentity: "original-bob-selection",
      mentions: [{ profileId: "bob", start: 3, end: 7 }],
      p: { sessionKey, idempotencyKey: runId, message: rawMessage },
      chatSendReceivedAtMs: 100,
      supportsTaskSuggestions: false,
      inboundMessage: rawMessage,
      suppressCommandInterpretation: false,
      stopCommand: false,
      turnKind: "main",
      normalizedAttachments: [],
      reconnectResumeRequested: false,
    },
    session: {
      clientRunId: runId,
      pendingChatSendKey: pendingChatSendDedupeKey(runId),
      entry: { sessionId: "mention-session", updatedAt: 100 },
      agentId: "main",
      sessionKey,
      storePath: "/tmp/chat-retry-fixture.sqlite",
      restartSafeRequest: undefined,
      cfg: {},
      rawSessionKey: sessionKey,
      sessionLoadKey: sessionKey,
      sessionLoadOptions: { agentId: "main" },
      sessionLoadMs: 0,
      legacyKey: undefined,
      sessionRoutingChanged: () => false,
      expectedLeafEntryId: undefined,
      agentIdOverride: undefined,
      requestedAgentId: "main",
      selectedAgent: { ok: true, agentId: "main" },
      requestedSessionId: undefined,
      backingSessionId: "mention-session",
      resolvedSessionModel: { provider: "openai", model: "gpt-4.1" },
      resolvedSessionAuthProvider: "openai",
      timeoutMs: 1000,
      now: 100,
    },
  };
  return { ...params, respond };
}

function cacheSuccess(params: RetryParams, ts = 100, requestIdentity?: string) {
  const { clientRunId } = params.session;
  params.context.dedupe.set(`chat:${clientRunId}`, {
    ts,
    ok: true,
    payload: { runId: clientRunId, status: "ok" },
    ...(requestIdentity === undefined ? {} : { requestIdentity }),
  });
}

function submittedMessage(params: RetryParams) {
  return {
    role: "user" as const,
    timestamp: 100,
    content: params.request.rawMessage,
    __openclaw: { humanMentions: params.request.mentions },
  };
}

function expectFailure(respond: RetryParams["respond"], fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(fields));
}

function expectCached(payload: unknown, metadata: Record<string, unknown> = { cached: true }) {
  expect(params.respond).toHaveBeenCalledWith(true, payload, undefined, metadata);
}

function expectConflict(respond: RetryParams["respond"]) {
  expectFailure(respond, {
    code: "INVALID_REQUEST",
    details: { reason: "chat-request-conflict" },
  });
}

async function retry(params: RetryParams) {
  return respondChatSendRetry(params, await prepareChatSendRetryComparison(params));
}

async function expectRetryConflict(params: RetryParams) {
  expect(await retry(params)).toBe(true);
  expectConflict(params.respond);
}

let params: ReturnType<typeof createFixture>;
beforeEach(() => {
  vi.mocked(readSessionSubmittedInput).mockClear();
  submittedInput.mockReset().mockResolvedValue(undefined);
  vi.mocked(resolveDurableChatClaim).mockReset();
  params = createFixture();
});

it("stops admitted session work while preserving a detached producer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.sqlite") },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    params.context.getRuntimeConfig = () => cfg;
    params.request.stopCommand = true;
    params.request.p.message = "/stop";
    params.session.cfg = cfg;
    params.session.storePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: "main",
    });
    const { sessionKey, entry, storePath } = params.session;
    await upsertSessionEntryCore({ agentId: "main", storePath, sessionKey }, entry!);
    const before = loadSessionEntry({ agentId: "main", storePath, sessionKey });
    const embeddedAbort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "embedded-producer", abort: embeddedAbort });
    attachActiveEmbeddedRun(entry!.sessionId, handle);
    const controller = new AbortController();
    const admittedInterrupt = vi.fn((reason?: Error) => {
      controller.abort(reason);
      return { runId: "admitted-producer" };
    });
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, entry!.sessionId],
      run: {
        runId: "admitted-producer",
        sessionKey,
        sessionId: entry!.sessionId,
        agentId: "main",
        controlUiVisible: true,
      },
      onInterrupt: admittedInterrupt,
      assertAllowed: () => {},
    });
    try {
      expect(await runChatSendPreAdmission(params)).toBe(false);
      expect(params.respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: ["admitted-producer"],
      });
      expect(embeddedAbort).not.toHaveBeenCalled();
      expect(admittedInterrupt).toHaveBeenCalledOnce();
      expect(controller.signal.aborted).toBe(true);
      expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })).toEqual(before);
    } finally {
      admission.release();
      detachActiveEmbeddedRun(entry!.sessionId, handle);
    }
  });
});

it("stops selected-agent work without cancelling the compatibility owner's run", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      session: {
        scope: "global",
        store: state.statePath("agents", "{agentId}", "sessions", "sessions.sqlite"),
      },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    params.context.getRuntimeConfig = () => cfg;
    params.request.stopCommand = true;
    params.request.p = {
      sessionKey: "global",
      agentId: "research",
      idempotencyKey: params.session.clientRunId,
      message: "/stop",
    };
    Object.assign(params.session, {
      cfg,
      sessionKey: "global",
      rawSessionKey: "global",
      sessionLoadKey: "global",
      sessionLoadOptions: { agentId: "research" },
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "research" }),
      agentId: "research",
      requestedAgentId: "research",
      selectedAgent: { ok: true, agentId: "research" },
      backingSessionId: undefined,
      entry: undefined,
    });
    for (const [runId, agentId] of [
      ["selected", "research"],
      ["compatibility", undefined],
    ]) {
      params.context.dedupe.set(`agent:${runId}`, {
        ts: 100,
        ok: true,
        payload: { runId, sessionKey: "global", agentId, status: "accepted" },
      });
    }
    const registrations = [
      ["selected", "research"],
      ["compatibility", "ops"],
    ] as const;
    const sourceRegistrations = registrations.map(([runId, agentId]) => {
      const sessionId = `${runId}-session`;
      return registerChatAbortController({
        target: captureSessionTarget({
          storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
          sessionKey: "global",
          incarnation: sessionId,
          agentId,
        }),
        runId,
        sessionId,
        sessionKey: "global",
        agentId,
        kind: "agent",
        timeoutMs: 1_000,
      });
    });
    try {
      expect(await runChatSendPreAdmission(params)).toBe(false);
      expect(params.respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: ["selected"],
      });
      expect(sourceRegistrations[0]?.entry?.input.abortSignal.aborted).toBe(true);
      expect(sourceRegistrations[1]?.entry?.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.has("selected")).toBe(false);
      expect(rpcSourceTesting.has("compatibility")).toBe(true);
      expect(params.context.dedupe.get("agent:compatibility")?.payload).toMatchObject({
        status: "accepted",
      });
    } finally {
      for (const registration of sourceRegistrations) {
        registration.cleanup();
      }
    }
  });
});

it.each(["pending", "active", "accepted", "terminal", "metadata"] as const)(
  "requires accepted custody and rejects changed mention recipients for a %s retry",
  async (state) => {
    const { clientRunId, pendingChatSendKey, sessionKey } = params.session;
    params.context.dedupe.set(state === "pending" ? pendingChatSendKey : `chat:${clientRunId}`, {
      ts: 100,
      ok: true,
      requestIdentity: params.request.requestIdentity,
      ...(state === "accepted" ? { effectAccepted: true } : {}),
      ...(state === "pending" || state === "terminal"
        ? {
            payload: {
              runId: clientRunId,
              sessionKey,
              status: state === "pending" ? "accepted" : "ok",
            },
          }
        : {}),
    });
    if (state === "active") {
      const source = createRpcSourceForTest(
        {},
        {
          storeScope: params.session.storePath,
          runId: clientRunId,
          sessionKey,
          sessionId: "mention-session",
          agentId: "main",
          phase: "preparing",
        },
      );
      registerRpcSource(clientRunId, source);
      await claimRpcSourceForTest(source);
    }
    expect(await retry(params)).toBe(state !== "metadata");
    if (state === "pending" || state === "active") {
      expectFailure(params.respond, { code: "UNAVAILABLE", retryable: true });
    } else if (state === "metadata") {
      expect(params.respond).not.toHaveBeenCalled();
    } else {
      expectCached(
        expect.objectContaining({
          runId: clientRunId,
          status: state === "terminal" ? "ok" : "in_flight",
        }),
        expect.objectContaining({ cached: true }),
      );
    }

    params.respond.mockClear();
    params.request.requestIdentity = "changed-carol-selection";
    params.request.mentions = [{ profileId: "carol", start: 3, end: 7 }];
    await expectRetryConflict(params);
  },
);

it("replays explicit cancellation before a retained accepted input marker", async () => {
  const { clientRunId } = params.session;
  params.context.dedupe.set(`chat:${clientRunId}`, {
    ts: 100,
    ok: true,
    requestIdentity: params.request.requestIdentity,
    effectAccepted: true,
  });
  params.context.chatRunState.getOrCreate(clientRunId).abortMarker = createChatAbortMarker(200);

  expect(await retry(params)).toBe(true);
  expectCached(
    { runId: clientRunId, status: "timeout", summary: "aborted", endedAt: 200 },
    { cached: true, runId: clientRunId },
  );
});

it.each(["pending", "evicted", "superseded"] as const)(
  "settles only the original input when aborting a %s reservation",
  async (reservation) => {
    const pending = {
      ts: 100,
      ok: true,
      requestIdentity: params.request.requestIdentity,
      payload: {
        runId: params.session.clientRunId,
        status: "accepted",
        sessionKey: params.session.sessionKey,
        attemptId: reservation === "superseded" ? "successor" : "attempt",
      },
    };
    if (reservation !== "evicted") {
      params.context.dedupe.set(params.session.pendingChatSendKey, pending);
    }
    const written = writePreRegisteredChatAbort({
      context: params.context,
      runId: params.session.clientRunId,
      stopReason: "rpc",
      attemptId: "attempt",
      requestIdentity: params.request.requestIdentity,
    });
    if (reservation === "superseded") {
      expect(written).toBe(false);
      expect(params.context.chatRunState.hasAbortMarker(params.session.clientRunId)).toBe(false);
      expect(params.context.dedupe.get(params.session.pendingChatSendKey)).toBe(pending);
      expect(params.context.dedupe.has(`chat:${params.session.clientRunId}`)).toBe(false);
      return;
    }
    expect(written).toBe(true);
    expect(params.context.chatRunState.hasAbortMarker(params.session.clientRunId)).toBe(true);
    params.request.requestIdentity = "changed-after-abort";
    await expectRetryConflict(params);
    expect(params.context.dedupe.has(params.session.pendingChatSendKey)).toBe(false);
  },
);

it.each(["different", undefined])(
  "rejects a durable source retry with fingerprint %s",
  (fingerprint) => {
    params.session.entry = {
      sessionId: "mention-session",
      updatedAt: 100,
      restartRecoveryDeliverySourceRunId: params.session.clientRunId,
      restartRecoveryDeliveryRequestFingerprint: "original",
    };
    params.session.restartSafeRequest = fingerprint ? { fingerprint } : undefined;
    expect(resolveChatSendRequestConflict(params)).toMatchObject({
      details: { reason: "chat-request-conflict" },
    });
    params.session.restartSafeRequest = { fingerprint: "original" };
    expect(resolveChatSendRequestConflict(params)).toBeUndefined();
  },
);

it.each(["unchanged", "removed", "uncached removal"] as const)(
  "compares %s selections to the original source after RAM identity expires",
  async (selection) => {
    const terminal = selection === "uncached removal";
    if (terminal) {
      params.session.entry!.restartRecoveryTerminalRunIds = [params.session.clientRunId];
    } else {
      cacheSuccess(params, 200);
    }
    submittedInput.mockResolvedValue(submittedMessage(params));
    if (selection === "removed" || terminal) {
      params.request.mentions = undefined;
    }
    if (selection === "uncached removal") {
      expect(
        resolveChatSendRequestConflict(params, await prepareChatSendRetryComparison(params)),
      ).toMatchObject({ details: { reason: "chat-request-conflict" } });
    } else {
      expect(await retry(params)).toBe(true);
      if (selection === "unchanged") {
        expectCached({ runId: params.session.clientRunId, status: "ok" });
      } else {
        expectConflict(params.respond);
      }
    }
  },
);

it.each(["missing", "work context", "redacted"] as const)(
  "does not acknowledge an unverifiable %s source without RAM fingerprints",
  async (source) => {
    params.request.requestIdentity = undefined;
    if (source === "work context") {
      params.request.mentions = undefined;
      params.request.workContext = {
        snapshot: { page: "chat" },
        text: params.request.rawMessage,
      };
    }
    cacheSuccess(params, 200);
    if (source === "redacted") {
      submittedInput.mockResolvedValue({
        role: "user",
        timestamp: 100,
        content: "[REDACTED]",
      });
    }
    await expectRetryConflict(params);
    if (source === "missing") {
      expectFailure(params.respond, {
        message: expect.stringContaining("Check the conversation history"),
      });
    }
  },
);

it("refuses stale projection evidence before replaying a cached response", async () => {
  cacheSuccess(params, 100);
  submittedInput.mockRejectedValue(
    new SessionTranscriptProjectionUnavailableError(params.session.entry!.sessionId),
  );
  expect(await runChatSendPreAdmission(params)).toBe(false);
  expectFailure(params.respond, { code: "UNAVAILABLE", retryable: true });
});

it("rejects a competing identity published while submitted comparison yields", async () => {
  cacheSuccess(params, 100);
  const read = createDeferred<Awaited<ReturnType<typeof readSessionSubmittedInput>>>();
  submittedInput.mockReturnValue(read.promise);
  const pending = runChatSendPreAdmission(params);
  cacheSuccess(params, 200, "competing-input");
  read.resolve(submittedMessage(params));
  expect(await pending).toBe(false);
  expectConflict(params.respond);
});

it.each(["ready", "routing changed", "archived"] as const)(
  "revalidates new-input policy after the indexed receipt read (%s)",
  async (outcome) => {
    vi.mocked(resolveDurableChatClaim).mockImplementation(recoverDurableChatClaim);
    if (outcome === "archived") {
      params.session.entry!.archivedAt = 100;
    }
    let consuming = false;
    params.assertCurrent = () => {
      expect(consuming).toBe(true);
    };
    params.session.sessionRoutingChanged = () => {
      params.assertCurrent?.();
      return outcome === "routing changed";
    };
    params.withCurrent = async (consume) => {
      consuming = true;
      try {
        return consume();
      } finally {
        consuming = false;
      }
    };

    expect(await runChatSendPreAdmission(params)).toBe(outcome === "ready");
    if (outcome === "ready") {
      expect(params.respond).not.toHaveBeenCalled();
    } else {
      expectFailure(params.respond, { code: "INVALID_REQUEST" });
    }
  },
);

it("rechecks a competing request admitted while durable recovery yields", async () => {
  params.withCurrent = async (consume) => consume();
  const { session } = params;
  const deferred = createDeferred<Awaited<ReturnType<typeof resolveDurableChatClaim>>>();
  const entered = createDeferred();
  vi.mocked(resolveDurableChatClaim).mockImplementation(() => {
    entered.resolve();
    return deferred.promise;
  });
  const pending = runChatSendPreAdmission(params);
  await entered.promise;
  cacheSuccess(params, 200, "competing-input");
  deferred.resolve({ kind: "continue", entry: session.entry });
  expect(await pending).toBe(false);
  expectConflict(params.respond);
});

it.each(["unchanged", "cached-success", "new-admission"] as const)(
  "rechecks the canonical profile after real recovery without changing %s outcomes",
  async (outcome) => {
    const stateOptions = { scenario: "minimal", prepareProfileCatalog: true } as const;
    await withOpenClawTestState(stateOptions, async () => {
      setRuntimeConfigSnapshot({});
      const { session, context, respond } = params;
      const sourceEmail = "recovery-source@example.test";
      const source = ensureProfileForEmail(sourceEmail);
      const target = ensureProfileForEmail("recovery-target@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const scope = { agentId: session.agentId, sessionKey: session.sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "mention-session", updatedAt: 100 });
      const originalEntry = loadSessionEntry(scope);
      expect(originalEntry).toBeDefined();
      session.entry = originalEntry;
      session.storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const client: NonNullable<Parameters<typeof runChatSendPreAdmission>[0]["client"]> = {
        connId: "profile-recovery",
        authenticatedUserProfile: gatewayProfile(source.id, null, source.updatedAt),
        connect: gatewayConnect(["operator.admin"], { id: "test", version: "1", mode: "test" }),
      };
      params.client = client;
      const mismatch = new SessionMutationAuthorizationChangedError({
        code: "INVALID_REQUEST",
        message: "Selected account changed; select the account again.",
        details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
      });
      // Keep the selected ID exact: resolving both sides would silently follow a merge.
      params.assertCurrent = () => {
        if (readResidentUserProfileId(client.authenticatedUserProfile!.profileId) !== source.id) {
          throw mismatch;
        }
      };
      params.assertCurrent();
      const entered = createDeferred();
      const release = createDeferred();
      let recoveryCompleted = false;
      vi.mocked(resolveDurableChatClaim).mockImplementationOnce(async (request) => {
        entered.resolve();
        await release.promise;
        const result = await recoverDurableChatClaim(request);
        recoveryCompleted = true;
        return result;
      });
      const pending = runChatSendPreAdmission(params);
      try {
        await Promise.race([entered.promise, pending]);
        if (outcome !== "unchanged") {
          linkEmail(sourceEmail, target.id);
          expect(readResidentUserProfileId(source.id)).toBe(target.id);
          expect(client.authenticatedUserProfile?.profileId).toBe(source.id);
        }
        if (outcome === "cached-success") {
          cacheSuccess(params, 200, params.request.requestIdentity);
        }
        const originalReceipts = structuredClone([...context.dedupe]);
        release.resolve();
        if (outcome === "unchanged") {
          await expect(pending).resolves.toBe(true);
        } else {
          await expect(pending).rejects.toBe(mismatch);
        }

        expect(recoveryCompleted).toBe(true);
        expect(loadSessionEntry(scope)).toEqual(originalEntry);
        expect([...context.dedupe]).toEqual(originalReceipts);
        expect(rpcSourceTesting.size).toBe(0);
        expect(client).not.toHaveProperty("invalidated", true);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
      }
    });
  },
);
