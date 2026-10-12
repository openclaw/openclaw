import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  loadSessionEntry,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail, resolveUserProfileId } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import {
  prepareChatSendRetryComparison,
  resolveChatSendRequestConflict,
  respondChatSendRetry,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  readSessionSubmittedInput: vi.fn(),
}));
vi.mock("./chat-restart-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-restart-recovery.js")>()),
  resolveDurableChatClaim: vi.fn(),
}));

type RetryParams = Parameters<typeof respondChatSendRetry>[0];

function retryFixture(runId: string) {
  const request: RetryParams["request"] = {
    rawMessage: "Hi @Bob",
    requestIdentity: "original-bob-selection",
    mentions: [{ profileId: "bob", start: 3, end: 7 }],
  };
  const session: RetryParams["session"] = {
    clientRunId: runId,
    pendingChatSendKey: pendingChatSendDedupeKey(runId),
    entry: { sessionId: "mention-session", updatedAt: 100 },
    agentId: "main",
    sessionKey: "agent:main:mentions",
    storePath: "/tmp/chat-retry-fixture.sqlite",
    restartSafeRequest: undefined,
  };
  return { request, session, context: createDirectChatContext(), respond: vi.fn() };
}

function preAdmissionFixture(runId: string) {
  const fixture = retryFixture(runId);
  const { session } = fixture;
  const params: Parameters<typeof runChatSendPreAdmission>[0] = {
    ...fixture,
    client: null,
    request: {
      ...fixture.request,
      p: {
        sessionKey: session.sessionKey,
        idempotencyKey: session.clientRunId,
        message: fixture.request.rawMessage,
      },
      chatSendReceivedAtMs: 100,
      supportsTaskSuggestions: false,
      inboundMessage: fixture.request.rawMessage,
      suppressCommandInterpretation: false,
      stopCommand: false,
      turnKind: "main",
      normalizedAttachments: [],
      reconnectResumeRequested: false,
    },
    session: {
      ...session,
      cfg: {},
      rawSessionKey: session.sessionKey,
      sessionLoadKey: session.sessionKey,
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
  return { fixture, params };
}

function expectConflict(respond: RetryParams["respond"]) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      details: { reason: "chat-request-conflict" },
    }),
  );
}

beforeEach(() => {
  vi.mocked(readSessionSubmittedInput).mockReset().mockResolvedValue(undefined);
  vi.mocked(resolveDurableChatClaim).mockReset();
});

describe("chat send stop ownership", () => {
  it("preserves admitted and embedded controller-less producers without Stop opt-in", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { fixture, params } = preAdmissionFixture("controller-less-stop");
      const cfg: OpenClawConfig = {
        session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.sqlite") },
      };
      await state.writeConfig(cfg);
      fixture.context.getRuntimeConfig = () => cfg;
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
      setActiveEmbeddedRun(entry!.sessionId, handle, sessionKey, undefined, "main");
      const controller = new AbortController();
      const admittedInterrupt = vi.fn((reason?: Error) => {
        controller.abort(reason);
        return { runId: "admitted-producer" };
      });
      const admission = await beginSessionWorkAdmission({
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
        expect(fixture.respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: false,
          runIds: [],
        });
        expect(embeddedAbort).not.toHaveBeenCalled();
        expect(admittedInterrupt).not.toHaveBeenCalled();
        expect(controller.signal.aborted).toBe(false);
        expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })).toEqual(before);
      } finally {
        admission.release();
        clearActiveEmbeddedRun(entry!.sessionId, handle, sessionKey);
      }
    });
  });

  it("stops selected-agent work without cancelling the compatibility owner's run", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { fixture, params } = preAdmissionFixture("stop-selected-agent");
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
      fixture.context.getRuntimeConfig = () => cfg;
      params.request.stopCommand = true;
      params.request.p = {
        sessionKey: "global",
        agentId: "research",
        idempotencyKey: "stop-selected-agent",
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
        fixture.context.dedupe.set(`agent:${runId}`, {
          ts: 100,
          ok: true,
          payload: { runId, sessionKey: "global", agentId, status: "accepted" },
        });
      }

      expect(await runChatSendPreAdmission(params)).toBe(false);
      expect(fixture.respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: ["selected"],
      });
      expect(fixture.context.dedupe.get("agent:selected")?.payload).toMatchObject({
        status: "timeout",
        summary: "aborted",
      });
      expect(fixture.context.dedupe.get("agent:compatibility")?.payload).toMatchObject({
        status: "accepted",
      });
    });
  });
});

