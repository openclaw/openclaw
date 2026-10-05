import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../../config/sessions/session-sharing-store.native.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { createExpectedProfileBinding } from "../expected-profile.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import {
  setClientProfile,
  setNativeIosClient,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";
import type { SessionMutationAuthorization } from "./types.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("native profile-bound input admission", () => {
  it.each([
    { admin: true, mainAllowed: true },
    { admin: false, mainAllowed: true },
    { admin: false, mainAllowed: false },
  ])(
    "authorizes the default-scope global alias against main (admin: $admin, allowed: $mainAllowed)",
    async ({ admin, mainAllowed }) => {
      const fixture = await createBrowserFollowupFixture();
      const profile = ensureProfileForEmail("global-alias-caller@example.test");
      const owner = ensureProfileForEmail("global-alias-owner@example.test");
      setClientProfile(fixture.client, profile);
      if (!admin) {
        fixture.client.connect.scopes = ["operator.read", "operator.write"];
      }
      fixture.params.sessionKey = "global";
      fixture.params.agentId = "main";
      const createdActor = { type: "human", source: "profile", id: owner.id } as const;
      await patchSessionEntryCore(fixture.scope, (entry) => ({
        ...entry,
        createdActor,
        visibility: mainAllowed ? "shared" : "draft",
      }));
      const literal = { ...fixture.scope, sessionKey: "global", sessionId: "literal-global" };
      await replaceSessionEntry(literal, {
        sessionId: literal.sessionId,
        updatedAt: 1,
        createdActor,
        visibility: mainAllowed ? "draft" : "shared",
      });
      const projection = admin
        ? undefined
        : await createSessionRowProjection({
            cfg: fixture.context.getRuntimeConfig(),
            modelCatalog: [],
          });
      if (projection) {
        bindSessionRowProjection(fixture.context, () => projection);
      }
      try {
        const respond = await fixture.send(undefined, {});
        if (mainAllowed) {
          expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
          await fixture.dispatchedRecorder;
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
          expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
            total: 1,
            items: [{ runId: fixture.params.idempotencyKey }],
          });
        } else {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
            }),
          );
          expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        }
        expect(await listSessionPendingInputs(literal)).toEqual({ items: [], total: 0 });
        expect(loadTranscriptEventsSync(literal)).toEqual([]);
      } finally {
        await fixture.cleanup();
        projection?.dispose();
        await projection?.ensureMaterialized();
      }
    },
  );

  it.each(["unchanged", "replaced", "hydrated"] as const)(
    "retains the original caller through initial authorization without an expected profile (%s)",
    async (change) => {
      const fixture = await createBrowserFollowupFixture();
      const source = ensureProfileForEmail("initial-chat-source@example.test");
      const replacement = ensureProfileForEmail("initial-chat-replacement@example.test");
      if (change === "hydrated") {
        fixture.client.authenticatedGitHubIdentitySync = async () => {
          setClientProfile(fixture.client, source);
          return { profileId: source.id, updatedAt: source.updatedAt };
        };
      } else {
        setClientProfile(fixture.client, source);
      }
      const entered = createDeferred();
      const release = createDeferred();
      const read = historyLane.pool.run.bind(historyLane.pool);
      let held = false;
      const workerRead = vi
        .spyOn(historyLane.pool, "run")
        .mockImplementation(async (prepare, options) => {
          if (typeof prepare !== "function") {
            return read(prepare, options);
          }
          let authorizationRead = false;
          const result = await read(async () => {
            const input = await prepare();
            authorizationRead =
              input.kind === "session-exact-entries" &&
              input.includeMembers === true &&
              input.selection === undefined &&
              input.sessionKeys.includes(fixture.scope.sessionKey);
            return input;
          }, options);
          if (!held && authorizationRead) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      // An empty binding selects the real router without supplying expectedProfileId.
      const request = fixture.send(undefined, {});
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          request,
          "chat.send settled before its initial authorization read",
        );
        expect(fixture.context.dedupe.size).toBe(0);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        if (change === "replaced") {
          setClientProfile(fixture.client, replacement);
        }
        release.resolve();
        const respond = await request;
        if (change === "replaced") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: "FORBIDDEN",
              message: "Gateway requester authority changed",
            }),
          );
          expect(fixture.context.dedupe.size).toBe(0);
          expect(fixture.context.chatAbortControllers.size).toBe(0);
          expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        } else {
          expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
          await fixture.dispatchedRecorder;
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
        workerRead.mockRestore();
        await request;
        await fixture.cleanup();
      }
    },
  );

  it.each([
    { revokeInCallback: false, scoped: true },
    { revokeInCallback: true, scoped: true },
    { revokeInCallback: true, scoped: false },
  ])(
    "keeps caller authority current through admission callbacks (revoked: $revokeInCallback, scoped: $scoped)",
    async ({ revokeInCallback, scoped }) => {
      const fixture = await createBrowserFollowupFixture();
      const request = normalizeChatSendRequest({ params: fixture.params, client: fixture.client });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const prepared = await prepareChatSendSession({
        request: request.value,
        client: fixture.client,
        context: fixture.context,
      });
      if (!prepared.ok) {
        throw new Error("session preparation failed");
      }
      const session = qualifyChatSendSession(prepared.value);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("caller revoked during admission");
        }
      };
      const withCurrent = async <T>(consume: () => T): Promise<T> => {
        assertCurrent();
        return consume();
      };
      try {
        const admitting = admitChatSend({
          request: request.value,
          session,
          client: fixture.client,
          context: fixture.context,
          respond: vi.fn(),
          ...(scoped ? { assertCurrent, withCurrent } : {}),
          assertCurrentAsync: async () => {
            await withCurrent(assertCurrent);
          },
          ...(revokeInCallback
            ? {
                onAdmissionOwned: async () => {
                  current = false;
                  return true;
                },
              }
            : {}),
        });
        if (revokeInCallback) {
          await expect(admitting).rejects.toThrow("caller revoked during admission");
          expect(fixture.context.chatAbortControllers.size).toBe(0);
        } else {
          const admitted = await admitting;
          expect(admitted.ok).toBe(true);
          if (admitted.ok) {
            admitted.value.cleanupAdmittedRun();
          }
        }
      } finally {
        session.releaseSessionTarget();
        await fixture.cleanup();
      }
    },
  );
  it("clears a pending reservation when its retained reader is revoked after publication", async () => {
    const fixture = await createBrowserFollowupFixture();
    const sessions: Array<ReturnType<typeof qualifyChatSendSession>> = [];
    const prepare = async () => {
      const request = normalizeChatSendRequest({ params: fixture.params, client: fixture.client });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const loaded = await prepareChatSendSession({
        request: request.value,
        client: fixture.client,
        context: fixture.context,
      });
      if (!loaded.ok) {
        throw new Error("session preparation failed");
      }
      const session = qualifyChatSendSession(loaded.value);
      sessions.push(session);
      const resolved = await resolveSessionMutationAuthorizationAsync({
        client: fixture.client,
        method: "chat.send",
        requestParams: fixture.params,
        context: fixture.context,
      });
      const authorization = resolved.authorization;
      if (resolved.error || !authorization?.withCurrent) {
        throw new Error("Expected retained worker authorization");
      }
      return { request: request.value, session, authorization };
    };
    let closing: Promise<void> | undefined;
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      const first = await prepare();
      const pendingKey = first.session.pendingChatSendKey;
      let reservedIdentity: string | undefined;
      const withCurrent: NonNullable<SessionMutationAuthorization["withCurrent"]> = (consume) =>
        first.authorization.withCurrent!(() => {
          const value = consume();
          const reservation = fixture.context.dedupe.get(pendingKey);
          if (reservation && !closing) {
            reservedIdentity = reservation.requestIdentity;
            closing = closeOpenClawAgentDatabasesAsync();
          }
          return value;
        });
      await expect(
        admitChatSend({
          request: first.request,
          session: first.session,
          client: fixture.client,
          context: fixture.context,
          respond: vi.fn(),
          assertCurrent: first.authorization.assertCurrent,
          withCurrent,
          withPreparedCurrent: first.authorization.withPreparedCurrent,
        }),
      ).rejects.toThrow();
      expect(reservedIdentity).toBe(first.request.requestIdentity);
      await closing;
      expect(fixture.context.dedupe.has(pendingKey)).toBe(false);
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(
        getSessionWorkAdmissionRelease({
          scope: fixture.scope.storePath,
          identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
        }),
      ).toBeUndefined();

      fixture.params.message = "Corrected input after the failed reservation.";
      const retry = await prepare();
      admitted = await admitChatSend({
        request: retry.request,
        session: retry.session,
        client: fixture.client,
        context: fixture.context,
        respond: vi.fn(),
        assertCurrent: retry.authorization.assertCurrent,
        withCurrent: retry.authorization.withCurrent,
        withPreparedCurrent: retry.authorization.withPreparedCurrent,
      });
      expect(admitted.ok).toBe(true);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(fixture.params.idempotencyKey);
      await closing;
      for (const session of sessions.toReversed()) {
        session.releaseSessionTarget();
      }
      await fixture.cleanup();
    }
  });

  it("retains callback custody after its real worker reader is revoked", async () => {
    const fixture = await createBrowserFollowupFixture();
    const request = normalizeChatSendRequest({ params: fixture.params, client: fixture.client });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const prepared = await prepareChatSendSession({
      request: request.value,
      client: fixture.client,
      context: fixture.context,
    });
    if (!prepared.ok) {
      throw new Error("session preparation failed");
    }
    const session = qualifyChatSendSession(prepared.value);
    const resolved = await resolveSessionMutationAuthorizationAsync({
      client: fixture.client,
      method: "chat.send",
      requestParams: fixture.params,
      context: fixture.context,
    });
    const authorization = resolved.authorization;
    if (resolved.error || !authorization?.withCurrent) {
      throw new Error("Expected retained worker authorization");
    }
    let retainedRead: Promise<unknown> | undefined;
    const withCurrent: NonNullable<SessionMutationAuthorization["withCurrent"]> = (consume) => {
      const read = authorization.withCurrent!(consume);
      retainedRead = read;
      return read;
    };
    const rootsBefore = getActiveGatewayRootWorkCount();
    const root = tryBeginGatewayRootWorkAdmission("chat-admission-reader-failure");
    if (!root) {
      throw new Error("Expected root admission");
    }
    const caller = captureGatewayDeviceRevocation(
      fixture.context,
      { deviceId: "reader-failure-caller", role: "operator" },
      () => true,
    );
    const entered = createDeferred();
    const finishCallback = createDeferred();
    let closing: Promise<void> | undefined;
    const onAdmissionOwned = vi.fn(async () => {
      // Only the admission's borrowed custody survives the initiating request.
      root.release();
      caller.release();
      closing = closeOpenClawAgentDatabasesAsync();
      entered.resolve();
      await finishCallback.promise;
      return true;
    });
    const admitting = root.run(() =>
      admitChatSend({
        request: request.value,
        session,
        client: fixture.client,
        context: fixture.context,
        respond: vi.fn(),
        hasCurrentClientAuthority: caller.isCurrent,
        assertCurrent: authorization.assertCurrent,
        withCurrent,
        withPreparedCurrent: authorization.withPreparedCurrent,
        onAdmissionOwned,
      }),
    );
    const outcome = admitting.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        outcome,
        "chat admission settled before its owned callback",
      );
      if (!retainedRead) {
        throw new Error("Expected the callback's retained worker read");
      }
      const readerFailure = await retainedRead.then(
        () => {
          throw new Error("Revoked worker reader unexpectedly succeeded");
        },
        (error: unknown) => error,
      );
      expect(readerFailure).toBeInstanceOf(Error);
      const released = getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });
      expect(released).toBeDefined();
      expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 1);
      expect(caller.isCurrent()).toBe(true);
      expect(fixture.context.chatAbortControllers.size).toBe(1);
      finishCallback.resolve();
      expect(await outcome).toEqual({ error: readerFailure });
      await released;
      expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);
      expect(caller.isCurrent()).toBe(false);
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(onAdmissionOwned).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      finishCallback.resolve();
      const result = await outcome;
      if ("value" in result && result.value.ok) {
        result.value.value.cleanupAdmittedRun();
      }
      await closing;
      root.release();
      caller.release();
      session.releaseSessionTarget();
      await fixture.cleanup();
    }
  });

  it("rejects membership revoked inside retained chat admission before dispatch", async () => {
    const fixture = await createBrowserFollowupFixture({
      createdActor: { type: "human", source: "profile", id: "another-profile" },
    });
    const cfg = { ...rolePolicyConfig(), session: { store: fixture.scope.storePath } };
    const member = roleClient("view", "chat-admission-member");
    Object.assign(fixture.client, member, { connId: "chat-admission-member" });
    fixture.context.getRuntimeConfig = () => cfg;
    await patchSessionEntryCore(fixture.scope, (entry) => ({
      ...entry,
      visibility: "read-only",
    }));
    await addSessionMember(fixture.scope, {
      identityId: member.authenticatedUserProfile!.profileId,
      addedBy: "another-profile",
    });
    const normalized = normalizeChatSendRequest({ params: fixture.params, client: fixture.client });
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }
    const prepared = await prepareChatSendSession({
      request: normalized.value,
      client: fixture.client,
      context: fixture.context,
    });
    if (!prepared.ok) {
      throw new Error("session preparation failed");
    }
    const session = qualifyChatSendSession(prepared.value);
    const resolved = await resolveSessionMutationAuthorizationAsync({
      client: fixture.client,
      method: "chat.send",
      requestParams: fixture.params,
      context: fixture.context,
    });
    expect(resolved.error).toBeNull();
    const authorization = resolved.authorization!;
    const respond = vi.fn();
    try {
      await expect(
        admitChatSend({
          request: normalized.value,
          session,
          client: fixture.client,
          context: fixture.context,
          respond,
          assertCurrent: authorization.assertCurrent,
          withCurrent: authorization.withCurrent,
          withPreparedCurrent: (facts, consume, assertSourceCurrent) => {
            removeSessionMemberSync(fixture.scope, member.authenticatedUserProfile!.profileId);
            return authorization.withPreparedCurrent!(facts, consume, assertSourceCurrent);
          },
        }),
      ).resolves.toEqual({ ok: false });
      expect(fixture.context.dedupe.size).toBe(0);
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
    } finally {
      session.releaseSessionTarget();
      await fixture.cleanup();
    }
  });

  it.each(["reservation", "writer", "approval"] as const)(
    "rejects a native account merge at %s without accepting or terminalizing input",
    async (boundary) => {
      const fixture = await createBrowserFollowupFixture();
      const email = "native-source@example.test";
      const source = ensureProfileForEmail(email);
      const target = ensureProfileForEmail("native-target@example.test");
      setNativeIosClient(fixture.client);
      setClientProfile(fixture.client, source);
      const before = loadSessionEntry(fixture.scope);
      const release = createDeferred();
      let writer: Promise<void> | undefined;
      let request: ReturnType<typeof fixture.send> | undefined;
      try {
        if (boundary === "reservation") {
          const normalized = normalizeChatSendRequest({
            params: fixture.params,
            client: fixture.client,
          });
          if (!normalized.ok) {
            throw new Error(normalized.error);
          }
          const prepared = await prepareChatSendSession({
            request: normalized.value,
            client: fixture.client,
            context: fixture.context,
          });
          if (!prepared.ok) {
            throw new Error("Native session preparation failed");
          }
          const session = qualifyChatSendSession(prepared.value);
          const binding = (await createExpectedProfileBinding(source.id, fixture.client))!;
          binding.markInvoked();
          linkEmail(email, target.id);
          await expect(
            admitChatSend({
              request: normalized.value,
              session,
              client: fixture.client,
              context: fixture.context,
              respond: vi.fn(),
              assertCurrent: binding.assertCurrent,
            }).finally(session.releaseSessionTarget),
          ).rejects.toMatchObject({
            error: {
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
            },
          });
          expect(fixture.context.dedupe.size).toBe(0);
        } else {
          if (boundary === "writer") {
            const entered = createDeferred();
            writer = runExclusiveSessionStoreWrite(fixture.scope.storePath, async () => {
              entered.resolve();
              await release.promise;
            });
            await entered.promise;
            const pendingKey = `${PENDING_CHAT_SEND_DEDUPE_PREFIX}${fixture.params.idempotencyKey}`;
            const reserved = createDeferred();
            const setDedupe = fixture.context.dedupe.set.bind(fixture.context.dedupe);
            const observeReservation = vi
              .spyOn(fixture.context.dedupe, "set")
              .mockImplementation((key, entry) => {
                const result = setDedupe(key, entry);
                if (key === pendingKey) {
                  reserved.resolve();
                }
                return result;
              });
            try {
              request = fixture.send(undefined, { expectedProfileId: source.id });
              await awaitGateBeforeSettlement(
                reserved.promise,
                request,
                "chat.send settled before its pending reservation",
              );
              expect(fixture.context.dedupe.has(pendingKey)).toBe(true);
            } finally {
              observeReservation.mockRestore();
            }
            linkEmail(email, target.id);
            release.resolve();
            await writer;
          } else {
            fixture.beforeApprove.mockImplementation(() => linkEmail(email, target.id));
            request = fixture.send(undefined, { expectedProfileId: source.id });
          }
          const respond = await request;
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
            }),
          );
        }
        expect(loadSessionEntry(fixture.scope)).toEqual(before);
        expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        expect(fixture.context.chatAbortControllers.size).toBe(0);
        expect(fixture.context.chatQueuedTurns.size).toBe(0);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        const cached = fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`);
        expect(cached?.payload).toBeUndefined();
        expect(cached?.error).toBeUndefined();
      } finally {
        release.resolve();
        await writer;
        await request;
        await fixture.cleanup();
      }
    },
  );

  it("terminalizes a native command account merge during fresh transcript approval without rewriting the ACK", async () => {
    const fixture = await createBrowserFollowupFixture({ persistDuringDispatch: true });
    fixture.params.message = "/context list";
    const email = "native-approval@example.test";
    const source = ensureProfileForEmail(email);
    const target = ensureProfileForEmail("native-approval-target@example.test");
    setNativeIosClient(fixture.client);
    setClientProfile(fixture.client, source);
    try {
      const ack = await fixture.send(undefined, { expectedProfileId: source.id });
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      expect(fixture.beforeApprove).not.toHaveBeenCalled();
      const recorder = await fixture.dispatchedRecorder;
      const acceptedAck = structuredClone(ack.mock.calls);
      fixture.beforeApprove.mockImplementation(() => linkEmail(email, target.id));
      await fixture.finishDispatch();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect.soft(recorder.getAdmissionReceipt()).toBeUndefined();
      expect.soft(ack.mock.calls).toEqual(acceptedAck);
      expect.soft(ack).toHaveBeenCalledOnce();
      expect.soft(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      const transcript = loadTranscriptEventsSync(fixture.scope);
      expect
        .soft(transcript.filter((entry) => isRecord(entry) && entry.type === "message"))
        .toEqual(
          fixture.activeTranscript.filter((entry) => isRecord(entry) && entry.type === "message"),
        );
      expect.soft(transcript).toContainEqual(
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          display: true,
          details: expect.objectContaining({ runId: fixture.params.idempotencyKey }),
        }),
      );
      expect.soft(loadSessionEntry(fixture.scope)).toMatchObject({
        status: "failed",
        lastRunId: fixture.params.idempotencyKey,
      });
      expect
        .soft(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`))
        .toMatchObject({
          ok: false,
          payload: { runId: fixture.params.idempotencyKey, status: "error" },
          error: { message: expect.stringContaining("Selected account changed") },
        });
      expect.soft(fixture.context.broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId: fixture.params.idempotencyKey,
          state: "error",
          errorMessage: expect.stringContaining("Selected account changed"),
        }),
        expect.anything(),
      );
      expect.soft(fixture.context.chatAbortControllers.size).toBe(0);
      expect.soft(fixture.context.chatQueuedTurns.size).toBe(0);
      expect.soft(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["request-signal abort", "profile merge"] as const)(
    "preserves accepted native input across %s without adopting the retry socket",
    async (change) => {
      const fixture = await createBrowserFollowupFixture();
      const profile = ensureProfileForEmail("native-accepted@example.test");
      fixture.client.connect.client = {
        id: "openclaw-macos",
        version: "test",
        platform: "darwin",
        mode: "ui",
      };
      setClientProfile(fixture.client, profile);
      const requestAbort = new AbortController();
      try {
        const ack = await fixture.send(undefined, {
          expectedProfileId: profile.id,
          signal: requestAbort.signal,
        });
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(committed).toMatchObject({ appended: true });
        const receipt = recorder.getAdmissionReceipt();
        expect(receipt).toBeDefined();
        const accepted = loadTranscriptEventsSync(fixture.scope);
        expect(accepted).toHaveLength(fixture.activeTranscript.length + 1);
        expect(accepted.at(-1)).toMatchObject({
          message: { content: fixture.approvedContent },
        });
        const owner = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
        expect(owner).toBeDefined();
        const ownerConnId = owner?.ownerConnId;
        const cached = structuredClone(
          fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
        );
        if (change === "request-signal abort") {
          requestAbort.abort();
        }
        fixture.client.connId = "native-reconnected";
        if (change === "profile merge") {
          const target = ensureProfileForEmail("native-accepted-target@example.test");
          linkEmail("native-accepted@example.test", target.id);
        }
        const retry = await fixture.send(undefined, { expectedProfileId: profile.id });
        if (change === "profile merge") {
          expect(retry).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
            }),
          );
        } else {
          expect(retry.mock.calls[0]?.[1]).toMatchObject({ status: "in_flight" });
        }
        expect(fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey)).toBe(owner);
        expect(owner?.ownerConnId).toBe(ownerConnId);
        expect(owner?.controller.signal.aborted).toBe(false);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(accepted);
        expect(recorder.getAdmissionReceipt()).toEqual(receipt);
        expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toEqual(cached);
        expect(await recorder.persistApproved()).toEqual(committed);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(accepted);
        expect(recorder.getAdmissionReceipt()).toEqual(receipt);
        expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["host", "session ACL", "lifecycle"] as const)(
    "retains original %s authority after committed browser custody and profile merge",
    async (boundary) => {
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        persistDuringDispatch: true,
      });
      let hostCurrent = true;
      try {
        const email = "retained-authority@example.test";
        const profile = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("retained-authority-target@example.test");
        setClientProfile(fixture.client, profile);
        if (boundary === "session ACL") {
          fixture.client.connect.scopes = ["operator.read", "operator.write"];
        }
        const ack = await fixture.send(undefined, {
          expectedProfileId: profile.id,
          sessionMutationCommitGuard: () => {
            if (!hostCurrent) {
              throw new Error("The original input host has closed.");
            }
          },
        });
        expect(ack).toHaveBeenCalledOnce();
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        const originalAck = structuredClone(ack.mock.calls);
        const pending = await listSessionPendingInputs(fixture.scope);
        expect(pending).toMatchObject({
          total: 1,
          items: [{ state: "queued", message: { content: fixture.params.message } }],
        });
        await fixture.dispatchedRecorder;
        linkEmail(email, target.id);
        if (boundary === "host") {
          hostCurrent = false;
        } else if (boundary === "session ACL") {
          await patchSessionEntryCore(fixture.scope, () => ({ visibility: "draft" }));
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        await fixture.finishDispatch();
        expect(ack.mock.calls).toEqual(originalAck);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expect(
          loadTranscriptEventsSync(fixture.scope).filter(
            (entry) =>
              isRecord(entry) &&
              entry.type === "message" &&
              isRecord(entry.message) &&
              entry.message.idempotencyKey === `${fixture.params.idempotencyKey}:user`,
          ),
        ).toEqual([]);
        expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [
            {
              id: pending.items[0]?.id,
              state: "interrupted",
              message: pending.items[0]?.message,
            },
          ],
        });
        const cached = structuredClone(
          fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
        );
        expect(cached).toMatchObject({
          ok: false,
          payload: { runId: fixture.params.idempotencyKey, status: "error" },
        });
        expect(fixture.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: fixture.params.idempotencyKey,
            state: "error",
            errorMessage: expect.any(String),
          }),
          expect.anything(),
        );
        const retry = await fixture.send(undefined, { expectedProfileId: profile.id });
        expect(retry).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
          }),
        );
        expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toEqual(cached);
        expect(fixture.context.chatAbortControllers.size).toBe(0);
        expect(fixture.context.chatQueuedTurns.size).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
