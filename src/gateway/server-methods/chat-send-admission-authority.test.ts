import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
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
  beginSessionEffect,
  getCompetingSessionWorkAdmissionRelease,
} from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { SessionMutationAuthorizationChangedError as AuthorizationChangedError } from "../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import {
  prepareAuthorizedChatAdmission,
  prepareChatAdmission,
} from "./chat-send-admission.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import type { SessionMutationAuthorization } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

async function authorize(fixture: Parameters<typeof prepareAuthorizedChatAdmission>[0]) {
  return { ...(await prepareAuthorizedChatAdmission(fixture)), respond: vi.fn() };
}
const outcomeOf = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const expectFailed = (outcome: { value: unknown } | { error: unknown }) =>
  expect(outcome).toEqual(
    "error" in outcome ? { error: expect.any(Error) } : { value: { ok: false } },
  );
function lifecycleRelease(fixture: Awaited<ReturnType<typeof createBrowserFollowupFixture>>) {
  return getCompetingSessionWorkAdmissionRelease({
    scope: fixture.scope.storePath,
    identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
  });
}

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
    const revoke = async () => {
      current = false;
      return true;
    };
    const admitting = admitChatSend({
      ...prepared,
      respond: vi.fn(),
      ...(scoped ? { assertCurrent, withCurrent } : {}),
      assertCurrentAsync: () => withCurrent(assertCurrent),
      onAdmissionOwned: revokeInCallback ? revoke : undefined,
    });
    if (revokeInCallback) {
      await expect(admitting).rejects.toThrow("caller revoked during admission");
      expect(rpcSourceTesting.size).toBe(0);
    } else {
      const admitted = await admitting;
      assert(admitted.ok);
      admitted.value.cleanupAdmittedRun();
    }
  },
);
it("clears a pending reservation when its retained reader is revoked after publication", async () => {
  await using fixture = await createBrowserFollowupFixture();
  let closing: Promise<void> | undefined;
  let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
  try {
    const first = await authorize(fixture);
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
    const revoked = await outcomeOf(admitChatSend({ ...first, withCurrent }));
    expectFailed(revoked);
    expect(reservedIdentity).toBe(first.request.requestIdentity);
    await closing;
    expect(fixture.context.dedupe.has(pendingKey)).toBe(false);
    expect(rpcSourceTesting.size).toBe(0);
    expect(lifecycleRelease(fixture)).toBeUndefined();

    fixture.params.message = "Corrected input after the failed reservation.";
    admitted = await admitChatSend(await authorize(fixture));
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
  const prepared = await authorize(fixture);
  let retainedRead: Promise<unknown> | undefined;
  const withCurrent: NonNullable<SessionMutationAuthorization["withCurrent"]> = (consume) =>
    (retainedRead = prepared.authorization.withCurrent!(consume));
  const rootsBefore = getActiveGatewayRootWorkCount();
  const root = tryBeginGatewayRootWorkAdmission("chat-admission-reader-failure");
  assert(root, "Expected root admission");
  const caller = captureGatewayDeviceRevocation(
    fixture.context,
    { deviceId: "caller", role: "operator" },
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
      hasCurrentClientAuthority: caller.isCurrent,
      withCurrent,
      onAdmissionOwned,
    }),
  );
  const outcome = outcomeOf(admitting);
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      outcome,
      "chat admission settled before its owned callback",
    );
    assert(retainedRead, "Expected the callback's retained worker read");
    const [readerOutcome] = await Promise.allSettled([retainedRead]);
    const released = lifecycleRelease(fixture);
    expect(released).toBeDefined();
    expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 1);
    expect(caller.isCurrent()).toBe(true);
    expect(rpcSourceTesting.size).toBe(1);
    finishCallback.resolve();
    const result = await outcome;
    if (readerOutcome.status === "rejected") {
      expect(readerOutcome.reason).toBeInstanceOf(Error);
      expect(result).toEqual({ error: readerOutcome.reason });
    } else {
      expectFailed(result);
    }
    await released;
    expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);
    expect(caller.isCurrent()).toBe(false);
    expect(rpcSourceTesting.size).toBe(0);
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
  await patchSessionEntryCore(fixture.scope, () => ({ visibility: "read-only" }));
  await addSessionMember(fixture.scope, {
    identityId: member.authenticatedUserProfile!.profileId,
    addedBy: "another-profile",
  });
  const prepared = await authorize(fixture);
  const { authorization, authorizationError, respond } = prepared;
  expect(authorizationError).toBeNull();
  await expect(
    admitChatSend({
      ...prepared,
      withPreparedCurrent: (facts, consume, assertSourceCurrent) => {
        removeSessionMemberSync(fixture.scope, member.authenticatedUserProfile!.profileId);
        return authorization.withPreparedCurrent!(facts, consume, assertSourceCurrent);
      },
    }),
  ).resolves.toEqual({ ok: false });
  expect(fixture.context.dedupe.size).toBe(0);
  expect(rpcSourceTesting.size).toBe(0);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
});

it("joins a session write still publishing when durable recovery reconciliation resumes", async () => {
  const fixture = await createBrowserFollowupFixture({ active: false });
  await patchSessionEntryCore(fixture.scope, () => ({
    status: "failed",
    restartRecoveryRuns: [{ runId: "cancelled-turn", lifecycleGeneration: "cancelled" }],
  }));
  const prepared = await authorize(fixture);
  const { prepared: session, authorization, respond } = prepared;
  const storePath = session.readSource?.path;
  assert(storePath, "Expected durable session store");
  const { identity } = readOpenClawAgentDatabaseIdentity(
    openOpenClawAgentDatabase({ agentId: "main", path: storePath }),
  );
  assert(typeof identity === "string", "Expected durable session store identity");
  const cancelledTurn = await beginSessionEffect({
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
      return read.finally(() => {
        terminalWrite.begin([session.sessionKey], []);
        expect(() => authorization.assertCurrent()).toThrow(AuthorizationChangedError);
      });
    }
    if (terminalPublication === "publishing") {
      terminalPublication = "settled";
      terminalWrite.settle(undefined, false);
    }
    return read;
  };
  try {
    await expect(runChatSendPreAdmission({ ...prepared, session, withCurrent })).resolves.toBe(
      true,
    );
    expect(terminalPublication).toBe("settled");
    expect(respond).not.toHaveBeenCalled();
  } finally {
    terminalWrite.settle(undefined, false);
    cancelledTurn.release();
    authorization.release?.();
    await fixture.cleanup();
  }
});