describe("chat send retry identity", () => {
  it.each(["pending", "active", "queued", "terminal"] as const)(
    "rejects changed mention recipients before a %s acknowledgement",
    async (state) => {
      const params = retryFixture(`changed-recipient-${state}`);
      const { clientRunId, pendingChatSendKey, sessionKey } = params.session;
      params.context.dedupe.set(state === "pending" ? pendingChatSendKey : `chat:${clientRunId}`, {
        ts: 100,
        ok: true,
        requestIdentity: params.request.requestIdentity,
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
      const controller = {
        controller: new AbortController(),
        sessionKey,
        sessionId: "mention-session",
      };
      if (state === "active") {
        params.context.chatAbortControllers.set(clientRunId, {
          ...controller,
          startedAtMs: 100,
          expiresAtMs: 200,
        });
      } else if (state === "queued") {
        params.context.chatQueuedTurns.set(clientRunId, controller);
      }
      expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(true);
      expect(params.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          runId: clientRunId,
          status: state === "terminal" ? "ok" : "in_flight",
        }),
        undefined,
        expect.objectContaining({ cached: true }),
      );

      params.respond.mockClear();
      params.request.requestIdentity = "changed-carol-selection";
      params.request.mentions = [{ profileId: "carol", start: 3, end: 7 }];
      expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(true);
      expectConflict(params.respond);
      expect(readSessionSubmittedInput).not.toHaveBeenCalled();
    },
  );

  it("keeps a transient preparation failure retryable without treating identity metadata as an ACK", async () => {
    const params = retryFixture("metadata-only-retry");
    params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
      ts: 100,
      ok: true,
      requestIdentity: params.request.requestIdentity,
    });
    expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(false);
    expect(params.respond).not.toHaveBeenCalled();

    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${params.session.clientRunId}`,
      entry: { ts: 200, ok: true, payload: { runId: params.session.clientRunId, status: "ok" } },
    });
    params.request.requestIdentity = "changed-after-terminal";
    expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(true);
    expectConflict(params.respond);
  });

  it("transfers the pending input identity when an abort precedes active registration", async () => {
    const params = retryFixture("early-abort-retry");
    params.context.dedupe.set(params.session.pendingChatSendKey, {
      ts: 100,
      ok: true,
      requestIdentity: params.request.requestIdentity,
      payload: {
        runId: params.session.clientRunId,
        status: "accepted",
        sessionKey: params.session.sessionKey,
        attemptId: "attempt",
      },
    });
    writePreRegisteredChatAbort({
      context: params.context,
      runId: params.session.clientRunId,
      stopReason: "rpc",
      attemptId: "attempt",
      endedAt: 200,
    });
    params.request.requestIdentity = "changed-after-abort";
    expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(true);
    expectConflict(params.respond);
    expect(params.context.dedupe.has(params.session.pendingChatSendKey)).toBe(false);
  });

  it.each(["different", undefined])(
    "rejects a durable source retry with fingerprint %s",
    (fingerprint) => {
      const params = retryFixture(`durable-fingerprint-${fingerprint ?? "unavailable"}`);
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
      expect(readSessionSubmittedInput).not.toHaveBeenCalled();
    },
  );

  it.each(["unchanged", "removed", "replaced"] as const)(
    "compares %s selections to the original source after RAM identity expires",
    async (selection) => {
      const params = retryFixture(`source-${selection}`);
      const original = {
        role: "user" as const,
        timestamp: 100,
        content: params.request.rawMessage,
        __openclaw: { humanMentions: params.request.mentions },
      };
      vi.mocked(readSessionSubmittedInput).mockResolvedValue(original);
      params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
        ts: 200,
        ok: true,
        payload: { runId: params.session.clientRunId, status: "ok" },
      });
      params.request.mentions =
        selection === "removed"
          ? undefined
          : selection === "replaced"
            ? [{ profileId: "carol", start: 3, end: 7 }]
            : params.request.mentions;
      expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(true);
      if (selection === "unchanged") {
        expect(params.respond).toHaveBeenCalledWith(
          true,
          { runId: params.session.clientRunId, status: "ok" },
          undefined,
          { cached: true },
        );
      } else {
        expectConflict(params.respond);
      }
      expect(readSessionSubmittedInput).toHaveBeenCalledWith(
        {
          agentId: "main",
          sessionId: "mention-session",
          sessionKey: params.session.sessionKey,
          storePath: params.session.storePath,
        },
        `${params.session.clientRunId}:user`,
      );
    },
  );

  it.each(["missing", "redacted"] as const)(
    "does not acknowledge an unverifiable %s mention source",
    async (source) => {
      const params = retryFixture(`unverifiable-${source}`);
      params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
        ts: 200,
        ok: true,
        payload: { runId: params.session.clientRunId, status: "ok" },
      });
      if (source === "redacted") {
        vi.mocked(readSessionSubmittedInput).mockResolvedValue({
          role: "user",
          timestamp: 100,
          content: "[REDACTED]",
        });
      }
      expect(respondChatSendRetry(params, await prepareChatSendRetryComparison(params))).toBe(true);
      expectConflict(params.respond);
      if (source === "missing") {
        expect(params.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("Check the conversation history"),
          }),
        );
      }
    },
  );

  it("rejects annotation removal from a terminal tombstone after the entire RAM cache is gone", async () => {
    const params = retryFixture("terminal-source-without-cache");
    params.session.entry = {
      sessionId: "mention-session",
      updatedAt: 100,
      restartRecoveryTerminalRunIds: [params.session.clientRunId],
    };
    vi.mocked(readSessionSubmittedInput).mockResolvedValue({
      role: "user",
      timestamp: 100,
      content: params.request.rawMessage,
      __openclaw: { humanMentions: params.request.mentions },
    });
    params.request.mentions = undefined;
    expect(
      resolveChatSendRequestConflict(params, await prepareChatSendRetryComparison(params)),
    ).toMatchObject({
      details: { reason: "chat-request-conflict" },
    });
  });

  it("refuses stale projection evidence before replaying a cached response", async () => {
    const { params } = preAdmissionFixture("stale-submitted-source");
    params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
      ts: 100,
      ok: true,
      payload: { runId: params.session.clientRunId, status: "ok" },
    });
    vi.mocked(readSessionSubmittedInput).mockRejectedValue(
      new SessionTranscriptProjectionUnavailableError(params.session.entry!.sessionId),
    );
    expect(await runChatSendPreAdmission(params)).toBe(false);
    expect(params.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
  });

  it("rejects a competing identity published while submitted comparison yields", async () => {
    const { params } = preAdmissionFixture("submitted-comparison-race");
    const key = `chat:${params.session.clientRunId}`;
    params.context.dedupe.set(key, {
      ts: 100,
      ok: true,
      payload: { runId: params.session.clientRunId, status: "ok" },
    });
    const read = createDeferred<Awaited<ReturnType<typeof readSessionSubmittedInput>>>();
    vi.mocked(readSessionSubmittedInput).mockReturnValue(read.promise);
    const pending = runChatSendPreAdmission(params);
    params.context.dedupe.set(key, {
      ts: 200,
      ok: true,
      requestIdentity: "competing-input",
      payload: { runId: params.session.clientRunId, status: "ok" },
    });
    read.resolve({
      role: "user",
      timestamp: 100,
      content: params.request.rawMessage,
      __openclaw: { humanMentions: params.request.mentions },
    });
    expect(await pending).toBe(false);
    expectConflict(params.respond);
  });

  it.each(["ready", "routing changed", "archived"] as const)(
    "consumes new-input policy in one current read when recovery needs no work (%s)",
    async (outcome) => {
      const { params } = preAdmissionFixture(`prepared-new-input-${outcome}`);
      const actualRecovery = await vi.importActual<typeof import("./chat-restart-recovery.js")>(
        "./chat-restart-recovery.js",
      );
      vi.mocked(resolveDurableChatClaim).mockImplementation(actualRecovery.resolveDurableChatClaim);
      if (outcome === "archived") {
        params.session.entry!.archivedAt = 100;
      }
      let authorityReads = 0;
      let consuming = false;
      params.assertCurrent = () => {
        expect(consuming).toBe(true);
      };
      params.session.sessionRoutingChanged = () => {
        params.assertCurrent?.();
        return outcome === "routing changed";
      };
      params.withCurrent = async (consume) => {
        authorityReads += 1;
        consuming = true;
        try {
          return consume();
        } finally {
          consuming = false;
        }
      };

      expect(await runChatSendPreAdmission(params)).toBe(outcome === "ready");
      expect(authorityReads).toBe(1);
      expect(readSessionSubmittedInput).not.toHaveBeenCalled();
      if (outcome === "ready") {
        expect(params.respond).not.toHaveBeenCalled();
      } else {
        expect(params.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
    },
  );

  it("rechecks a competing request admitted while durable recovery yields", async () => {
    const { fixture, params } = preAdmissionFixture("recovery-race");
    let authorityReads = 0;
    params.withCurrent = async (consume) => {
      authorityReads += 1;
      return consume();
    };
    const { session } = fixture;
    const deferred = createDeferred<Awaited<ReturnType<typeof resolveDurableChatClaim>>>();
    const entered = createDeferred();
    vi.mocked(resolveDurableChatClaim).mockImplementation(() => {
      entered.resolve();
      return deferred.promise;
    });
    const pending = runChatSendPreAdmission(params);
    await entered.promise;
    expect(resolveDurableChatClaim).toHaveBeenCalledOnce();
    expect(authorityReads).toBe(1);
    fixture.context.dedupe.set(`chat:${session.clientRunId}`, {
      ts: 200,
      ok: true,
      requestIdentity: "competing-input",
      payload: { runId: session.clientRunId, status: "ok" },
    });
    deferred.resolve({ kind: "continue", entry: session.entry });
    expect(await pending).toBe(false);
    expectConflict(fixture.respond);
    expect(authorityReads).toBe(2);
  });

  it.each(["unchanged", "cached-success", "cached-error", "new-admission"] as const)(
    "rechecks the canonical profile after real recovery without changing %s outcomes",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { fixture, params } = preAdmissionFixture(`profile-recovery-${outcome}`);
        const sourceEmail = "recovery-source@example.test";
        const source = ensureProfileForEmail(sourceEmail);
        const target = ensureProfileForEmail("recovery-target@example.test");
        const scope = { agentId: params.session.agentId, sessionKey: params.session.sessionKey };
        await upsertSessionEntryCore(scope, { sessionId: "mention-session", updatedAt: 100 });
        const originalEntry = loadSessionEntry(scope);
        expect(originalEntry).toBeDefined();
        params.session.entry = originalEntry;
        params.session.storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const client: NonNullable<Parameters<typeof runChatSendPreAdmission>[0]["client"]> = {
          connId: "profile-recovery",
          authenticatedUserProfile: {
            profileId: source.id,
            displayName: null,
            hasAvatar: false,
            updatedAt: source.updatedAt,
          },
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            role: "operator",
            scopes: ["operator.admin"],
            client: { id: "test", version: "1", platform: "test", mode: "test" },
          },
        };
        params.client = client;
        const mismatch = new SessionMutationAuthorizationChangedError({
          code: "INVALID_REQUEST",
          message: "Selected account changed; select the account again.",
          details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
        });
        // Keep the selected ID exact: resolving both sides would silently follow a merge.
        params.assertCurrent = () => {
          if (resolveUserProfileId(client.authenticatedUserProfile!.profileId) !== source.id) {
            throw mismatch;
          }
        };
        params.assertCurrent();
        const actualRecovery = await vi.importActual<typeof import("./chat-restart-recovery.js")>(
          "./chat-restart-recovery.js",
        );
        const entered = createDeferred();
        const release = createDeferred();
        let recoveryCompleted = false;
        vi.mocked(resolveDurableChatClaim).mockImplementationOnce(async (request) => {
          entered.resolve();
          await release.promise;
          const result = await actualRecovery.resolveDurableChatClaim(request);
          recoveryCompleted = true;
          return result;
        });
        const pending = runChatSendPreAdmission(params);
        try {
          await Promise.race([entered.promise, pending]);
          expect(resolveDurableChatClaim).toHaveBeenCalledOnce();
          if (outcome !== "unchanged") {
            linkEmail(sourceEmail, target.id);
            expect(resolveUserProfileId(source.id)).toBe(target.id);
            expect(client.authenticatedUserProfile?.profileId).toBe(source.id);
          }
          if (outcome === "cached-success" || outcome === "cached-error") {
            fixture.context.dedupe.set(`chat:${params.session.clientRunId}`, {
              ts: 200,
              ok: outcome === "cached-success",
              requestIdentity: params.request.requestIdentity,
              ...(outcome === "cached-success"
                ? { payload: { runId: params.session.clientRunId, status: "ok" } }
                : { error: { code: "UNAVAILABLE", message: "Recorded run failure." } }),
            });
          }
          const originalReceipts = structuredClone([...fixture.context.dedupe]);
          release.resolve();
          const settled = await pending.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );

          expect(recoveryCompleted).toBe(true);
          expect(loadSessionEntry(scope)).toEqual(originalEntry);
          expect([...fixture.context.dedupe]).toEqual(originalReceipts);
          expect(fixture.context.chatAbortControllers.size).toBe(0);
          expect(fixture.context.chatQueuedTurns?.size ?? 0).toBe(0);
          expect(client).not.toHaveProperty("invalidated", true);
          if (outcome === "unchanged") {
            expect(settled).toEqual({ value: true, error: undefined });
          } else {
            expect(settled).toEqual({ value: undefined, error: mismatch });
          }
          expect(fixture.respond).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
        }
      });
    },
  );
});
