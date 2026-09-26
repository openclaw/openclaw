/** Real isolated Gateway: model-facing resume transfers a paused task before execution. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../agents/subagents/registry/subagent-registry-run-pause.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  markSubagentRunTerminated,
  registerSubagentRun,
} from "../agents/subagents/registry/subagent-registry.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  listSessionPendingInputReceipts,
  listSessionPendingInputs,
} from "../config/sessions/session-accessor.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  startTestGatewayServer,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  releaseGatewaySessionStoreFixture,
  settleGatewaySessionStoreFixture,
} from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const root of tempDirs.dirs) {
      await releaseGatewaySessionStoreFixture(root);
    }
    cleanup();
  }),
);
let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
beforeAll(async () => {
  const module = await import("./server-kernel.js");
  const create = module.createGatewayKernel;
  const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
    kernel = await create(...args);
    return kernel;
  });
  try {
    server = await startTestGatewayServer(await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }));
  } finally {
    capture.mockRestore();
  }
});
afterAll(async () => {
  await server.close();
});

// Each case owns distinct durable identities while sharing the isolated Gateway.
async function arrangeAuthorityProof(name: string) {
  const root = tempDirs.make(`openclaw-resume-${name}-`);
  const parent = "agent:main:main";
  const unrelated = `agent:main:dashboard:${name}-unrelated`;
  const child = `agent:main:dashboard:${name}-child`;
  const sessionId = `${name}-child-session`;
  const previousRunId = `${name}-paused`;
  const runId = `${name}-successor`;
  const storePath = path.join(root, "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      [parent]: { sessionId: `${name}-parent-session`, updatedAt: Date.now() },
      [unrelated]: { sessionId: `${name}-unrelated-session`, updatedAt: Date.now() },
      [child]: { sessionId, updatedAt: Date.now(), spawnedBy: parent, spawnDepth: 1 },
    },
  });
  await prepareGatewayReplyRuntimeForTest();
  publishSystemEventStoreConfig(getRuntimeConfig());
  await registerSubagentRun({
    runId: previousRunId,
    childSessionKey: child,
    controllerSessionKey: parent,
    requesterSessionKey: parent,
    requesterDisplayKey: parent,
    task: "Wait for the answer",
    cleanup: "keep",
    expectsCompletionMessage: true,
    queued: true,
  });
  const previous = expectDefined(subagentRuns.get(previousRunId), "paused child");
  expect(markSubagentRunPausedAfterYield({ entry: previous })).toBe(true);
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
  const scope = { agentId: "main", sessionKey: child, sessionId, storePath };
  const finalEffect = vi.fn();
  // The provider can publish success only after real input custody is consumed.
  // Admission, task replacement, and recorder live-owner checks remain production code.
  agentCommandMock.mockImplementation(async (opts) => {
    const command = opts as AgentCommandGatewayIngressOpts;
    const recorder = expectDefined(command.userTurnTranscriptRecorder, "resume input recorder");
    await recorder.persistApproved();
    expect(recorder.hasPersisted()).toBe(true);
    const text = "Unauthorized child final effect.";
    finalEffect(text);
    emitAgentEvent({
      runId: expectDefined(command.runId, "resume execution run id"),
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: Date.now() - 1,
        endedAt: Date.now(),
        terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
      },
    });
    return { payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1 } };
  });
  const send = (caller = parent, approvalSignal?: AbortSignal, mode?: "resume") => {
    const tool = createSessionsSendTool({
      agentSessionKey: caller,
      config: { tools: { sessions: { visibility: "all" } } },
      idempotencyKey: runId,
    });
    return withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: caller,
        operationalRunInstance: createOperationalRunInstanceRef(`${name}-parent-turn`),
        receiptAuthority: () => true,
        approvalSignals: approvalSignal ? [approvalSignal] : undefined,
        gatewayContextResolver: () => kernel.gatewayRequestContext,
      },
      () =>
        tool.execute(`${name}-proof`, {
          sessionKey: child,
          ...(mode ? { mode } : {}),
          message: "The answer is ready; finish the task.",
        }),
    );
  };
  const expectUnadopted = () => {
    expect(subagentRuns.get(previousRunId)).toBe(previous);
    expect(previous.pauseReason).toBe("sessions_yield");
    expect(subagentRuns.has(runId)).toBe(false);
  };
  return {
    parent,
    unrelated,
    child,
    previousRunId,
    runId,
    scope,
    finalEffect,
    send,
    expectUnadopted,
  };
}

it("rejects an unrelated visible controller without consuming input or producing a child result", async () => {
  const announce = vi
    .spyOn(
      await import("../agents/subagents/announce/subagent-announce.js"),
      "runSubagentAnnounceFlow",
    )
    .mockResolvedValue("delivered");
  try {
    const proof = await arrangeAuthorityProof("unrelated-controller");
    const result = await proof.send(proof.unrelated, undefined, "resume");
    expect(result.details).toMatchObject({
      status: "error",
      error: "Task resume is limited to children controlled by the calling session.",
    });
    proof.expectUnadopted();
    expect(listSessionPendingInputs(proof.scope)).toEqual({ items: [], total: 0 });
    expect(listSessionPendingInputReceipts(proof.scope, { runIds: [proof.runId] })).toEqual([]);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(proof.finalEffect).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  } finally {
    announce.mockRestore();
  }
});

it("rejects a child without task-owned completion before input or execution", async () => {
  const announce = vi
    .spyOn(
      await import("../agents/subagents/announce/subagent-announce.js"),
      "runSubagentAnnounceFlow",
    )
    .mockResolvedValue("delivered");
  try {
    const proof = await arrangeAuthorityProof("completion-disabled");
    const previous = expectDefined(subagentRuns.get(proof.previousRunId), "paused child");
    previous.expectsCompletionMessage = false;
    persistSubagentRunsToDiskOrThrow(subagentRuns, [proof.previousRunId]);
    const result = await proof.send(undefined, undefined, "resume");
    expect(result.details).toMatchObject({
      status: "error",
      error: "Task resume requires a child with task-owned completion.",
    });
    proof.expectUnadopted();
    expect(listSessionPendingInputs(proof.scope)).toEqual({ items: [], total: 0 });
    expect(listSessionPendingInputReceipts(proof.scope, { runIds: [proof.runId] })).toEqual([]);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(proof.finalEffect).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  } finally {
    announce.mockRestore();
  }
});

it("rejects parent authority revoked while durable input preparation awaits", async ({
  signal,
}) => {
  const prepared = createDeferred();
  const release = createDeferred();
  const releasePreparation = () => release.resolve();
  signal.addEventListener("abort", releasePreparation, { once: true });
  const parentAuthority = new AbortController();
  const inputModule = await import("./agent-turn/agent-run-user-turn.js");
  const prepare = inputModule.prepareAgentRunUserTurn;
  const preparation = vi
    .spyOn(inputModule, "prepareAgentRunUserTurn")
    .mockImplementationOnce(async (params) => {
      const input = await prepare(params);
      prepared.resolve();
      await release.promise;
      return input;
    });
  const announce = vi
    .spyOn(
      await import("../agents/subagents/announce/subagent-announce.js"),
      "runSubagentAnnounceFlow",
    )
    .mockResolvedValue("delivered");
  let sending: ReturnType<Awaited<ReturnType<typeof arrangeAuthorityProof>>["send"]> | undefined;
  try {
    const proof = await arrangeAuthorityProof("revoked-parent");
    sending = proof.send(proof.parent, parentAuthority.signal);
    await prepared.promise;
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(listSessionPendingInputs(proof.scope)).toMatchObject({
      total: 1,
      items: [{ runId: proof.runId, state: "queued" }],
    });
    proof.expectUnadopted();
    parentAuthority.abort();
    release.resolve();
    const result = await sending;
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("agent tool caller authority is no longer active"),
    });
    proof.expectUnadopted();
    expect(listSessionPendingInputs(proof.scope)).toMatchObject({
      total: 1,
      items: [{ runId: proof.runId, state: "cancelled" }],
    });
    expect(listSessionPendingInputReceipts(proof.scope, { runIds: [proof.runId] })).toEqual([
      { runId: proof.runId, state: "pending" },
    ]);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(proof.finalEffect).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([sending]);
    preparation.mockRestore();
    announce.mockRestore();
    signal.removeEventListener("abort", releasePreparation);
  }
});

it("fences a cancelled successor after adoption before queued input consumption", async ({
  signal,
}) => {
  const adopted = createDeferred();
  const release = createDeferred();
  const releaseExecution = () => release.resolve();
  signal.addEventListener("abort", releaseExecution, { once: true });
  const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
  const execute = executionModule.startAgentRunExecution;
  let executionCompletion: Promise<void> | undefined;
  const terminal = vi.fn();
  const execution = vi
    .spyOn(executionModule, "startAgentRunExecution")
    .mockImplementationOnce((params) => {
      executionCompletion = (async () => {
        adopted.resolve();
        await release.promise;
        await execute({
          ...params,
          io: {
            ...params.io,
            emitFinal: (...frame) => {
              terminal(...frame);
              params.io.emitFinal(...frame);
            },
          },
        });
      })();
      return executionCompletion;
    });
  const announce = vi
    .spyOn(
      await import("../agents/subagents/announce/subagent-announce.js"),
      "runSubagentAnnounceFlow",
    )
    .mockResolvedValue("delivered");
  try {
    const proof = await arrangeAuthorityProof("cancelled-successor");
    const result = await proof.send();
    expect(result.details).toMatchObject({
      status: "accepted",
      mode: "resume",
      runId: proof.runId,
      taskRunId: proof.previousRunId,
      completion: "task",
    });
    await adopted.promise;
    expect(subagentRuns.has(proof.previousRunId)).toBe(false);
    expect(subagentRuns.get(proof.runId)).toMatchObject({ taskRunId: proof.previousRunId });
    expect(listSessionPendingInputs(proof.scope)).toMatchObject({
      total: 1,
      items: [{ runId: proof.runId, state: "queued" }],
    });
    // Use registry cancellation without aborting the Gateway signal: the successor
    // ownership fence, not a generic aborted-signal check, must stop dispatch.
    expect(
      markSubagentRunTerminated({
        runId: proof.runId,
        reason: "killed",
        suppressTaskDelivery: true,
      }),
    ).toBe(1);
    release.resolve();
    await executionCompletion;
    expect(terminal).toHaveBeenCalledWith(
      [
        false,
        expect.objectContaining({ status: "error" }),
        expect.objectContaining({
          message: expect.stringContaining("Resumed task no longer owns this execution"),
        }),
      ],
      expect.anything(),
    );
    // Custody remains unconsumed even though execution cleanup records interruption.
    expect(listSessionPendingInputs(proof.scope)).toMatchObject({
      total: 1,
      items: [{ runId: proof.runId, state: "interrupted" }],
    });
    expect(listSessionPendingInputReceipts(proof.scope, { runIds: [proof.runId] })).toEqual([
      { runId: proof.runId, state: "pending" },
    ]);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(proof.finalEffect).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([executionCompletion]);
    execution.mockRestore();
    announce.mockRestore();
    signal.removeEventListener("abort", releaseExecution);
  }
});

it.each(["explicit", "automatic"] as const)(
  "resumes a visible child with write-only operator authority (%s)",
  async (mode) => {
    const root = tempDirs.make("openclaw-parent-resume-gateway-");
    const parent = "agent:main:main";
    const child = `agent:main:dashboard:resume-proof-${mode}`;
    const previousRunId = `resume-gateway-${mode}-paused`;
    const release = createDeferred();
    const started = createDeferred();
    const announce = vi
      .spyOn(
        await import("../agents/subagents/announce/subagent-announce.js"),
        "runSubagentAnnounceFlow",
      )
      .mockResolvedValue("delivered");
    testState.sessionStorePath = path.join(root, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          [parent]: { sessionId: `resume-${mode}-parent`, updatedAt: Date.now() },
          [child]: {
            sessionId: `resume-${mode}-child`,
            updatedAt: Date.now(),
            spawnedBy: parent,
            spawnDepth: 1,
          },
        },
      });
      await prepareGatewayReplyRuntimeForTest();
      publishSystemEventStoreConfig(getRuntimeConfig());
      // Seed paused native registry state without polling a nonexistent source execution.
      await registerSubagentRun({
        runId: previousRunId,
        childSessionKey: child,
        controllerSessionKey: parent,
        requesterSessionKey: parent,
        requesterDisplayKey: parent,
        task: "Wait for the answer",
        cleanup: "keep",
        expectsCompletionMessage: true,
        queued: true,
      });
      const previous = subagentRuns.get(previousRunId)!;
      markSubagentRunPausedAfterYield({ entry: previous });
      persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
      agentCommandMock.mockImplementation(async (opts) => {
        const command = opts as AgentCommandGatewayIngressOpts;
        const runId = expectDefined(command.runId, "resume execution run id");
        expect(subagentRuns.get(runId)?.taskRunId).toBe(previousRunId);
        const recorder = expectDefined(command.userTurnTranscriptRecorder, "resume input recorder");
        await recorder.persistApproved();
        expect(recorder.hasPersisted()).toBe(true);
        started.resolve();
        await release.promise;
        const text = "Resumed child finished.";
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt: Date.now() - 1,
            endedAt: Date.now(),
            terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
          },
        });
        return { payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1 } };
      });
      const tool = createSessionsSendTool({
        agentSessionKey: parent,
        config: { tools: { sessions: { visibility: "all" } } },
      });
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          client: createSyntheticPluginRuntimeClient({
            scopes: ["operator.write"],
            operatorRoleActor: {
              kind: "operator",
              profileId: ensureProfileForEmail("resume-operator@example.test").id,
            },
          }),
          context: kernel.gatewayRequestContext,
          isWebchatConnect: () => false,
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: parent,
              operationalRunInstance: createOperationalRunInstanceRef(
                `resume-gateway-${mode}-parent-turn`,
              ),
              receiptAuthority: () => true,
              gatewayContextResolver: () => kernel.gatewayRequestContext,
            },
            () =>
              tool.execute("resume-proof", {
                sessionKey: child,
                ...(mode === "explicit" ? { mode: "resume" } : { timeoutSeconds: 30, watch: true }),
                message: "The answer is ready; finish the task.",
              }),
          ),
      );
      expect(result.details, JSON.stringify(result.details)).toMatchObject({
        status: "accepted",
        mode: "resume",
        taskRunId: previousRunId,
        completion: "task",
      });
      expect(result.details).not.toHaveProperty("reply");
      await started.promise;
      expect(announce).not.toHaveBeenCalled();
      release.resolve();
      await settleGatewaySessionStoreFixture(root);
      await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterSessionKey: parent,
          childSessionKey: child,
          roundOneReply: "Resumed child finished.",
        }),
      );
      await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      try {
        await settleGatewaySessionStoreFixture(root);
      } finally {
        announce.mockRestore();
      }
    }
  },
);
