import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../../config/sessions/session-sharing-store.native.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";
import type { SessionMutationAuthorization } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("chat admission authority", () => {
  it.each([
    { revokeInCallback: false, scoped: true },
    { revokeInCallback: true, scoped: true },
    { revokeInCallback: true, scoped: false },
  ])(
    "keeps caller authority current through admission callbacks (revoked: $revokeInCallback, scoped: $scoped)",
    async ({ revokeInCallback, scoped }) => {
      const fixture = await createBrowserFollowupFixture();
      const request = await normalizeChatSendRequest({
        params: fixture.params,
        client: fixture.client,
      });
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
      const request = await normalizeChatSendRequest({
        params: fixture.params,
        client: fixture.client,
      });
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
    const request = await normalizeChatSendRequest({
      params: fixture.params,
      client: fixture.client,
    });
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
    const normalized = await normalizeChatSendRequest({
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
});
