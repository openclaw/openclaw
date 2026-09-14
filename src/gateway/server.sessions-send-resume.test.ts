/** Real isolated Gateway: model-facing resume transfers a paused task before execution. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import { subagentRegistryDeps } from "../agents/subagents/registry/subagent-registry-deps.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../agents/subagents/registry/subagent-registry-run-wait.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { findTaskByRunId } from "../tasks/task-registry.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  startTestGatewayServer,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
    server = await startTestGatewayServer(await getGatewayTestPort());
  } finally {
    capture.mockRestore();
  }
});
afterAll(async () => {
  await server.close();
});

it("resumes a visible child through sessions_send and delivers exactly one task-owned result", async () => {
  const root = tempDirs.make("openclaw-parent-resume-gateway-");
  const parent = "agent:main:main";
  const child = "agent:main:dashboard:resume-proof";
  const previousRunId = "resume-gateway-paused";
  const release = createDeferred();
  const started = createDeferred();
  const announce = vi
    .spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow")
    .mockResolvedValue("delivered");
  testState.sessionStorePath = path.join(root, "sessions.json");
  try {
    await writeSessionStore({
      entries: {
        [parent]: { sessionId: "resume-parent", updatedAt: Date.now() },
        [child]: {
          sessionId: "resume-child",
          updatedAt: Date.now(),
          spawnedBy: parent,
          spawnDepth: 1,
        },
      },
    });
    await prepareGatewayReplyRuntimeForTest();
    // Seed paused registry/canonical-task state without polling a nonexistent source execution.
    registerSubagentRun({
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
    const taskId = findTaskByRunId(previousRunId)?.taskId;
    expect(taskId).toBeTruthy();
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
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: parent,
        operationalRunInstance: createOperationalRunInstanceRef("resume-gateway-parent-turn"),
        receiptAuthority: () => true,
        gatewayContextResolver: () => kernel.gatewayRequestContext,
      },
      () =>
        tool.execute("resume-proof", {
          sessionKey: child,
          mode: "resume",
          message: "The answer is ready; finish the task.",
        }),
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
    expect(findTaskByRunId(previousRunId)?.taskId).toBe(taskId);
    release.resolve();
    await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: parent,
        childSessionKey: child,
        roundOneReply: "Resumed child finished.",
      }),
    );
    await vi.waitFor(() => expect(findTaskByRunId(previousRunId)?.status).toBe("succeeded"));
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    announce.mockRestore();
    testState.sessionStorePath = undefined;
  }
});
