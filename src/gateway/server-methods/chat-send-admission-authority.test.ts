import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { retainSessionEntryWorkerPublication } from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../../config/sessions/session-sharing-store.native.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionRelease,
} from "../../sessions/session-lifecycle-admission.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import {
  prepareAuthorizedChatAdmission,
  prepareChatAdmission,
} from "./chat-send-admission.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
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
      await using fixture = await createBrowserFollowupFixture();
      const prepared = await prepareChatAdmission(fixture);
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
      const admitting = admitChatSend({
        ...prepared,
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
    },
  );
  it("clears a pending reservation when its retained reader is revoked after publication", async () => {
    await using fixture = await createBrowserFollowupFixture();
    const prepare = () => prepareAuthorizedChatAdmission(fixture);
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
            // The revoker is independent of the admission's writer custody.
            closing = runInDetachedAsyncContext(closeOpenClawAgentDatabasesAsync);
          }
          return value;
        });
      const revoked = await admitChatSend({
        ...first,
        respond: vi.fn(),
        withCurrent,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if ("error" in revoked) {
        expect(revoked.error).toBeInstanceOf(Error);
      } else {
        expect(revoked.value).toEqual({ ok: false });
      }
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
        ...retry,
        respond: vi.fn(),
      });
      expect(admitted.ok).toBe(true);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(fixture.params.idempotencyKey);
      await closing;
    }
  });

  it("retains callback custody during database closure", async () => {
    await using fixture = await createBrowserFollowupFixture();
    const prepared = await prepareAuthorizedChatAdmission(fixture);
    const { authorization } = prepared;
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
      closing = runInDetachedAsyncContext(closeOpenClawAgentDatabasesAsync);
      entered.resolve();
      await finishCallback.promise;
      return true;
    });
    const admitting = root.run(() =>
      admitChatSend({
        ...prepared,
        respond: vi.fn(),
        hasCurrentClientAuthority: caller.isCurrent,
        withCurrent,
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
      // Closure can reach the reader after its synchronous consumption finishes.
      const [readerOutcome] = await Promise.allSettled([retainedRead]);
      const released = getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });
      expect(released).toBeDefined();
      expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 1);
      expect(caller.isCurrent()).toBe(true);
      expect(fixture.context.chatAbortControllers.size).toBe(1);
      finishCallback.resolve();
      const result = await outcome;
      if (readerOutcome.status === "rejected") {
        expect(readerOutcome.reason).toBeInstanceOf(Error);
        expect(result).toEqual({ error: readerOutcome.reason });
      } else if ("error" in result) {
        expect(result.error).toBeInstanceOf(Error);
      } else {
        expect(result.value).toEqual({ ok: false });
      }
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
    }
  });

  it("rejects membership revoked inside retained chat admission before dispatch", async () => {
    await using fixture = await createBrowserFollowupFixture({
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
    const prepared = await prepareAuthorizedChatAdmission(fixture);
    const { authorization, authorizationError } = prepared;
    expect(authorizationError).toBeNull();
    const respond = vi.fn();
    await expect(
      admitChatSend({
        ...prepared,
        respond,
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
  });

  it("joins a session write still publishing when durable recovery reconciliation resumes", async () => {
    const fixture = await createBrowserFollowupFixture({ active: false });
    // A cancelled restart-safe turn keeps its recovery claim until its terminal write lands.
    await patchSessionEntryCore(fixture.scope, (entry) => ({
      ...entry,
      status: "failed",
      restartRecoveryRuns: [{ runId: "cancelled-turn", lifecycleGeneration: "cancelled" }],
    }));
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
    const session = prepared.value;
    const storePath = session.readSource?.path;
    if (!storePath) {
      throw new Error("Expected durable session store");
    }
    const { identity } = readOpenClawAgentDatabaseIdentity(
      openOpenClawAgentDatabase({ agentId: "main", path: storePath }),
    );
    if (typeof identity !== "string") {
      throw new Error("Expected durable session store identity");
    }
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
    // The cancelled turn still owns its lifecycle, so reconciliation leaves its claim alone.
    const cancelledTurn = await beginSessionWorkAdmission({
      scope: session.storePath,
      identities: [session.sessionKey, fixture.scope.sessionId],
    });
    const terminalWrite = retainSessionEntryWorkerPublication({
      agentId: "main",
      storePath,
      databaseIdentity: identity,
    });
    let terminalPublication: "pending" | "publishing" | "settled" = "pending";
    const withCurrent: NonNullable<SessionMutationAuthorization["withCurrent"]> = (consume) => {
      const read = authorization.withCurrent!(consume);
      if (terminalPublication === "pending") {
        terminalPublication = "publishing";
        // The terminal write starts publishing after the initial decision, while recovery reconciles.
        return read.finally(() => {
          terminalWrite.begin([session.sessionKey], []);
          expect(() => authorization.assertCurrent()).toThrow(
            SessionMutationAuthorizationChangedError,
          );
        });
      }
      if (terminalPublication === "publishing") {
        // It settles only after the next authority read has joined its publication.
        terminalPublication = "settled";
        terminalWrite.settle(undefined, false);
      }
      return read;
    };
    const respond = vi.fn();
    try {
      await expect(
        runChatSendPreAdmission({
          request: normalized.value,
          session,
          client: fixture.client,
          context: fixture.context,
          respond,
          assertCurrent: authorization.assertCurrent,
          withCurrent,
        }),
      ).resolves.toBe(true);
      expect(terminalPublication).toBe("settled");
      expect(respond).not.toHaveBeenCalled();
    } finally {
      terminalWrite.settle(undefined, false);
      cancelledTurn.release();
      authorization.release?.();
      await fixture.cleanup();
    }
  });
});
