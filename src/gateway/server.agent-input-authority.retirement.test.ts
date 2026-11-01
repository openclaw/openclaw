import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsCreateTool } from "../agents/tools/sessions-create-tool.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { readReplySourceInput } from "../auto-reply/reply/reply-source-binding.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import {
  holdExecution,
  installAuthorityProofKernel,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  agentCommandMock,
  dispatchInboundMessageMock,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

const { kernel } = installAuthorityProofKernel();

it("rejects retained agent and independent-creation input after acceptance", async ({ signal }) => {
  await prepareGatewayReplyRuntimeForTest();
  const { gatewayRequestContext: context, gatewayInstanceRuntime: runtime } = kernel();
  const runId = randomUUID();
  const parentKey = `agent:main:parent:${runId}`;
  const childKey = `agent:main:subagent:${runId}`;
  const sessionId = `child-${runId}`;
  const message = "synthetic input held across Gateway instance retirement";
  await sessionAccessor.upsertSessionEntryCore(
    { agentId: "main", sessionKey: childKey },
    { sessionId, updatedAt: Date.now() },
  );
  const sessionScope = async (sessionKey: string, id: string) => ({
    agentId: "main",
    sessionKey,
    sessionId: id,
    storePath: (await loadSessionEntryAsync(sessionKey, { agentId: "main" })).storePath,
  });
  const scope = await sessionScope(childKey, sessionId);
  const transcript = sessionAccessor.loadTranscriptEventsSync(scope);
  const client = createOperatorClient({ profileName: randomUUID(), scopes: ["operator.admin"] });
  const operator = expectDefined(
    await captureGatewayOperatorRunAuthority({ client, context }),
    "creation operator",
  );
  const prepareParent = (creation = false) => {
    const parentRunId = `${creation ? "creation-parent" : "parent"}-${runId}`;
    return prepareAgentRunAdmission({
      cfg: context.getRuntimeConfig(),
      operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
      ...(creation ? { operatorAuthority: operator.authority } : {}),
      facts: {
        runId: parentRunId,
        agentId: "main",
        ingress: creation
          ? { kind: "gateway-client", boundary: "agent", state: "present" }
          : { kind: "system", boundary: "spawn-input-proof", state: "present" },
      },
    });
  };
  const admission = prepareParent();
  const creationAdmission = prepareParent(true);
  const releaseExecution = createDeferred();
  const createCaller = async (parent: ReturnType<typeof prepareAgentRunAdmission>) =>
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: await parent.admit("embedded"),
      agentId: "main",
      sessionKey: parentKey,
    });
  const held = await holdExecution(signal);
  const release = () => releaseExecution.resolve();
  signal.addEventListener("abort", release, { once: true });
  let dispatch: Promise<unknown> | undefined;
  let restoreRuntimeRelease: (() => void) | undefined;
  let createdWorkReleased: Promise<void> | undefined;
  try {
    const guard = await withGatewayToolCallerIdentity(
      await createCaller(admission),
      captureAgentToolSourceExecutionGuard,
    );
    dispatch = dispatchGatewayMethodInProcess(
      "agent",
      { message, sessionKey: childKey, idempotencyKey: runId },
      {
        forceSyntheticClient: true,
        resolveGatewayContext: context.resolveGatewayContext,
        sessionMutationCommitGuard: guard,
      },
    );
    const accepted = await dispatch;
    expect(accepted).toMatchObject({ runId, sessionKey: childKey, status: "accepted" });
    const originalAck = structuredClone(accepted);
    const {
      userTurn,
      activeRunAbort: abort,
      activeGatewayWorkAdmission,
      preparedModelRuntimeLease,
    } = await held.entered;
    const pending = await listSessionPendingInputs(scope);
    expect(pending).toMatchObject({
      total: 1,
      items: [
        {
          runId,
          state: "queued",
          message: { idempotencyKey: `${runId}:user`, content: message },
        },
      ],
    });
    expect(userTurn.recorder?.getPendingInputMessage?.()).toEqual(pending.items[0]?.message);
    const workAdmission = expectDefined(
      activeGatewayWorkAdmission,
      "prepared Gateway work custody",
    );
    expect(workAdmission.isActive()).toBe(true);
    expect(rpcSourceTesting.get(runId)).toBe(abort.entry);
    expect(abort.controller.signal.aborted).toBe(false);
    expect(() => guard()).not.toThrow();
    const runtimeRelease = vi.spyOn(
      expectDefined(preparedModelRuntimeLease, "ready session runtime"),
      Symbol.asyncDispose,
    );
    restoreRuntimeRelease = () => runtimeRelease.mockRestore();

    const creationCaller = await createCaller(creationAdmission);
    const creationGuard = await withGatewayToolCallerIdentity(
      creationCaller,
      captureAgentToolSourceExecutionGuard,
    );
    const createdInputEntered = createDeferred<Parameters<typeof dispatchInboundMessage>[0]>();
    dispatchInboundMessageMock.mockReset().mockImplementation((args) => {
      createdInputEntered.resolve(args);
      return releaseExecution.promise.then(() => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      }));
    });
    const created = await withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(creationCaller, () =>
          expectDefined(createSessionsCreateTool(), "creation tool").execute("create-retirement", {
            message: "Continue independently",
          }),
        ),
    );
    expect(created.details).toMatchObject({
      runStarted: true,
      sessionKey: expect.any(String),
      sessionId: expect.any(String),
    });
    const createdReceipt = created.details as {
      sessionKey: string;
      sessionId: string;
      runId?: string;
    };
    const createdScope = await sessionScope(createdReceipt.sessionKey, createdReceipt.sessionId);
    const createdInput = await withinTest(createdInputEntered.promise, signal);
    const createdRecorder = expectDefined(
      createdInput.replyOptions?.userTurnTranscriptRecorder,
      "created input recorder",
    );
    const createdSource = expectDefined(
      readReplySourceInput(createdInput.replyOptions),
      "created physical source",
    );
    createdWorkReleased = captureSessionControllerSettlement({
      scope: createdScope.storePath,
      identities: [createdReceipt.sessionKey, createdReceipt.sessionId],
    });
    const createdPending = await listSessionPendingInputs(createdScope);
    expect(createdPending).toEqual({ total: 0, items: [] });
    const createdRunId = expectDefined(createdReceipt.runId, "created run");
    const createdAbortEntry = expectDefined(
      rpcSourceTesting.get(createdRunId),
      "created input target",
    );
    const createdTranscript = sessionAccessor.loadTranscriptEventsSync(createdScope);
    const createdAdmission = createdRecorder.getAdmissionReceipt();
    expect(createdAdmission).toBeDefined();
    expect(createdRecorder.getPersistedMessage?.()).toMatchObject({
      content: "Continue independently",
      provenance: { kind: "inter_session", sourceTool: "sessions_create" },
    });
    expect(createdAbortEntry.input.abortSignal.aborted).toBe(false);
    expect(() => creationGuard()).not.toThrow();

    // The synthetic agent source stays live as the control. Creation's real
    // operator source retires with its Gateway; neither target is cancelled.
    expect(runtime.isAvailable()).toBe(true);
    runtime.close();
    expect(runtime.isAvailable()).toBe(false);
    expect(() => guard()).not.toThrow();
    expect(() => creationGuard()).toThrow("tool invocation authority is no longer active");
    expect(abort.controller.signal.aborted).toBe(false);
    expect(rpcSourceTesting.get(createdRunId)).toBe(createdAbortEntry);
    expect(createdAbortEntry.input.abortSignal.aborted).toBe(false);
    await expect(
      Promise.resolve().then(() => {
        createdSource.abortSignal.throwIfAborted();
        expectDefined(
          createdSource.sourceAdapter?.authority,
          "accepted creation authority",
        ).assertCurrent();
      }),
    ).rejects.toThrow();
    expect(createdRecorder.getAdmissionReceipt()).toEqual(createdAdmission);
    release();
    await Promise.all([held.resume(), createdWorkReleased]);
    // The service owns source release after the intercepted execution returns.
    await expectDefined(abort.entry, "accepted source").input.settlement.promise;

    expect(accepted).toEqual(originalAck);
    expect(context.dedupe.get(`agent:${runId}`)).toMatchObject({
      ok: false,
      payload: {
        runId,
        status: "error",
        summary: "Gateway instance dispatch unavailable for agent turn",
      },
      error: {
        code: "UNAVAILABLE",
        message: "Gateway instance dispatch unavailable for agent turn",
      },
    });
    expect(await listSessionPendingInputs(scope)).toEqual({
      total: 1,
      items: [{ ...pending.items[0], state: "cancelled" }],
    });
    expect(sessionAccessor.loadTranscriptEventsSync(scope)).toEqual(transcript);
    expect(await listSessionPendingInputs(createdScope)).toEqual(createdPending);
    expect(sessionAccessor.loadTranscriptEventsSync(createdScope)).toEqual(createdTranscript);
    expect(userTurn.recorder?.getAdmissionReceipt()).toBeUndefined();
    expect(createdAbortEntry.input.abortSignal.aborted).toBe(false);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(abort.controller.signal.aborted).toBe(false);
    expect(rpcSourceTesting.size).toBe(0);
    expect(workAdmission.isActive()).toBe(false);
    await workAdmission.released;
    expect(runtimeRelease).toHaveBeenCalledOnce();
    expect(() => guard()).not.toThrow();
  } finally {
    release();
    await Promise.allSettled([dispatch, held.cleanup(), createdWorkReleased]);
    dispatchInboundMessageMock.mockReset();
    restoreRuntimeRelease?.();
    admission.close();
    creationAdmission.close();
    operator.release();
    signal.removeEventListener("abort", release);
  }
});
