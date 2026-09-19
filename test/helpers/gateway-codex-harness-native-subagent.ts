import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type TestContext } from "vitest";
import type {
  EventFrame,
  TasksGetResult,
  TasksHistoryResult,
  TasksListResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../../src/gateway/client.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../../src/tasks/task-registry.store.sqlite.js";
import type { CapturedAgentEvent } from "./gateway-codex-harness.js";

type NativeSubagentProbeParams = {
  annotate: TestContext["annotate"];
  client: GatewayClient;
  events: EventFrame[];
  sessionKey: string;
};

type GatewaySession = Pick<NativeSubagentProbeParams, "client" | "sessionKey">;

type NativeSubagentProbeHarness = {
  requestTimeoutMs: number;
  observedCodexThreadIds: ReadonlyMap<string, string>;
  logCodexLiveStep: (step: string, details?: Record<string, unknown>) => void;
  requestAgentTextWithEvents: (
    params: GatewaySession & {
      acceptYieldedTimeout?: boolean;
      eventPrefix?: string;
      includeAllSessions?: boolean;
      message: string;
    },
  ) => Promise<{ runId: string; text: string; events: CapturedAgentEvent[] }>;
  recordCodexAttemptIdentity: (params: {
    events: CapturedAgentEvent[];
    runId: string;
    sessionKey: string;
  }) => void;
  requestCodexCommandText: (
    params: GatewaySession & { command: string; events: EventFrame[]; expectedText: string },
  ) => Promise<string>;
  requestAgentText: (
    params: GatewaySession & { expectedReply: string; message: string },
  ) => Promise<string>;
};

export async function verifyCodexNativeSubagentBridgeProbe(
  params: NativeSubagentProbeParams,
  {
    requestTimeoutMs: CODEX_HARNESS_REQUEST_TIMEOUT_MS,
    observedCodexThreadIds,
    logCodexLiveStep,
    requestAgentTextWithEvents,
    recordCodexAttemptIdentity,
    requestCodexCommandText,
    requestAgentText,
  }: NativeSubagentProbeHarness,
): Promise<void> {
  const runId = randomUUID();
  const childToken = `CODEX-NATIVE-CHILD-${runId.slice(0, 6).toUpperCase()}`;
  const parentToken = `CODEX-NATIVE-PARENT-${runId.slice(0, 6).toUpperCase()}`;
  const {
    text,
    events,
    runId: parentRunId,
  } = await requestAgentTextWithEvents({
    // Native Codex waiting pauses this parent turn; task delivery resumes it separately.
    acceptYieldedTimeout: true,
    client: params.client,
    eventPrefix: "codex_app_server.",
    includeAllSessions: true,
    sessionKey: params.sessionKey,
    message: [
      "Bridge probe.",
      "You must use the Codex native spawn_agent tool exactly once before replying.",
      `Give the subagent this exact instruction: Reply exactly ${childToken} and nothing else.`,
      "Wait for the subagent result. Do not answer from your own knowledge.",
      `After the subagent result returns, reply exactly ${parentToken} ${childToken} and nothing else.`,
    ].join("\n"),
  });
  logCodexLiveStep("native-subagent-bridge-probe:initial-reply", { text });
  recordCodexAttemptIdentity({
    events,
    runId: parentRunId,
    sessionKey: params.sessionKey,
  });
  expect(
    events.some((event) => event.stream === "codex_app_server.lifecycle"),
    `expected Codex lifecycle events; events=${JSON.stringify(events)}`,
  ).toBe(true);
  let codexNativeTasks = await listCodexNativeTasks();
  let deliveredTask = findDeliveredCodexNativeTask(codexNativeTasks);
  const deadline = Date.now() + CODEX_HARNESS_REQUEST_TIMEOUT_MS;
  while (!deliveredTask && Date.now() < deadline) {
    await delay(1_000);
    codexNativeTasks = await listCodexNativeTasks();
    deliveredTask = findDeliveredCodexNativeTask(codexNativeTasks);
  }
  expect(
    deliveredTask,
    `expected delivered Codex-native subagent task with child result; initialText=${JSON.stringify(
      text,
    )}; events=${JSON.stringify(events)}; tasks=${JSON.stringify(codexNativeTasks)}`,
  ).toBeDefined();
  if (!deliveredTask) {
    throw new Error("Native child completion was not persisted.");
  }
  const childThreadId = deliveredTask.sourceId?.match(/^codex-thread:([^:]+)$/)?.[1];
  expect(childThreadId).toBeTypeOf("string");
  const firstRecord = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(deliveredTask.id);
  const parentThreadId = observedCodexThreadIds.get(params.sessionKey);
  const initialTaskSnapshot = {
    taskId: deliveredTask.id,
    runId: firstRecord?.runId,
    nativeTurnId: asOptionalRecord(firstRecord?.detail)?.nativeTurnId,
    historyParentThreadId: asOptionalRecord(asOptionalRecord(firstRecord?.detail)?.nativeHistory)
      ?.parentThreadId,
    parentThreadId,
    childThreadId,
    status: firstRecord?.status,
    resultMatched: firstRecord?.terminalSummary === childToken,
  };
  logCodexLiveStep("native-subagent-bridge-probe:initial-task", initialTaskSnapshot);
  await params.annotate("native-subagent-initial-task", {
    body: JSON.stringify(initialTaskSnapshot),
    bodyEncoding: "utf-8",
    contentType: "application/json",
  });
  expect(asOptionalRecord(firstRecord?.detail)?.nativeTurnId).toBeTypeOf("string");
  expect(parentThreadId).toBeTypeOf("string");
  const expectedAssignments = [
    { taskId: deliveredTask.id, result: childToken, record: firstRecord },
  ];
  for (const [ordinal, prefix] of [
    ["SECOND", "FOLLOWUP"],
    ["THIRD", "THIRD"],
  ] as const) {
    const followupToken = `CODEX-NATIVE-${prefix}-${runId.slice(0, 6).toUpperCase()}`;
    const followupParentToken = `CODEX-NATIVE-PARENT-${prefix}-${runId.slice(0, 6).toUpperCase()}`;
    // Each Gateway request owns a fresh parent registration after the prior turn ended.
    const followup = await requestAgentTextWithEvents({
      client: params.client,
      eventPrefix: "codex_app_server.",
      includeAllSessions: true,
      sessionKey: params.sessionKey,
      message: [
        `Give the existing native child ${childThreadId} another assignment. Do not spawn a new child.`,
        "Use native followup_task, or send_input if that is the available native follow-up tool.",
        `Tell that child: Run the native exec_command tool with command printf ${ordinal}_NATIVE_SHELL, then reply exactly ${followupToken} and nothing else.`,
        "Wait for its new result before replying. Do not answer from your own knowledge. Keep the child open for another follow-up.",
        `After the new child result returns, reply exactly ${followupParentToken} ${followupToken} and nothing else.`,
      ].join("\n"),
    });
    recordCodexAttemptIdentity({
      events: followup.events,
      runId: followup.runId,
      sessionKey: params.sessionKey,
    });
    const currentFirstRecord = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(
      deliveredTask.id,
    );
    logCodexLiveStep("native-subagent-followup:identity", {
      ordinal,
      runId: followup.runId,
      parentThreadId: observedCodexThreadIds.get(params.sessionKey),
      childThreadId,
      replyMatched: followup.text.trim() === `${followupParentToken} ${followupToken}`,
      initialNativeTurnId: initialTaskSnapshot.nativeTurnId,
      currentFirstNativeTurnId: asOptionalRecord(currentFirstRecord?.detail)?.nativeTurnId,
      firstResultMatched: currentFirstRecord?.terminalSummary === childToken,
    });
    expect(followup.text.trim()).toBe(`${followupParentToken} ${followupToken}`);
    expect(observedCodexThreadIds.get(params.sessionKey)).toBe(parentThreadId);
    try {
      await expect
        .poll(
          async () => {
            codexNativeTasks = await listCodexNativeTasks();
            return findDeliveredCodexNativeTask(codexNativeTasks, followupToken);
          },
          { timeout: CODEX_HARNESS_REQUEST_TIMEOUT_MS, interval: 1_000 },
        )
        .toBeDefined();
    } catch (error) {
      const records = loadTaskRegistryStateFromSqliteReadOnly().tasks;
      logCodexLiveStep("native-subagent-followup:missing-task", {
        ordinal,
        priorAssignments: expectedAssignments.map((assignment) => ({
          id: assignment.taskId,
          runId: assignment.record?.runId,
          nativeTurnId: asOptionalRecord(assignment.record?.detail)?.nativeTurnId,
          status: assignment.record?.status,
          result: assignment.result,
        })),
        tasks: codexNativeTasks.map((task) => ({
          id: task.id,
          runId: task.runId,
          status: task.status,
          deliveryStatus: task.deliveryStatus,
          nativeTurnId: asOptionalRecord(records.get(task.id)?.detail)?.nativeTurnId,
          summary: task.terminalSummary ?? task.progressSummary,
        })),
      });
      throw error;
    }
    codexNativeTasks = await listCodexNativeTasks();
    const followupTask = findDeliveredCodexNativeTask(codexNativeTasks, followupToken)!;
    expect(expectedAssignments.map((assignment) => assignment.taskId)).not.toContain(
      followupTask.id,
    );
    expect(
      codexNativeTasks.filter((task) => task.sourceId?.startsWith(`codex-thread:${childThreadId}`)),
    ).toHaveLength(expectedAssignments.length + 1);
    const persisted = loadTaskRegistryStateFromSqliteReadOnly().tasks;
    for (const assignment of expectedAssignments) {
      expect(persisted.get(assignment.taskId)).toEqual(assignment.record);
    }
    const followupRecord = persisted.get(followupTask.id);
    const nativeTurnId = asOptionalRecord(followupRecord?.detail)?.nativeTurnId;
    if (typeof nativeTurnId !== "string") {
      throw new Error("Follow-up task did not persist its native turn locator.");
    }
    expect(
      expectedAssignments.map(
        (assignment) => asOptionalRecord(assignment.record?.detail)?.nativeTurnId,
      ),
    ).not.toContain(nativeTurnId);
    expect(followupTask.sourceId).toBe(`codex-thread:${childThreadId}:turn:${nativeTurnId}`);
    expectedAssignments.push({
      taskId: followupTask.id,
      result: followupToken,
      record: followupRecord,
    });
    let childHistory: unknown[] | undefined;
    for (const { taskId, result } of expectedAssignments) {
      const detail = await params.client.request<TasksGetResult>("tasks.get", { taskId });
      expect(detail.task.result).toBe(result);
      const history = await params.client.request<TasksHistoryResult>("tasks.history", {
        taskId,
        limit: 100,
      });
      expect(JSON.stringify(history.messages)).toContain(result);
      if (childHistory) {
        expect(history.messages).toEqual(childHistory);
      } else {
        childHistory = history.messages;
      }
      for (const shellOrdinal of ordinal === "SECOND" ? ["SECOND"] : ["SECOND", "THIRD"]) {
        expect(history.messages).toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            content: [{ type: "text", text: `${shellOrdinal}_NATIVE_SHELL` }],
            isError: false,
          }),
        );
      }
    }
    logCodexLiveStep("native-subagent-followup:complete", {
      childThreadId,
      assignmentCount: expectedAssignments.length,
      firstTaskId: deliveredTask.id,
      followupTaskId: followupTask.id,
      nativeTurnId,
      parentReply: followup.text,
      firstResult: childToken,
      followupResult: followupToken,
    });
  }

  const parentControlledChild = events.some(
    (event) => event.stream === "codex_app_server.item" && event.data?.type === "subAgentActivity",
  );
  if (parentControlledChild) {
    // Native task IDs record the child thread at creation; model output is not
    // authoritative enough to select the thread for this ownership probe.
    const threadIdBefore = observedCodexThreadIds.get(params.sessionKey);
    expect(threadIdBefore).toBeTypeOf("string");
    expect(threadIdBefore).not.toBe(childThreadId);
    await requestCodexCommandText({
      ...params,
      command: `/codex resume ${childThreadId}`,
      expectedText: "controlled by its parent",
    });
    await requestAgentText({
      client: params.client,
      sessionKey: params.sessionKey,
      message: "Reply exactly PARENT-STILL-ATTACHED and nothing else.",
      expectedReply: "PARENT-STILL-ATTACHED",
    });
    expect(observedCodexThreadIds.get(params.sessionKey)).toBe(threadIdBefore);
    logCodexLiveStep("native-subagent-direct-input:rejected", { childThreadId });
  } else {
    logCodexLiveStep("native-subagent-direct-input:legacy-not-applicable");
  }

  async function listCodexNativeTasks() {
    const { tasks, nextCursor } = await params.client.request<TasksListResult>("tasks.list", {
      sessionKey: params.sessionKey,
      limit: 500,
    });
    expect(nextCursor, "isolated native probe must fit in one task page").toBeUndefined();
    return tasks.filter((entry) => entry.runtime === "subagent" && entry.kind === "codex-native");
  }

  function findDeliveredCodexNativeTask(
    tasks: Awaited<ReturnType<typeof listCodexNativeTasks>>,
    result = childToken,
  ) {
    return tasks.find(
      (entry) =>
        entry.status === "completed" &&
        entry.deliveryStatus === "delivered" &&
        entry.terminalSummary?.includes(result),
    );
  }
}
