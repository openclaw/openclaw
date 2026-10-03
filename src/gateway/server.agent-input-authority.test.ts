import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsCreateTool } from "../agents/tools/sessions-create-tool.js";
import * as followupCustody from "../agents/tools/sessions-send-followup-custody.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { createReplyTurnParticipants } from "../auto-reply/reply/reply-run-registry.tool-authority.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import type { PreparedAgentRunDispatch } from "./agent-turn/agent-run-admission-types.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { runIndependentCreationInputCase } from "./server.agent-input-authority.create.test-helper.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadSessionEntry } from "./session-utils.js";
import { withPreparedSessionResolve } from "./sessions-resolve.js";
import {
  agentCommandMock,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

describe("spawn input ownership transfer", () => {
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

  it.for([
    "before acceptance",
    "after acceptance",
    "guest after acceptance",
    "participant after creation",
    "participant after acceptance",
    "target abort",
    "target replacement",
    "operator revocation",
  ] as const)("transfers independently created input at %s", async (boundary, { signal }) => {
    await runIndependentCreationInputCase(kernel.gatewayRequestContext, boundary, signal);
  });

  it.for([
    { kind: "native", boundary: "dispatch" },
    { kind: "peer", boundary: "dispatch" },
    { kind: "native", boundary: "completion" },
    { kind: "peer", boundary: "completion" },
  ] as const)(
    "delivers a $kind reply after the requester ends before child $boundary",
    async ({ kind, boundary }, { signal }) => {
      await prepareGatewayReplyRuntimeForTest();
      const context = kernel.gatewayRequestContext;
      const cfg = context.getRuntimeConfig();
      const runId = randomUUID();
      const parentKey = `agent:main:dashboard:reply-parent-${runId}`;
      const childKey = `agent:main:dashboard:reply-child-${runId}`;
      const client = createOperatorClient({
        profileName: `reply-custody-${runId}`,
        scopes: ["operator.admin"],
      });
      for (const sessionKey of [parentKey, childKey]) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            ...(kind === "native" && sessionKey === childKey
              ? { spawnedBy: parentKey, spawnDepth: 1 }
              : {}),
          },
        );
      }
      await withPreparedSessionResolve(
        {
          projection: expectDefined(getSessionRowProjection(context), "Gateway session projection"),
          client,
          p: { key: childKey, agentId: "main" },
        },
        (resolved) => expect(resolved).toMatchObject({ ok: true, key: childKey }),
      );
      const operator = await captureGatewayOperatorRunAuthority({ client, context });
      if (!operator) {
        throw new Error("Expected original operator authority");
      }
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(`requester-${runId}`),
        operatorAuthority: operator.authority,
        facts: {
          runId: `requester-${runId}`,
          agentId: "main",
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
        },
      });
      const admitted = await admission.admit("embedded");
      const participants = createReplyTurnParticipants({ operatorAuthority: operator.authority });
      const dispatchEntered = createDeferred();
      const childEntered = createDeferred();
      const releaseDispatch = createDeferred();
      const releaseChild = createDeferred();
      const replyFinished = createDeferred();
      const executions: Promise<void>[] = [];
      const parentMessages: string[] = [];
      let replyError: unknown;
      const continueWork = gatewayWork.runWithGatewayDetachedWorkContinuation;
      const replyObserver = vi
        .spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation")
        .mockImplementation((work, holder) => {
          const pending = continueWork(work, holder);
          if (holder === "session:a2a-send") {
            void pending.then(
              () => replyFinished.resolve(),
              (error: unknown) => {
                replyError = error;
                replyFinished.resolve();
              },
            );
          }
          return pending;
        });
      const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
      const execute = executionModule.startAgentRunExecution;
      const executionSpy = vi
        .spyOn(executionModule, "startAgentRunExecution")
        .mockImplementation((params) => {
          const pending = (async () => {
            if (params.runId === runId) {
              dispatchEntered.resolve();
              if (boundary === "dispatch") {
                await releaseDispatch.promise;
              }
            }
            await execute(params);
          })();
          executions.push(pending);
          return pending;
        });
      agentCommandMock.mockImplementation(async (input) => {
        const opts = input as AgentCommandGatewayIngressOpts;
        await opts.userTurnTranscriptRecorder?.persistApproved();
        if (opts.sessionKey === childKey) {
          childEntered.resolve();
          await releaseChild.promise;
        } else {
          parentMessages.push(opts.message ?? "");
        }
        const text =
          opts.sessionKey === childKey ? "delayed child result" : "received child result";
        const terminalReply = buildAgentRunTerminalReplySnapshot({
          visibleText: text,
          rawText: text,
        });
        emitAgentEvent({
          runId: opts.runId!,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 1, endedAt: Date.now(), terminalReply },
        });
        return { payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1, terminalReply } };
      });
      const unblock = () => {
        releaseDispatch.resolve();
        releaseChild.resolve();
      };
      signal.addEventListener("abort", unblock, { once: true });
      try {
        const result = await withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              {
                ...createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: admitted,
                  agentId: "main",
                  sessionKey: parentKey,
                }),
                agentId: "main",
                sessionKey: parentKey,
                personalToolParticipants: participants,
              },
              () =>
                createSessionsSendTool({
                  agentSessionKey: parentKey,
                  agentChannel: "webchat",
                  config: cfg,
                  idempotencyKey: runId,
                }).execute("detached-reply", {
                  sessionKey: childKey,
                  message: "finish the accepted task",
                  timeoutSeconds: 0,
                }),
            ),
        );
        expect(result.details, JSON.stringify(result.details)).toMatchObject({
          status: "accepted",
          delivery: { status: "pending" },
        });
        await withinTest(
          boundary === "dispatch" ? dispatchEntered.promise : childEntered.promise,
          signal,
        );
        participants.close();
        admission.close();
        operator.release();
        expect(() => participants.resolve()).toThrow("This turn has ended");
        unblock();
        await withinTest(replyFinished.promise, signal);
        expect(replyError).toBeUndefined();
        expect(parentMessages).toHaveLength(1);
        expect(parentMessages[0]).toContain("delayed child result");
      } finally {
        unblock();
        await Promise.allSettled(executions);
        participants.close();
        admission.close();
        operator.release();
        replyObserver.mockRestore();
        executionSpy.mockRestore();
        signal.removeEventListener("abort", unblock);
      }
    },
  );

  it.each(["requester", "child"] as const)(
    "revokes prepared watched followup %s access before real Gateway child admission",
    async (revoked) => {
      await prepareGatewayReplyRuntimeForTest();
      const context = kernel.gatewayRequestContext;
      const cfg = context.getRuntimeConfig();
      const runId = randomUUID();
      const parentKey = `agent:main:dashboard:denied-parent-${runId}`;
      const childKey = `agent:main:subagent:denied-child-${runId}`;
      const client = createOperatorClient({
        profileName: `watched-denial-${runId}`,
        scopes: ["operator.admin"],
      });
      for (const sessionKey of [parentKey, childKey]) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: Date.now(),
            createdVia: "operator",
            createdActor: {
              type: "human",
              source: "profile",
              id: client.authenticatedUserProfile!.profileId,
            },
            ...(sessionKey === childKey ? { spawnedBy: parentKey, spawnDepth: 1 } : {}),
          },
        );
      }
      const operator = await captureGatewayOperatorRunAuthority({ client, context });
      if (!operator) {
        throw new Error("Expected operator-owned Gateway admission");
      }
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(`requester-${runId}`),
        operatorAuthority: operator.authority,
        facts: {
          runId: `requester-${runId}`,
          agentId: "main",
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
        },
      });
      const admitted = await admission.admit("embedded");
      const prepared = createDeferred();
      const release = createDeferred();
      const prepare = followupCustody.prepareSessionsSendFollowup;
      const held = vi
        .spyOn(followupCustody, "prepareSessionsSendFollowup")
        .mockImplementationOnce(async (params) => {
          const request = await prepare(params);
          if (!request) {
            throw new Error("Expected real prepared followup custody");
          }
          prepared.resolve();
          await release.promise;
          return request;
        });
      const stage = vi.spyOn(sessionAccessor, "stageSessionPendingInput");
      let sending: Promise<unknown> | undefined;
      try {
        const pending = withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: admitted,
                agentId: "main",
                sessionKey: parentKey,
              }),
              () =>
                createSessionsSendTool({
                  agentSessionKey: parentKey,
                  requesterTurnRunId: admission.operationalRunInstance.runId,
                  config: cfg,
                  idempotencyKey: runId,
                }).execute("denied-watched-followup", {
                  sessionKey: childKey,
                  mode: "followup",
                  watch: true,
                  timeoutSeconds: 0,
                  message: "This child input must never be admitted",
                }),
            ),
        );
        sending = pending;
        await Promise.race([
          prepared.promise,
          pending.then(() => {
            throw new Error("Send ended before preparing real custody");
          }),
        ]);
        const revokedKey = revoked === "requester" ? parentKey : childKey;
        const entry = loadSessionEntry(revokedKey, { agentId: "main" }).entry;
        if (!entry) {
          throw new Error("Expected prepared session");
        }
        await sessionAccessor.replaceSessionEntry(
          { agentId: "main", sessionKey: revokedKey },
          { ...entry, archivedAt: Date.now() },
        );
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
        expect(() => operator.authority.assertCurrent()).not.toThrow();
        release.resolve();
        const result = await pending;
        expect(result.details).toMatchObject({
          status: "error",
          error: expect.stringMatching(/archived|revoked/),
        });
        expect(result.details).not.toHaveProperty("sentBeforeError");
        expect(stage).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
        expect(
          (
            await listSessionPendingInputs({
              agentId: "main",
              sessionKey: childKey,
              sessionId: childKey,
              storePath: loadSessionEntry(childKey, { agentId: "main" }).storePath,
            })
          ).total,
        ).toBe(0);
      } finally {
        release.resolve();
        await sending?.catch(() => {});
        held.mockRestore();
        stage.mockRestore();
        admission.close();
        operator.release();
      }
    },
  );

  it.for([
    "before staging",
    "after acceptance",
    "child abort",
    "before reset",
    "live reset",
  ] as const)("keeps input authority at its current owner: %s", async (boundary, { signal }) => {
    await prepareGatewayReplyRuntimeForTest();
    const context = kernel.gatewayRequestContext;
    const cfg = context.getRuntimeConfig();
    const runId = randomUUID();
    const parentKey = `agent:main:parent:${runId}`;
    const childKey = `agent:main:subagent:${runId}`;
    const sessionId = `child-${runId}`;
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey },
      { sessionId, updatedAt: Date.now() },
    );
    const loaded = loadSessionEntry(childKey, { agentId: "main" });
    const admission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef(`parent-${runId}`),
      facts: {
        runId: `parent-${runId}`,
        agentId: "main",
        ingress: { kind: "system", boundary: "spawn-input-proof", state: "present" },
      },
    });
    const admitted = await admission.admit("embedded");
    const guard = await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: parentKey,
      }),
      () => captureAgentToolSourceExecutionGuard(),
    );
    if (boundary === "before reset" || boundary === "live reset") {
      const before = loadSessionEntry(childKey, { agentId: "main" }).entry;
      let hookCalls = 0;
      const onReset = (event: import("../hooks/internal-hooks.js").InternalHookEvent) => {
        if (event.sessionKey !== childKey) {
          return;
        }
        hookCalls++;
        if (boundary === "before reset") {
          admission.close();
        }
      };
      registerInternalHook("command:new", onReset);
      try {
        const reset = dispatchGatewayMethodInProcess(
          "agent",
          { message: "/new", sessionKey: childKey, idempotencyKey: runId },
          {
            forceSyntheticClient: true,
            syntheticScopes: ["operator.admin"],
            resolveGatewayContext: () => context,
            sessionMutationCommitGuard: guard,
          },
        );
        if (boundary === "before reset") {
          await expect(reset).rejects.toThrow("tool invocation authority is no longer active");
          expect(loadSessionEntry(childKey, { agentId: "main" }).entry).toEqual(before);
        } else {
          await expect(reset).resolves.toMatchObject({ status: "ok", summary: "completed" });
          const after = loadSessionEntry(childKey, { agentId: "main" }).entry;
          expect(after?.sessionId).toBe(sessionId);
          expect(after?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
        }
        expect(hookCalls).toBe(1);
      } finally {
        unregisterInternalHook("command:new", onReset);
        admission.close();
      }
      return;
    }
    const staged = createDeferred();
    const releaseWriter = createDeferred();
    const releaseExecution = createDeferred();
    const executionEntered = createDeferred();
    const release = () => {
      releaseWriter.resolve();
      releaseExecution.resolve();
    };
    signal.addEventListener("abort", release, { once: true });
    let writer: Promise<unknown> | undefined;
    let execution: Promise<void> | undefined;
    let prepared:
      | import("./agent-turn/agent-run-admission-types.js").PreparedAgentRunDispatch
      | undefined;
    const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
    const execute = executionModule.startAgentRunExecution;
    const executionSpy = vi
      .spyOn(executionModule, "startAgentRunExecution")
      .mockImplementationOnce((params) => {
        prepared = params.prepared;
        executionEntered.resolve();
        execution = releaseExecution.promise.then(() => execute(params));
        return execution;
      });
    const stage = sessionAccessor.stageSessionPendingInput;
    const stageSpy = vi
      .spyOn(sessionAccessor, "stageSessionPendingInput")
      .mockImplementationOnce(async (...args) => {
        if (boundary === "before staging") {
          const entered = createDeferred();
          writer = runExclusiveSqliteSessionWrite(
            resolveSqliteStoreScope(loaded.storePath, { agentId: "main" }),
            async () => {
              entered.resolve();
              await releaseWriter.promise;
            },
            "session.transcript.batch",
          );
          await entered.promise;
        }
        const pending = stage(...args);
        staged.resolve();
        return await pending;
      });
    let dispatch: Promise<unknown> | undefined;
    try {
      dispatch = dispatchGatewayMethodInProcess(
        "agent",
        { message: "synthetic staged child input", sessionKey: childKey, idempotencyKey: runId },
        {
          forceSyntheticClient: true,
          resolveGatewayContext: () => context,
          sessionMutationCommitGuard: guard,
        },
      );
      const outcome = dispatch.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        staged.promise,
        outcome.then((value) => {
          if ("error" in value) {
            throw value.error;
          }
          throw new Error(`Dispatch ended before staging: ${JSON.stringify(value)}`);
        }),
      ]);
      if (boundary === "before staging") {
        admission.close();
        releaseWriter.resolve();
        expect(await outcome).toHaveProperty(
          "error.message",
          "tool invocation authority is no longer active",
        );
        expect(prepared).toBeUndefined();
        expect(
          (
            await listSessionPendingInputs({
              agentId: "main",
              sessionKey: childKey,
              sessionId,
              storePath: loaded.storePath,
            })
          ).total,
        ).toBe(0);
      } else {
        expect(await outcome).toHaveProperty("value.status", "accepted");
        await executionEntered.promise;
        const recorder = prepared!.userTurn.recorder!;
        expect(recorder.getPendingInputMessage?.()).toBeDefined();
        admission.close();
        expect(() => guard()).toThrow("tool invocation authority is no longer active");
        if (boundary === "child abort") {
          prepared!.activeRunAbort.controller.abort(new Error("child stopped"));
          expect(() => recorder.withPendingInput!(() => undefined)).toThrow("child stopped");
        } else {
          const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
          expect(persisted?.appended).toBe(true);
          expect(persisted?.message.content).toBe("synthetic staged child input");
          expect(
            (
              await listSessionPendingInputs({
                agentId: "main",
                sessionKey: childKey,
                sessionId,
                storePath: loaded.storePath,
              })
            ).total,
          ).toBe(0);
        }
      }
    } finally {
      release();
      await Promise.allSettled([writer, dispatch, execution]);
      admission.close();
      stageSpy.mockRestore();
      executionSpy.mockRestore();
      signal.removeEventListener("abort", release);
    }
  });
});

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
      storePath: loadSessionEntry(childKey, { agentId: "main" }).storePath,
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
      expect(prepared.activeGatewayWorkAdmission.isActive()).toBe(true);
      expect(context.chatAbortControllers.get(runId)).toBe(prepared.activeRunAbort.entry);
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
        storePath: loadSessionEntry(createdReceipt.sessionKey, { agentId: "main" }).storePath,
      };
      const createdRecorder = await withinTest(createdInputEntered.promise, signal);
      createdWorkReleased = getSessionWorkAdmissionRelease({
        scope: createdScope.storePath,
        identities: [createdReceipt.sessionKey, createdReceipt.sessionId],
      });
      const createdPending = await listSessionPendingInputs(createdScope);
      expect(createdPending).toMatchObject({ total: 1, items: [{ state: "queued" }] });
      const createdRunId = expectDefined(createdPending.items[0], "created pending input").runId;
      const createdAbortEntry = expectDefined(
        context.chatAbortControllers.get(createdRunId),
        "created input target",
      );
      const createdTranscript = sessionAccessor.loadTranscriptEventsSync(createdScope);
      expect(createdAbortEntry.controller.signal.aborted).toBe(false);
      expect(() => creationGuard()).not.toThrow();

      // The synthetic agent source stays live as the control. Creation's real
      // operator source retires with its Gateway; neither target is cancelled.
      expect(kernel.gatewayInstanceRuntime.isAvailable()).toBe(true);
      kernel.gatewayInstanceRuntime.close();
      expect(kernel.gatewayInstanceRuntime.isAvailable()).toBe(false);
      expect(() => guard()).not.toThrow();
      expect(() => creationGuard()).toThrow("tool invocation authority is no longer active");
      expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
      expect(context.chatAbortControllers.get(createdRunId)).toBe(createdAbortEntry);
      expect(createdAbortEntry.controller.signal.aborted).toBe(false);
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
      expect(createdAbortEntry.controller.signal.aborted).toBe(false);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(prepared.activeRunAbort.controller.signal.aborted).toBe(false);
      expect(context.chatAbortControllers.size).toBe(0);
      expect(context.chatQueuedTurns.size).toBe(0);
      expect(prepared.activeGatewayWorkAdmission.isActive()).toBe(false);
      await prepared.activeGatewayWorkAdmission.released;
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
