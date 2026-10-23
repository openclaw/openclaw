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
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import type { PreparedAgentRunDispatch } from "./agent-turn/agent-run-admission-types.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  agentCommandMock,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    kernel = await captureGatewayKernel(async () => {
      harness = await startGatewayServerHarness();
    });
  },
  cleanup: async () => harness?.close(),
});

it("rejects retained agent and independent-creation input after acceptance", async ({ signal }) => {
  await prepareGatewayReplyRuntimeForTest();
  const context = kernel.gatewayRequestContext;
  const runtime = kernel.gatewayInstanceRuntime;
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
  const executionEntered = createDeferred<PreparedAgentRunDispatch>();
  const release = () => releaseExecution.resolve();
  signal.addEventListener("abort", release, { once: true });
  let dispatch: Promise<unknown> | undefined;
  let execution: Promise<void> | undefined;
  let restoreExecution: (() => void) | undefined;
  let restoreRuntimeRelease: (() => void) | undefined;
  let createdWorkReleased: Promise<void> | undefined;
  try {
    const guard = await withGatewayToolCallerIdentity(
      await createCaller(admission),
      captureAgentToolSourceExecutionGuard,
    );
    const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
    const execute = executionModule.startAgentRunExecution;
    const executionSpy = vi
      .spyOn(executionModule, "startAgentRunExecution")
      .mockImplementationOnce((params) => {
        executionEntered.resolve(params.prepared);
        execution = releaseExecution.promise.then(() => execute(params));
        return execution;
      });
    restoreExecution = () => executionSpy.mockRestore();
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
    } = await executionEntered.promise;
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
    const createdInputEntered = createDeferred<UserTurnTranscriptRecorder>();
    dispatchInboundMessageMock.mockReset().mockImplementation((args) => {
      createdInputEntered.resolve(
        expectDefined(args.replyOptions?.userTurnTranscriptRecorder, "created input recorder"),
      );
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
    const createdReceipt = created.details as { sessionKey: string; sessionId: string };
    const createdScope = await sessionScope(createdReceipt.sessionKey, createdReceipt.sessionId);
    const createdRecorder = await withinTest(createdInputEntered.promise, signal);
    createdWorkReleased = captureSessionControllerSettlement({
      scope: createdScope.storePath,
      identities: [createdReceipt.sessionKey, createdReceipt.sessionId],
    });
    const createdPending = await listSessionPendingInputs(createdScope);
    expect(createdPending).toMatchObject({ total: 1, items: [{ state: "queued" }] });
    const createdRunId = expectDefined(createdPending.items[0], "created pending input").runId;
    const createdAbortEntry = expectDefined(
      rpcSourceTesting.get(createdRunId),
      "created input target",
    );
    const createdTranscript = sessionAccessor.loadTranscriptEventsSync(createdScope);
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
      Promise.resolve().then(() =>
        expectDefined(
          createdRecorder.withPendingInput,
          "accepted creation input",
        )(() => createdRecorder.persistApproved()),
      ),
    ).rejects.toThrow();
    expect(createdRecorder.getAdmissionReceipt?.()).toBeUndefined();
    release();
    await Promise.all([execution, createdWorkReleased]);
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
    for (const [target, before, beforeTranscript] of [
      [scope, pending, transcript],
      [createdScope, createdPending, createdTranscript],
    ] as const) {
      expect(await listSessionPendingInputs(target)).toEqual({
        total: 1,
        items: [{ ...before.items[0], state: "interrupted" }],
      });
      expect(sessionAccessor.loadTranscriptEventsSync(target)).toEqual(beforeTranscript);
    }
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
    await Promise.allSettled([dispatch, execution, createdWorkReleased]);
    dispatchInboundMessageMock.mockReset();
    restoreRuntimeRelease?.();
    restoreExecution?.();
    admission.close();
    creationAdmission.close();
    operator.release();
    signal.removeEventListener("abort", release);
  }
});
