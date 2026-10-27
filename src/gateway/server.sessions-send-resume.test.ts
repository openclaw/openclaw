/** Real isolated Gateway: model-facing resume transfers a paused task before execution. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import { readSubagentRunAnnounceResult } from "../agents/subagents/announce/subagent-announce-output.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "../agents/subagents/registry/subagent-registry-run-pause.js";
import {
  markSubagentRunTerminated,
  registerSubagentRun,
} from "../agents/subagents/registry/subagent-registry.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputReceipts,
  listSessionPendingInputs,
} from "../config/sessions/session-accessor.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { refusePendingInputCommit } from "./pending-input-commit.test-support.js";
import { getGatewayLifecycleRuntime } from "./server-lifecycle-runtime-context.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
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
let resolveGatewayContext: GatewayContextResolver;
beforeAll(async () => {
  server = await startTestGatewayServer(await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }));
  resolveGatewayContext = expectDefined(
    getGatewayContextResolver(expectDefined(getGatewayLifecycleRuntime(), "Gateway runtime")),
    "Gateway context resolver",
  );
});
afterAll(async () => {
  // Stop registry timers before the Gateway releases their database lifecycle.
  await resetSubagentRegistryForTests({ persist: false });
  await server.close();
});

async function mockSubagentAnnounce() {
  return vi
    .spyOn(
      await import("../agents/subagents/announce/subagent-announce.js"),
      "runSubagentAnnounceFlow",
    )
    .mockResolvedValue("delivered");
}

// Each case owns distinct durable identities while sharing the isolated Gateway.
async function arrangeAuthorityProof(
  name: string,
  root = tempDirs.make(`openclaw-resume-${name}-`),
  expectsCompletionMessage = true,
) {
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
    childAgentId: "main",
    sessionEntry: { sessionId },
    controllerSessionKey: parent,
    requesterSessionKey: parent,
    requesterDisplayKey: parent,
    task: "Wait for the answer",
    cleanup: "keep",
    expectsCompletionMessage: true,
    queued: true,
  });
  await mutateSubagentRuns([previousRunId], (rows) => {
    const entry = structuredClone(expectDefined(rows.get(previousRunId), "child to pause"));
    expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
    entry.expectsCompletionMessage = expectsCompletionMessage;
    return { value: undefined, postimages: new Map([[previousRunId, entry]]) };
  });
  const previous = expectDefined(subagentRuns.get(previousRunId), "paused child");
  const scope = { agentId: "main", sessionKey: child, sessionId, storePath };
  const send = (
    caller = parent,
    approvalSignal?: AbortSignal,
    options: { mode?: "resume"; timeoutSeconds?: number; watch?: boolean } = {},
    idempotencyKey: string | null = runId,
  ) => {
    const tool = createSessionsSendTool({
      agentSessionKey: caller,
      config: { ...getRuntimeConfig(), tools: { sessions: { visibility: "all" } } },
      idempotencyKey: idempotencyKey ?? undefined,
    });
    return withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: caller,
        operationalRunInstance: createOperationalRunInstanceRef(`${name}-parent-turn`),
        receiptAuthority: () => true,
        approvalSignals: approvalSignal ? [approvalSignal] : undefined,
        gatewayContextResolver: resolveGatewayContext,
      },
      () =>
        tool.execute(`${name}-proof`, {
          sessionKey: child,
          ...options,
          message: "The answer is ready; finish the task.",
        }),
    );
  };
  const expectUnadopted = () => {
    expect(subagentRuns.get(previousRunId)).toMatchObject({
      runId: previousRunId,
      childSessionKey: child,
      createdAt: previous.createdAt,
      generation: previous.generation,
      pauseReason: "sessions_yield",
    });
    expect(subagentRuns.has(runId)).toBe(false);
  };
  const expectInputs = async (state: string) => {
    expect(await listSessionPendingInputs(scope)).toMatchObject({
      total: 1,
      items: [{ runId, state }],
    });
  };
  const expectReceipts = async (items: Array<{ state: string; cancelled?: boolean }>) => {
    expect(await listSessionPendingInputReceipts(scope, { runIds: [runId] })).toEqual(
      items.map((item) => ({ runId, ...item })),
    );
  };
  return {
    parent,
    unrelated,
    child,
    previousRunId,
    runId,
    scope,
    send,
    expectUnadopted,
    expectInputs,
    expectReceipts,
  };
}

it.each([
  {
    scenario: "unrelated-controller",
    error: "Task resume is limited to children controlled by the calling session.",
  },
  {
    scenario: "completion-disabled",
    error: "Task resume requires a child with task-owned completion.",
  },
] as const)("rejects $scenario before input or execution", async ({ scenario, error }) => {
  using announce = await mockSubagentAnnounce();
  const proof = await arrangeAuthorityProof(
    scenario,
    undefined,
    scenario !== "completion-disabled",
  );
  const result = await proof.send(
    scenario === "unrelated-controller" ? proof.unrelated : proof.parent,
    undefined,
    { mode: "resume" },
  );
  expect(result.details).toMatchObject({ status: "error", error });
  proof.expectUnadopted();
  expect(await listSessionPendingInputs(proof.scope)).toEqual({ items: [], total: 0 });
  await proof.expectReceipts([]);
  expect(agentCommandMock).not.toHaveBeenCalled();
  expect(announce).not.toHaveBeenCalled();
});

it.for([
  ["revoked-parent", true, false, false],
  ["aborted-successor", false, true, false],
  ["revoked-parent-after-stop", true, true, true],
] as const)(
  "rejects %s while durable input preparation awaits",
  async ([name, revokeParent, abortSuccessor, refuseFinish], { signal }) => {
    const prepared = createDeferred();
    const release = createDeferred();
    const releasePreparation = () => release.resolve();
    signal.addEventListener("abort", releasePreparation, { once: true });
    const parentAuthority = new AbortController();
    const inputModule = await import("./agent-turn/agent-run-user-turn.js");
    const prepare = inputModule.prepareAgentRunUserTurn;
    using preparation = vi
      .spyOn(inputModule, "prepareAgentRunUserTurn")
      .mockImplementationOnce(async (params) => {
        const input = await prepare(params);
        prepared.resolve();
        await release.promise;
        return input;
      });
    using announce = await mockSubagentAnnounce();
    let refusedFinish: ReturnType<typeof refusePendingInputCommit> | undefined;
    let sending: ReturnType<Awaited<ReturnType<typeof arrangeAuthorityProof>>["send"]> | undefined;
    try {
      const proof = await arrangeAuthorityProof(name);
      sending = proof.send(proof.parent, parentAuthority.signal);
      await prepared.promise;
      expect(preparation).toHaveBeenCalledTimes(1);
      await proof.expectInputs("queued");
      proof.expectUnadopted();
      if (refuseFinish) {
        refusedFinish = refusePendingInputCommit({
          operation: "finish",
          message: "Synthetic pending input finish refusal",
          sessionId: proof.scope.sessionId,
          runId: proof.runId,
        });
      }
      if (revokeParent) {
        parentAuthority.abort();
      }
      if (abortSuccessor) {
        const entry = expectDefined(
          rpcSourceTesting.get(proof.runId),
          "preparing successor abort controller",
        );
        entry.adapter.abortStopReason = "rpc";
        expect(requestRpcSourceCancellation(entry)).toBe(true);
      }
      release.resolve();
      const result = await sending;
      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          revokeParent
            ? "agent tool caller authority is no longer active"
            : "Gateway did not confirm the task resume",
        ),
      });
      proof.expectUnadopted();
      if (refuseFinish) {
        const retry = await proof.send();
        expect(retry.details).toMatchObject({
          status: "error",
          error: expect.stringContaining("Pending input ownership ended"),
        });
        proof.expectUnadopted();
        await proof.expectReceipts([{ state: "pending" }]);
      } else {
        await proof.expectInputs("cancelled");
        await proof.expectReceipts([{ state: "pending", cancelled: true }]);
      }
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([sending]);
      refusedFinish?.mockRestore();
      signal.removeEventListener("abort", releasePreparation);
    }
  },
);

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
      adopted.resolve();
      terminal.mockImplementation(params.io.emitFinal);
      executionCompletion = release.promise.then(() =>
        execute({
          ...params,
          io: { ...params.io, emitFinal: terminal },
        }),
      );
      return executionCompletion;
    });
  using announce = await mockSubagentAnnounce();
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
    await proof.expectInputs("queued");
    // Use registry cancellation without aborting the Gateway signal: the successor
    // ownership fence, not a generic aborted-signal check, must stop dispatch.
    expect(
      await markSubagentRunTerminated({
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
    // Custody remains unconsumed while cancellation records an ordinary failed send.
    await proof.expectInputs("cancelled");
    await proof.expectReceipts([{ state: "pending" }]);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([executionCompletion]);
    execution.mockRestore();
    signal.removeEventListener("abort", releaseExecution);
  }
});

it.each(["explicit", "automatic"] as const)(
  "resumes a visible child with write-only operator authority (%s)",
  async (mode) => {
    const root = tempDirs.make("openclaw-parent-resume-gateway-");
    const release = createDeferred();
    const started = createDeferred();
    using announce = await mockSubagentAnnounce();
    const text = `${"Completed child task detail. ".repeat(200)}Resumed child finished.`;
    const { terminalReply } = prepareAgentRunTerminalReply({ rawText: text });
    try {
      const proof = await arrangeAuthorityProof(`resume-gateway-${mode}`, root);
      const { parent, child, previousRunId } = proof;
      // Success follows real input custody; admission and recorder fences stay production code.
      agentCommandMock.mockImplementation(async (opts) => {
        const command = opts as AgentCommandGatewayIngressOpts;
        const runId = expectDefined(command.runId, "resume execution run id");
        expect(subagentRuns.get(runId)?.taskRunId).toBe(previousRunId);
        const recorder = expectDefined(command.userTurnTranscriptRecorder, "resume input recorder");
        await recorder.persistApproved();
        expect(recorder.hasPersisted()).toBe(true);
        started.resolve();
        await release.promise;
        await appendTranscriptMessage(proof.scope, {
          message: {
            role: "assistant",
            content: text,
            stopReason: "stop",
            __openclaw: { runId },
          },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: Date.now() - 1, endedAt: Date.now(), terminalReply },
        });
        return { payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1, terminalReply } };
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
          context: expectDefined(resolveGatewayContext(), "Gateway context"),
          isWebchatConnect: () => false,
        },
        () =>
          proof.send(
            parent,
            undefined,
            mode === "explicit" ? { mode: "resume" } : { timeoutSeconds: 30, watch: true },
            null,
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
          terminalReply,
        }),
      );
      const completed = expectDefined(
        [...subagentRuns.values()].find((run) => run.childSessionKey === child),
        "completed resumed child",
      );
      const prepared = await readSubagentRunAnnounceResult(completed);
      expect(prepared.text).toBe(text);
      expect(prepared.isCurrent()).toBe(true);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await settleGatewaySessionStoreFixture(root);
    }
  },
);
