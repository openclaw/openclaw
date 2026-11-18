import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  MessageInjectionAcceptedUnconfirmedError,
  MessageInjectionAuthorityError,
  MessageInjectionTargetUnavailableError,
} from "../../auto-reply/reply/message-injection-authority.js";
import {
  readSessionSubmittedInput,
  listSessionPendingInputs,
} from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { captureSessionQueuedInputsForRestart } from "../../config/sessions/session-pending-input-history.js";
import * as pendingInputStore from "../../config/sessions/session-pending-input-store.js";
import * as identity from "../../infra/device-identity-async.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.backend-contracts.js";
import * as continuation from "../../sessions/session-controller.message-join.js";
import { continueSessionQueuedInputs } from "../queued-chat-inputs.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { bindChatProfile } from "./chat-send-admission-fixtures.test-support.js";
import { bindSteeringTools } from "./chat-send-authority.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { bindInProcessRequestMutationAuthority } from "./session-mutation-guards.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBaseFixture = useBrowserFollowupFixture();
async function createFixture(options: Parameters<typeof createBaseFixture>[0] = {}) {
  const fixture = await createBaseFixture(options);
  const projection = await createSessionRowProjection({
    cfg: fixture.context.getRuntimeConfig(),
    getConfig: fixture.context.getRuntimeConfig,
    modelCatalog: [],
  });
  bindSessionRowProjection(fixture.context, () => projection);
  await projection.ensureMaterialized();
  return {
    ...fixture,
    [Symbol.asyncDispose]: async () => {
      projection.dispose();
      await fixture[Symbol.asyncDispose]();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
function human(f: Fixture) {
  const { profile } = bindChatProfile(f.client, "active-steer@example.test", true);
  f.client.authenticatedUserId = profile.id;
  f.client.internal = { ...f.client.internal, authenticatedOperator: true };
  f.context.getClientConnIds = (filter) =>
    new Set(f.client.connId && (!filter || filter(f.client)) ? [f.client.connId] : []);
  return profile;
}
function send(f: Fixture, changes: Record<string, unknown> = {}) {
  const params = {
    sessionKey: f.scope.sessionKey,
    sessionId: f.scope.sessionId,
    runId: "active-steer-run",
    message: "/stop literal",
    idempotencyKey: "active-steer-input",
    ...changes,
  };
  const respond = vi.fn<RespondFn>();
  return handleGatewayRequest(
    bindInProcessRequestMutationAuthority(
      {
        req: { type: "req", id: "steer-request", method: "sessions.steerActive", params },
        params,
        client: f.client,
        context: f.context,
        respond,
        isWebchatConnect: () => true,
      },
      undefined,
      undefined,
    ),
  ).then(() => respond);
}
function attach(
  f: Fixture,
  queueMessage: ReplyBackendMessageInjectionV2["queueMessage"],
  replace = false,
) {
  const op = f.activeRun!;
  const fingerprint = "active-steer-tools";
  if (!replace) {
    bindSteeringTools(op, fingerprint);
  }
  op.setPhase("running");
  op.attachBackend({
    kind: "embedded",
    runId: "active-steer-run",
    toolAuthorityFingerprint: fingerprint,
    supportsTranscriptCommitWait: true,
    cancel: vi.fn(),
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  });
  return op;
}
it("delivers literal human input once and reconciles the durable receipt", async () => {
  await using f = await createFixture({ preserveContent: true });
  const profile = human(f);
  const received = vi.fn();
  const op = attach(f, async (text, options, assertCurrent) => {
    assertCurrent();
    const staged = await readSessionSubmittedInput(f.scope, "active-steer-input:user", {
      includeSource: true,
    });
    expect(staged?.message["__openclaw"]).toMatchObject({
      activeSteer: {
        profileId: profile.id,
        runId: "active-steer-run",
        sessionId: f.scope.sessionId,
      },
    });
    received(text);
    await options?.userTurnTranscriptRecorder?.persistApproved();
    options?.onQueueAccepted?.(true);
  });
  const first = await send(f);
  expect(first.mock.calls[0]).toMatchObject({
    0: true,
    1: { status: "accepted", receiptPersisted: true },
  });
  expect(received).toHaveBeenCalledExactlyOnceWith("/stop literal");
  expect(op.result).toBeNull();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  f.context.dedupe.clear();
  const replay = await send(f);
  expect(replay.mock.calls[0]).toMatchObject({
    0: true,
    1: { status: "accepted", receiptPersisted: true },
  });
  expect(received).toHaveBeenCalledOnce();
  const source = await readSessionSubmittedInput(f.scope, "active-steer-input:user", {
    includeSource: true,
  });
  expect(source?.message["__openclaw"]).toMatchObject({
    activeSteer: { profileId: profile.id, runId: "active-steer-run", sessionId: f.scope.sessionId },
    requesterOrigin: { operatorProfileId: profile.id },
  });
  expect(source?.completion?.activeSteer?.status).toBe("accepted");
  expect((await send(f, { message: "changed" })).mock.calls[0]?.[0]).toBe(false);
  expect((await send(f, { runId: "different-run" })).mock.calls[0]?.[0]).toBe(false);
});
it.each(["idle", "wrong-run", "wrong-session", "unsupported"])(
  "rejects %s without dispatch or interruption",
  async (kind) => {
    await using f = await createFixture({ active: kind !== "idle", preserveContent: true });
    human(f);
    const received = vi.fn();
    if (kind !== "idle" && kind !== "unsupported") {
      attach(f, async () => {
        received();
      });
    }
    const result = await send(
      f,
      kind === "wrong-run"
        ? { runId: "other" }
        : kind === "wrong-session"
          ? { sessionId: "other" }
          : {},
    );
    expect(result.mock.calls[0]?.[0]).toBe(false);
    expect(result.mock.calls[0]?.[2]?.message).toMatch(
      kind === "wrong-session" ? /conversation changed/ : /not active|does not support steering/,
    );
    expect(received).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(f.readTranscript()).toEqual(f.activeTranscript);
  },
);
it.each(["anonymous", "synthetic", "forged-sender", "read-only"])(
  "refuses %s identity",
  async (kind) => {
    await using f = await createFixture({ preserveContent: true });
    human(f);
    if (kind === "anonymous") {
      f.client.authenticatedUserProfile = undefined;
    }
    if (kind === "synthetic") {
      f.client.internal!.syntheticClient = true;
    }
    if (kind === "forged-sender") {
      f.client.internal!.senderAttribution = { id: "forged" };
    }
    if (kind === "read-only") {
      f.client.connect.scopes = ["operator.read"];
    }
    const received = vi.fn();
    attach(f, async () => {
      received();
    });
    const result = await send(f);
    expect(result.mock.calls[0]?.[0]).toBe(false);
    expect(received).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  },
);
it("joins concurrent duplicates and never retries an unconfirmed native acceptance", async ({
  signal,
}) => {
  await using f = await createFixture({ preserveContent: true });
  human(f);
  const entered = createDeferred();
  const release = createDeferred();
  const calls = vi.fn();
  attach(f, async (_text, options) => {
    calls();
    entered.resolve();
    await withinTest(release.promise, signal);
    options?.onQueueAccepted?.(true);
    throw new MessageInjectionAcceptedUnconfirmedError({
      cause: new Error("synthetic lost native response"),
    });
  });
  const first = send(f);
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, first, "Steer returned before native admission"),
      signal,
    );
    const retry = await send(f);
    expect(retry.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "in_flight" } });
  } finally {
    release.resolve();
  }
  expect((await first).mock.calls[0]).toMatchObject({
    0: true,
    1: { status: "indeterminate", receiptPersisted: true },
  });
  f.context.dedupe.clear();
  expect((await send(f)).mock.calls[0]).toMatchObject({ 0: true, 1: { status: "indeterminate" } });
  expect(calls).toHaveBeenCalledOnce();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});
