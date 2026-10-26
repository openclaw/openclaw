import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { testing as sessionTesting } from "../../sessions/session-controller.test-support.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

export function createMainSessionWaitTool() {
  return createAgentsWaitTool({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    config: { tools: { swarm: true } },
  });
}

export function waitAtBoundary(boundary: "tool" | "bridge", runId: string, signal?: AbortSignal) {
  return boundary === "tool"
    ? createMainSessionWaitTool()
        .execute("wait", { ids: [runId], timeoutSeconds: 1 }, signal)
        .then((result) => result.details)
    : waitForCollectorCompletion({
        runId,
        currentSessionKeys: new Set(["agent:main:main"]),
        currentAgentId: "main",
        signal,
      });
}

export function selectRuns(
  records: ReadonlyMap<string, SubagentRunRecord>,
  runIds: readonly string[],
): Map<string, SubagentRunRecord> {
  return new Map(
    runIds.flatMap((runId) => {
      const entry =
        records.get(runId) ??
        [...records.values()].find((candidate) => candidate.swarmRunId === runId);
      return entry ? [[runId, entry] as const] : [];
    }),
  );
}

export function preparedRuns(
  read: () => ReadonlyMap<string, SubagentRunRecord>,
): PreparedSubagentRunsRead {
  return {
    consume: (consume) => ({ ready: true, value: consume(read()) }),
  };
}

export function collectorRun(
  runId: string,
  requesterSessionKey: string,
  completion?: SubagentRunRecord["collectorCompletion"],
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:worker:subagent:${runId}`,
    controllerSessionKey: requesterSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: runId,
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: completion ? "terminal" : "running" },
    collect: true,
    swarmRequesterSessionKey: requesterSessionKey,
    groupId: "group",
    completion: { required: false, resultText: completion ? `result-${runId}` : undefined },
    collectorCompletion: completion,
  };
}

export function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

export async function startParentWait({
  records,
  read: readRuns,
  codeMode = false,
}: {
  records: Map<string, SubagentRunRecord>;
  read: Mock<(runIds: readonly string[]) => Promise<PreparedSubagentRunsRead>>;
  codeMode?: boolean;
}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const h = createCodeModeHarness({ agentId: "main" });
  const { sessionId, sessionKey, runId } = h.ctx;
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "wait-test");
  const admitted = await admission.admit("embedded");
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "main",
    sessionKey,
  });
  const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  operation.setPhase("running");
  const signal = new AbortController();
  const abort = vi.fn(() => {
    signal.abort();
    operation.complete();
  });
  operation.attachBackend({ kind: "embedded", runId, cancel: abort });
  const attempt = operation.watchdog.attachAttempt({
    assertCurrent: () => operation.abortSignal.throwIfAborted(),
  });
  const endTool = attempt.beginTool({
    toolName: codeMode ? "exec" : "agents_wait",
    toolCallId: "join",
  });
  const startedAt = Date.now();
  const entry = collectorRun("long-collector", sessionKey);
  records.set(entry.runId, entry);
  const read = createDeferred();
  readRuns.mockImplementation(async (ids) =>
    preparedRuns(() => {
      read.resolve();
      return selectRuns(records, ids);
    }),
  );
  const tool = createMainSessionWaitTool();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
  const result = withGatewayToolCallerIdentity(
    { ...expectDefined(caller, "admitted caller"), watchdogAttempt: attempt },
    () =>
      (codeMode ? expectDefined(h.tools[0], "exec") : tool).execute(
        "join",
        codeMode
          ? {
              title: "Join required child",
              awaitResults: true,
              code: 'return await agents_wait({ids:["long-collector"], awaitResults:true});',
            }
          : { ids: [entry.runId], awaitResults: true },
        signal.signal,
      ),
  );
  const observed = observe(result);
  onTestFinished(async () => {
    signal.abort();
    await observed;
    endTool();
    operation.complete();
    admission.close();
    await resetCodeModeTestState();
    sessionTesting.resetSessionControllerForTest();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });
  return {
    admission,
    operation,
    attempt,
    abort,
    entry,
    result,
    read: read.promise,
    advancePastQuietToolDeadline() {
      vi.setSystemTime(startedAt + 16 * 60_000);
    },
  };
}
