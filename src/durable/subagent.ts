import { createHash } from "node:crypto";
import { isDurableWorkflowsEnabled } from "./config.js";
import { reconcileDurableFanIn, type DurableFanInPolicy } from "./fan-in.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";
import type {
  DurableWorkflowLinkStatus,
  DurableWorkflowRun,
  DurableWorkflowStore,
} from "./types.js";
import {
  DURABLE_AGENT_TURN_WORKFLOW_ID,
  DURABLE_SUBAGENT_RUN_WORKFLOW_ID,
} from "./workflow-ids.js";
const SUBAGENT_PARENT_STEP_ID = "subagents";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? sha256(normalized) : undefined;
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // Durable mirroring must never break the live subagent runtime.
  }
}

function findLatestOpenParentRun(params: {
  store: DurableWorkflowStore;
  requesterSessionKey: string;
  requesterRunId?: string;
}): DurableWorkflowRun | undefined {
  const requesterRunId = params.requesterRunId?.trim();
  const candidates = params.store
    .listOpenRuns({ workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID, limit: 5000 })
    .filter(
      (run) =>
        run.sourceRef === params.requesterSessionKey ||
        run.metadata?.sessionKey === params.requesterSessionKey,
    );
  if (requesterRunId) {
    const exactRun = candidates.find((run) => run.idempotencyKey === requesterRunId);
    if (exactRun) {
      return exactRun;
    }
  }
  return candidates.toSorted((a, b) => {
    const createdDelta = b.createdAt - a.createdAt;
    if (createdDelta !== 0) {
      return createdDelta;
    }
    const updatedDelta = b.updatedAt - a.updatedAt;
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return b.workflowRunId.localeCompare(a.workflowRunId);
  })[0];
}

function mapOutcomeToLinkStatus(status: string | undefined): DurableWorkflowLinkStatus {
  switch (status) {
    case "ok":
    case "success":
    case "succeeded":
      return "succeeded";
    case "cancelled":
    case "killed":
      return "cancelled";
    case "lost":
    case "timed_out":
    case "timeout":
      return "lost";
    default:
      return "failed";
  }
}

export function recordDurableSubagentRegistered(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  taskId?: string;
  taskFlowId?: string;
  task?: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  requesterAgentId?: string;
  requesterRunId?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!isDurableWorkflowsEnabled(env)) {
    return;
  }
  safeCall(() => {
    const now = Date.now();
    const store = openDurableWorkflowSqliteStore({ env });
    try {
      const parent = findLatestOpenParentRun({
        store,
        requesterSessionKey: params.requesterSessionKey,
        requesterRunId: params.requesterRunId,
      });
      const metadata = {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        runId: params.runId,
        taskId: params.taskId,
        taskFlowId: params.taskFlowId,
        taskHash: hashOptional(params.task),
        taskName: boundedText(params.taskName, 120),
        label: boundedText(params.label, 120),
        agentId: params.agentId,
        requesterAgentId: params.requesterAgentId,
        requesterRunId: params.requesterRunId,
      };
      const child = store.createRun({
        workflowId: DURABLE_SUBAGENT_RUN_WORKFLOW_ID,
        workflowVersion: "1",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        requestHash: sha256(`${params.runId}:${params.childSessionKey}`),
        sourceType: "subagent",
        sourceRef: params.childSessionKey,
        parentWorkflowRunId: parent?.workflowRunId,
        parentStepId: parent ? SUBAGENT_PARENT_STEP_ID : undefined,
        metadata,
        now,
      });
      store.createStep({
        workflowRunId: child.workflowRunId,
        stepId: "subagent_run",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        metadata,
        now,
      });
      store.appendEvent({
        workflowRunId: child.workflowRunId,
        eventType: "subagent.run.started",
        eventTime: now,
        stepId: "subagent_run",
        agentInvocationId: params.runId,
        idempotencyKey: params.runId,
        correlationId: params.requesterSessionKey,
        payload: metadata,
      });
      if (!parent) {
        return;
      }
      store.createStep({
        workflowRunId: parent.workflowRunId,
        stepId: SUBAGENT_PARENT_STEP_ID,
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        idempotencyKey: `${parent.workflowRunId}:${SUBAGENT_PARENT_STEP_ID}`,
        metadata: { policy: "continue_on_child_failure" satisfies DurableFanInPolicy },
        now,
      });
      store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: SUBAGENT_PARENT_STEP_ID,
        childWorkflowRunId: child.workflowRunId,
        linkType: "subagent",
        status: "running",
        metadata,
        now,
      });
      store.appendEvent({
        workflowRunId: parent.workflowRunId,
        eventType: "subagent.child.linked",
        eventTime: now,
        stepId: SUBAGENT_PARENT_STEP_ID,
        agentInvocationId: params.runId,
        correlationId: params.childSessionKey,
        payload: {
          childWorkflowRunId: child.workflowRunId,
          ...metadata,
        },
      });
      reconcileDurableFanIn({
        store,
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: SUBAGENT_PARENT_STEP_ID,
        policy: "continue_on_child_failure",
        now,
      });
    } finally {
      store.close();
    }
  });
}