it.each(["replacement", "completed", "scope-revoked"])(
  "does not deliver after %s during approval",
  async (change) => {
    await using f = await createFixture({ preserveContent: true });
    human(f);
    const original = vi.fn();
    const replacement = vi.fn();
    const op = attach(f, async () => {
      original();
    });
    f.beforeApprove.mockImplementationOnce(() => {
      if (change === "replacement") {
        attach(
          f,
          async () => {
            replacement();
          },
          true,
        );
      } else if (change === "completed") {
        op.complete();
      } else {
        f.client.connect.scopes = ["operator.read"];
      }
    });
    const response = await send(f);
    expect(response.mock.calls[0]?.[1]).not.toMatchObject({ status: "accepted" });
    expect(f.readTranscript()).toEqual(f.activeTranscript);
    expect(f.beforeApprove).toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  },
);
it("accepts a host-bound person ingress but rejects it after revocation", async () => {
  await using f = await createFixture({ preserveContent: true });
  const profile = human(f);
  const grant = new AbortController();
  const ingress = createRemoteControlUiIngressTestContext({
    principal: { kind: "person", profileId: profile.id },
    signal: grant.signal,
    assertCurrent: () => grant.signal.throwIfAborted(),
  });
  const principal = ingress.resolvePrincipal();
  f.client.internal = {
    ...f.client.internal,
    remoteIngressPrincipal: principal,
    operatorRoleActor: principal.operatorRoleActor,
  };
  f.client.authenticatedUserProfile = principal.authenticatedUserProfile;
  delete f.client.connId;
  const received = vi.fn();
  attach(f, async (_text, options) => {
    received();
    options?.onQueueAccepted?.(true);
  });
  expect((await send(f)).mock.calls[0]?.[1]).toMatchObject({ status: "accepted" });
  grant.abort();
  await expect(send(f, { idempotencyKey: "after-revocation" })).rejects.toThrow("aborted");
  expect(received).toHaveBeenCalledOnce();
});
it("never replays retained active-only input during restart recovery", async () => {
  await using f = await createFixture({ active: false, preserveContent: true });
  const input = await stageSessionPendingInput(f.scope, {
    runId: "restart-steer",
    message: {
      role: "user",
      timestamp: 1,
      content: "never dispatch",
      idempotencyKey: "restart-steer:user",
      __openclaw: {
        activeSteer: {
          runId: "ended-run",
          profileId: "fixture-person",
          sessionId: f.scope.sessionId,
        },
      },
    },
    assertCurrent() {},
  });
  if (!input) {
    throw new Error("Missing retained input");
  }
  const retained = await captureSessionQueuedInputsForRestart(f.scope);
  retained.preserve();
  input.finish("interrupted", "restart-unrecoverable");
  await input.settled?.();
  await continueSessionQueuedInputs(f.context, f.scope, {
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  const pending = await listSessionPendingInputs(f.scope);
  expect(pending.items).toMatchObject([{ state: "cancelled", endCause: "restart-unrecoverable" }]);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(f.readTranscript()).toEqual(f.activeTranscript);
});
it("preserves accepted delivery when the completion store fails and does not reinject", async () => {
  await using f = await createFixture({ preserveContent: true });
  human(f);
  const originalPrepare = pendingInputStore.preparePendingInputStore;
  const failure = new Error("synthetic completion write failure");
  const injectedFailure = vi
    .spyOn(pendingInputStore, "preparePendingInputStore")
    .mockImplementation(async (...args) => {
      const store = await originalPrepare(...args);
      return {
        ...store,
        mutate: async (...mutationArgs) => {
          if (mutationArgs[0].kind === "complete") {
            throw failure;
          }
          return store.mutate(...mutationArgs);
        },
      };
    });
  const received = vi.fn();
  attach(f, async (_text, options) => {
    received();
    options?.onQueueAccepted?.(true);
  });
  try {
    expect((await send(f)).mock.calls[0]).toMatchObject({
      0: true,
      1: { status: "accepted", receiptPersisted: false },
    });
  } finally {
    injectedFailure.mockRestore();
  }
  f.context.dedupe.clear();
  expect((await send(f)).mock.calls[0]).toMatchObject({
    0: true,
    1: { status: "indeterminate", receiptPersisted: false },
  });
  expect(received).toHaveBeenCalledOnce();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});
it.each(["rejected", "accepted"] as const)(
  "reconciles %s without a transcript after the target ends",
  async (status) => {
    await using f = await createFixture({ preserveContent: true });
    human(f);
    const received = vi.fn();
    const op = attach(f, async (_text, options) => {
      received();
      if (status === "rejected") {
        throw new MessageInjectionTargetUnavailableError("synthetic refusal");
      }
      const recorder = options?.userTurnTranscriptRecorder;
      if (!recorder) {
        throw new Error("Missing native input recorder");
      }
      vi.spyOn(recorder, "persistFallback").mockRejectedValue(
        new Error("synthetic transcript failure"),
      );
      options?.onQueueAccepted?.(true);
    });
    const first = await send(f);
    expect(first.mock.calls[0]).toMatchObject({
      0: true,
      1: { status, runId: "active-steer-run", receiptPersisted: true },
    });
    expect(f.readTranscript()).toEqual(f.activeTranscript);
    const source = await readSessionSubmittedInput(f.scope, "active-steer-input:user", {
      includeSource: true,
    });
    expect(source?.completion?.activeSteer).toMatchObject({ status, runId: "active-steer-run" });
    expect(source?.message["__openclaw"]).toMatchObject({
      activeSteer: { runId: "active-steer-run" },
    });
    f.context.dedupe.clear();
    expect((await send(f)).mock.calls[0]).toMatchObject({
      0: true,
      1: { status, receiptPersisted: true },
    });
    op.complete();
    f.context.dedupe.clear();
    expect((await send(f)).mock.calls[0]).toMatchObject({
      0: true,
      1: { status, receiptPersisted: true },
    });
    expect((await send(f, { message: "changed" })).mock.calls[0]?.[0]).toBe(false);
    expect((await send(f, { runId: "different-run" })).mock.calls[0]?.[0]).toBe(false);
    expect(received).toHaveBeenCalledOnce();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  },
);
it("rejects failed preparation without recording undelivered text", async () => {
  await using f = await createFixture({ preserveContent: true });
  human(f);
  const received = vi.fn();
  attach(f, async () => {
    received();
  });
  vi.spyOn(continuation, "prepareReplyMessageContinuation").mockRejectedValueOnce(
    new Error("synthetic pre-native preparation failure"),
  );
  expect((await send(f)).mock.calls[0]).toMatchObject({
    0: true,
    1: { status: "rejected", receiptPersisted: true },
  });
  expect(f.readTranscript()).toEqual(f.activeTranscript);
  expect(received).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});
it("keeps a proven native authority refusal rejected without persisting text", async () => {
  await using f = await createFixture({ preserveContent: true });
  human(f);
  const attempted = vi.fn();
  attach(f, async () => {
    attempted();
    throw new MessageInjectionAuthorityError();
  });
  expect((await send(f)).mock.calls[0]).toMatchObject({
    0: true,
    1: { status: "rejected", receiptPersisted: true },
  });
  expect(f.readTranscript()).toEqual(f.activeTranscript);
  expect(attempted).toHaveBeenCalledOnce();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});
it.each(["run", "person"])(
  "keyless retries reject a different %s after RAM dedupe is cleared",
  async (change) => {
    await using f = await createFixture({ preserveContent: true });
    human(f);
    const unavailable = vi
      .spyOn(identity, "loadChatRequestIdentityKeyAsync")
      .mockResolvedValue(null);
    const received = vi.fn();
    attach(f, async (_text, options) => {
      received();
      options?.onQueueAccepted?.(true);
    });
    try {
      expect((await send(f)).mock.calls[0]?.[1]).toMatchObject({ status: "accepted" });
      f.context.dedupe.clear();
      expect((await send(f)).mock.calls[0]?.[1]).toMatchObject({ status: "accepted" });
      if (change === "person") {
        const { profile } = bindChatProfile(f.client, "other-steer@example.test", true);
        f.client.authenticatedUserId = profile.id;
      }
      const retry = await send(f, change === "run" ? { runId: "never-targeted-run" } : {});
      expect(retry.mock.calls[0]).toMatchObject({
        0: false,
        2: { details: { reason: "chat-request-conflict" } },
      });
      expect(received).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      unavailable.mockRestore();
    }
  },
);
