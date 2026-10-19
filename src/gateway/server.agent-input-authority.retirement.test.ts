import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
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
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  agentCommandMock,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

describe("accepted input Gateway instance retirement", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const module = await import("./server-kernel.js");
      const create = module.createGatewayKernel;
      const capture = vi
        .spyOn(module, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await create(...args);
          return kernel;
        });
      try {
        harness = await startGatewayServerHarness();
      } finally {
        capture.mockRestore();
      }
    },
    cleanup: async () => {
      await harness?.close();
    },
  });

  it("rejects retained agent and independent-creation input after acceptance", async ({
    signal,
  }) => {
    await prepareGatewayReplyRuntimeForTest();
    const context = kernel.gatewayRequestContext;
    const runId = randomUUID();
    const parentKey = `agent:main:parent:${runId}`;
    const childKey = `agent:main:subagent:${runId}`;
    const sessionId = `child-${runId}`;
    const message = "synthetic input held across Gateway instance retirement";
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey },
      { sessionId, updatedAt: Date.now() },
    );
    const scope = {
      agentId: "main",
      sessionKey: childKey,
      sessionId,
      storePath: (await loadSessionEntryAsync(childKey, { agentId: "main" })).storePath,
    };
    const transcript = sessionAccessor.loadTranscriptEventsSync(scope);
    const client = createOperatorClient({ profileName: randomUUID(), scopes: ["operator.admin"] });
    const operator = expectDefined(
      await captureGatewayOperatorRunAuthority({ client, context }),
      "creation operator",
    );
    const admission = prepareAgentRunAdmission({
      cfg: context.getRuntimeConfig(),
      operationalRunInstance: createOperationalRunInstanceRef(`parent-${runId}`),
      facts: {
        runId: `parent-${runId}`,
        agentId: "main",
        ingress: { kind: "system", boundary: "spawn-input-proof", state: "present" },
      },
    });
    const creationAdmission = prepareAgentRunAdmission({
      cfg: context.getRuntimeConfig(),
      operationalRunInstance: createOperationalRunInstanceRef(`creation-parent-${runId}`),
      operatorAuthority: operator.authority,
      facts: {
        runId: `creation-parent-${runId}`,
        agentId: "main",
        ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
      },
    });
    const releaseExecution = createDeferred();
    const executionEntered = createDeferred<PreparedAgentRunDispatch>();
    const release = () => releaseExecution.resolve();
    signal.addEventListener("abort", release, { once: true });
    let dispatch: Promise<unknown> | undefined;
    let execution: Promise<void> | undefined;
    let restoreExecution: (() => void) | undefined;
    let restoreRuntimeRelease: (() => void) | undefined;
    let createdWorkReleased: Promise<void> | undefined;
    try {
      const admitted = await admission.admit("embedded");
      const guard = await withGatewayToolCallerIdentity(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: parentKey,
        }),
        () => captureAgentToolSourceExecutionGuard(),
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
      const prepared = await executionEntered.promise;
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
      expect(prepared.userTurn.recorder?.getPendingInputMessage?.()).toEqual(
        pending.items[0]?.message,
      );
      const workAdmission = prepared.activeGatewayWorkAdmission;
      if (!workAdmission) {
        throw new Error("Expected prepared Gateway work custody");
      }
      expect(workAdmission.isActive()).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(prepared.activeRunAbort.entry);
      expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
      expect(() => guard()).not.toThrow();
      const runtimeRelease = vi.spyOn(
        expectDefined(prepared.preparedModelRuntimeLease, "ready session runtime"),
        Symbol.asyncDispose,
      );
      restoreRuntimeRelease = () => runtimeRelease.mockRestore();

      const creationAdmitted = await creationAdmission.admit("embedded");
      const creationCaller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: creationAdmitted,
        agentId: "main",
        sessionKey: parentKey,
      });
      const creationGuard = await withGatewayToolCallerIdentity(creationCaller, () =>
        captureAgentToolSourceExecutionGuard(),
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
            expectDefined(createSessionsCreateTool(), "creation tool").execute(
              "create-retirement",
              { message: "Continue independently" },
            ),
          ),
      );
      expect(created.details).toMatchObject({
        runStarted: true,
        sessionKey: expect.any(String),
        sessionId: expect.any(String),
      });
      const createdReceipt = created.details as { sessionKey: string; sessionId: string };
      const createdScope = {
        agentId: "main",
        ...createdReceipt,
        storePath: (await loadSessionEntryAsync(createdReceipt.sessionKey, { agentId: "main" }))
          .storePath,
      };
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
      expect(kernel.gatewayInstanceRuntime.isAvailable()).toBe(true);
      kernel.gatewayInstanceRuntime.close();
      expect(kernel.gatewayInstanceRuntime.isAvailable()).toBe(false);
      expect(() => guard()).not.toThrow();
      expect(() => creationGuard()).toThrow("tool invocation authority is no longer active");
      expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
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
      await expectDefined(prepared.activeRunAbort.entry, "accepted source").input.settlement
        .promise;

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
        items: [{ ...pending.items[0], state: "interrupted" }],
      });
      expect(sessionAccessor.loadTranscriptEventsSync(scope)).toEqual(transcript);
      expect(prepared.userTurn.recorder?.getAdmissionReceipt()).toBeUndefined();
      expect(await listSessionPendingInputs(createdScope)).toEqual({
        total: 1,
        items: [{ ...createdPending.items[0], state: "interrupted" }],
      });
      expect(sessionAccessor.loadTranscriptEventsSync(createdScope)).toEqual(createdTranscript);
      expect(createdAbortEntry.input.abortSignal.aborted).toBe(false);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
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
});