export function recordDurableSubagentTerminal(params: {
  runId: string;
  childSessionKey?: string;
  status?: string;
  error?: string;
  summary?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!isDurableWorkflowsEnabled(env)) {
    return;
  }
  safeCall(() => {
    const now = Date.now();
    const store = openDurableWorkflowSqliteStore({ env });
    try {
      const child = store.createRun({
        workflowId: DURABLE_SUBAGENT_RUN_WORKFLOW_ID,
        workflowVersion: "1",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        requestHash: params.childSessionKey
          ? sha256(`${params.runId}:${params.childSessionKey}`)
          : undefined,
        sourceType: "subagent",
        sourceRef: params.childSessionKey,
        metadata: {
          childSessionKey: params.childSessionKey,
        },
        now,
      });
      const linkStatus = mapOutcomeToLinkStatus(params.status);
      const existingMetadata =
        child.metadata && typeof child.metadata === "object" && !Array.isArray(child.metadata)
          ? child.metadata
          : {};
      const runStatus =
        linkStatus === "succeeded"
          ? "succeeded"
          : linkStatus === "cancelled"
            ? "cancelled"
            : linkStatus === "lost"
              ? "lost"
              : "failed";
      store.updateRun({
        workflowRunId: child.workflowRunId,
        status: runStatus,
        recoveryState: runStatus === "lost" ? "lost" : "terminal",
        completedAt: now,
        metadata: {
          ...existingMetadata,
          childSessionKey: params.childSessionKey,
          status: params.status,
          error: params.error,
          summary: params.summary,
        },
        now,
      });
      store.updateStep({
        workflowRunId: child.workflowRunId,
        stepId: "subagent_run",
        status:
          runStatus === "succeeded"
            ? "succeeded"
            : runStatus === "cancelled"
              ? "cancelled"
              : runStatus === "lost"
                ? "lost"
                : "failed",
        recoveryState: runStatus === "lost" ? "lost" : "terminal",
        completedAt: now,
        metadata: {
          ...existingMetadata,
          childSessionKey: params.childSessionKey,
          status: params.status,
          error: params.error,
          summary: params.summary,
        },
        now,
      });
      store.appendEvent({
        workflowRunId: child.workflowRunId,
        eventType: "subagent.run.terminal",
        eventTime: now,
        stepId: "subagent_run",
        agentInvocationId: params.runId,
        idempotencyKey: `${params.runId}:terminal`,
        correlationId: params.childSessionKey,
        payload: {
          status: params.status,
          error: params.error,
          summary: params.summary,
        },
      });
      for (const link of store.listParentLinks(child.workflowRunId)) {
        const linkMetadata =
          link.metadata && typeof link.metadata === "object" && !Array.isArray(link.metadata)
            ? link.metadata
            : {};
        store.updateLink({
          parentWorkflowRunId: link.parentWorkflowRunId,
          parentStepId: link.parentStepId,
          childWorkflowRunId: link.childWorkflowRunId,
          status: linkStatus,
          metadata: {
            ...linkMetadata,
            childSessionKey: params.childSessionKey,
            status: params.status,
            error: params.error,
            summary: params.summary,
          },
          now,
        });
        store.appendEvent({
          workflowRunId: link.parentWorkflowRunId,
          eventType: "subagent.child.terminal",
          eventTime: now,
          stepId: link.parentStepId,
          agentInvocationId: params.runId,
          correlationId: params.childSessionKey,
          payload: {
            childWorkflowRunId: child.workflowRunId,
            status: linkStatus,
            error: params.error,
            summary: params.summary,
          },
        });
        reconcileDurableFanIn({
          store,
          parentWorkflowRunId: link.parentWorkflowRunId,
          parentStepId: link.parentStepId,
          policy: "continue_on_child_failure",
          now,
        });
      }
    } finally {
      store.close();
    }
  });
}
