import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunCronAgentTurnResult } from "../cron/isolated-agent.js";
import {
  getCompiledOperatorTeam,
  resolveOperatorDelegatedDefaultAlias,
  resolveOperatorDelegatedLeadAlias,
} from "../operator-control/agent-registry.js";
import {
  DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION,
  delegatedLeadTaskEnvelopeSchema,
  type DelegatedLeadTaskEnvelope,
  type OperatorTaskState,
} from "../operator-control/contracts.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { sendUnauthorized } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

export const DELEGATED_MESSAGE_PATH = "/api/message";
const DEFAULT_BODY_BYTES = 128 * 1024;

type DelegatedTaskRunObserver = {
  onStarted: () => void;
  onFinished: (result: RunCronAgentTurnResult) => void;
  onError: (error: unknown) => void;
};

function describeTaskDomain(task: DelegatedLeadTaskEnvelope): string {
  if (task.team_id?.trim()) {
    return `${task.team_id.trim()} domain`;
  }
  if (task.capability?.trim()) {
    return `${task.capability.trim()} domain`;
  }
  return "operator";
}

function resolveDelegatedTransportSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

function resolveDelegatedTargetAgentId(task: DelegatedLeadTaskEnvelope): string | null {
  if (task.team_id?.trim()) {
    const team = getCompiledOperatorTeam(task.team_id);
    if (!team) {
      return null;
    }
  }
  return resolveOperatorDelegatedDefaultAlias({
    explicitAlias: task.alias ?? null,
    teamId: task.team_id ?? null,
  });
}

function resolveDelegatedReceiptOwner(task: DelegatedLeadTaskEnvelope): string | null {
  return resolveOperatorDelegatedLeadAlias({
    teamId: task.team_id ?? null,
  });
}

function buildDelegatedReceiptMetadata(params: {
  task: DelegatedLeadTaskEnvelope;
  targetAgentId: string;
  delegatedRunId: string | null;
  upstreamRunId: string;
  artifactRefs?: string[];
}): Record<string, unknown> {
  return {
    source: "delegated-http",
    team_id: params.task.team_id ?? null,
    resolved_internal_owner: params.targetAgentId,
    artifact_refs: params.artifactRefs ?? [],
    delegatedRunId: params.delegatedRunId,
    upstreamRunId: params.upstreamRunId,
  };
}

export function buildDelegatedAgentMessage(task: DelegatedLeadTaskEnvelope): string {
  const contextLines = task.context_refs.map(
    (ref) => `- [${ref.kind}] ${ref.label ? `${ref.label}: ` : ""}${ref.value}`,
  );
  const inputText =
    Object.keys(task.inputs).length > 0 ? JSON.stringify(task.inputs, null, 2) : "{}";
  const domain = describeTaskDomain(task);

  return [
    `You are executing a ${domain} task dispatched by Tonya.`,
    "",
    `Task ID: ${task.task_id}`,
    `Run ID: ${task.run_id}`,
    `Capability: ${task.capability}`,
    `Objective: ${task.objective}`,
    task.team_id ? `Team: ${task.team_id}` : null,
    task.alias ? `Requested specialist: ${task.alias}` : null,
    "",
    "Acceptance criteria:",
    ...task.acceptance_criteria.map((entry) => `- ${entry}`),
    "",
    "Inputs:",
    "```json",
    inputText,
    "```",
    "",
    "Context references:",
    ...(contextLines.length > 0 ? contextLines : ["- none"]),
    "",
    "Complete the work and return a concise final summary. Include any concrete outputs or artifacts you produced.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function postDelegatedReceipt(params: {
  callbackUrl: string;
  receipt: {
    schema: typeof DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION;
    task_id: string;
    run_id: string;
    delegated_run_id?: string | null;
    upstream_run_id?: string | null;
    state: OperatorTaskState;
    owner: string;
    attempt: number;
    created_at: number;
    updated_at: number;
    queue_latency_ms: number | null;
    summary: string | null;
    artifacts: string[];
    failure_code: string | null;
    result_status: "SUCCESS" | "FAILED" | "RETRY" | null;
    output: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
  log: { warn: (message: string) => void };
}): Promise<void> {
  try {
    const response = await fetch(params.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(params.receipt),
    });
    if (!response.ok) {
      params.log.warn(
        `delegated receipt callback rejected ${params.receipt.task_id}: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    params.log.warn(
      `delegated receipt callback failed ${params.receipt.task_id}: ${String(error)}`,
    );
  }
}

function mapResultToReceiptState(
  result: RunCronAgentTurnResult,
): Pick<
  Awaited<Parameters<typeof postDelegatedReceipt>[0]>["receipt"],
  "state" | "failure_code" | "result_status" | "summary" | "output"
> {
  if (result.status === "ok") {
    return {
      state: "completed",
      failure_code: null,
      result_status: "SUCCESS",
      summary: result.summary?.trim() || result.outputText?.trim() || "Delegated task completed",
      output: {
        delivered: result.delivered ?? null,
        deliveryAttempted: result.deliveryAttempted ?? null,
      },
    };
  }
  if (result.status === "skipped") {
    return {
      state: "blocked",
      failure_code: "delegated-task-skipped",
      result_status: null,
      summary: result.error?.trim() || result.summary?.trim() || "Delegated task was skipped",
      output: {
        delivered: result.delivered ?? null,
        deliveryAttempted: result.deliveryAttempted ?? null,
      },
    };
  }
  return {
    state: "dead-letter",
    failure_code: "delegated-task-error",
    result_status: "FAILED",
    summary: result.error?.trim() || result.summary?.trim() || "Delegated task failed",
    output: {
      delivered: result.delivered ?? null,
      deliveryAttempted: result.deliveryAttempted ?? null,
      outputText: result.outputText?.trim() || null,
    },
  };
}

export function createDelegatedTaskRequestHandler(params: {
  runTask: (params: {
    task: DelegatedLeadTaskEnvelope;
    targetAgentId: string;
    message: string;
    observer: DelegatedTaskRunObserver;
  }) => string;
  log: {
    warn: (message: string) => void;
  };
  maxBodyBytes?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== DELEGATED_MESSAGE_PATH) {
      return false;
    }

    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }

    const expectedSecret = resolveDelegatedTransportSharedSecret();
    if (expectedSecret && !safeEqualSecret(getBearerToken(req), expectedSecret)) {
      sendUnauthorized(res);
      return true;
    }

    const body = await readJsonBodyOrError(req, res, params.maxBodyBytes ?? DEFAULT_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const task = delegatedLeadTaskEnvelopeSchema.parse(body);
    const targetAgentId = resolveDelegatedTargetAgentId(task);
    if (!targetAgentId) {
      sendInvalidRequest(
        res,
        task.team_id?.trim()
          ? `Unknown or unconfigured delegated team: ${task.team_id.trim()}`
          : "No delegated first-class-agent target alias could be resolved from operator config",
      );
      return true;
    }
    const receiptOwner = resolveDelegatedReceiptOwner(task) ?? targetAgentId;
    const acceptedAt = Date.now();
    const callbackUrl = task.callback_url?.trim() || null;
    const upstreamRunId = task.run_id;
    let delegatedRunId: string | null = null;
    const pendingObserverCallbacks: Array<() => void> = [];
    const runOrDefer = (callback: () => void) => {
      if (delegatedRunId) {
        callback();
        return;
      }
      pendingObserverCallbacks.push(callback);
    };

    delegatedRunId = params.runTask({
      task,
      targetAgentId,
      message: buildDelegatedAgentMessage(task),
      observer: {
        onStarted: () => {
          runOrDefer(() => {
            if (!callbackUrl) {
              return;
            }
            void postDelegatedReceipt({
              callbackUrl,
              log: params.log,
              receipt: {
                schema: DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION,
                task_id: task.task_id,
                run_id: upstreamRunId,
                delegated_run_id: delegatedRunId,
                upstream_run_id: upstreamRunId,
                state: "started",
                owner: receiptOwner,
                attempt: 0,
                created_at: acceptedAt,
                updated_at: Date.now(),
                queue_latency_ms: Date.now() - acceptedAt,
                summary: `Delegated task started for ${targetAgentId}`,
                artifacts: [],
                failure_code: null,
                result_status: null,
                output: {
                  agentId: targetAgentId,
                  delegatedRunId,
                  upstreamRunId,
                },
                metadata: buildDelegatedReceiptMetadata({
                  task,
                  targetAgentId,
                  delegatedRunId,
                  upstreamRunId,
                }),
              },
            });
          });
        },
        onFinished: (result) => {
          runOrDefer(() => {
            if (!callbackUrl) {
              return;
            }
            const mapped = mapResultToReceiptState(result);
            void postDelegatedReceipt({
              callbackUrl,
              log: params.log,
              receipt: {
                schema: DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION,
                task_id: task.task_id,
                run_id: upstreamRunId,
                delegated_run_id: delegatedRunId,
                upstream_run_id: upstreamRunId,
                state: mapped.state,
                owner: receiptOwner,
                attempt: 0,
                created_at: acceptedAt,
                updated_at: Date.now(),
                queue_latency_ms: Date.now() - acceptedAt,
                summary: mapped.summary,
                artifacts: [],
                failure_code: mapped.failure_code,
                result_status: mapped.result_status,
                output: {
                  ...mapped.output,
                  agentId: targetAgentId,
                  delegatedRunId,
                  upstreamRunId,
                },
                metadata: buildDelegatedReceiptMetadata({
                  task,
                  targetAgentId,
                  delegatedRunId,
                  upstreamRunId,
                }),
              },
            });
          });
        },
        onError: (error) => {
          runOrDefer(() => {
            if (!callbackUrl) {
              return;
            }
            void postDelegatedReceipt({
              callbackUrl,
              log: params.log,
              receipt: {
                schema: DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION,
                task_id: task.task_id,
                run_id: upstreamRunId,
                delegated_run_id: delegatedRunId,
                upstream_run_id: upstreamRunId,
                state: "dead-letter",
                owner: receiptOwner,
                attempt: 0,
                created_at: acceptedAt,
                updated_at: Date.now(),
                queue_latency_ms: Date.now() - acceptedAt,
                summary: String(error),
                artifacts: [],
                failure_code: "delegated-dispatch-error",
                result_status: "FAILED",
                output: {
                  agentId: targetAgentId,
                  delegatedRunId,
                  upstreamRunId,
                },
                metadata: buildDelegatedReceiptMetadata({
                  task,
                  targetAgentId,
                  delegatedRunId,
                  upstreamRunId,
                }),
              },
            });
          });
        },
      },
    });
    for (const callback of pendingObserverCallbacks) {
      callback();
    }

    sendJson(res, 202, {
      ok: true,
      status: "accepted",
      taskId: task.task_id,
      runId: upstreamRunId,
      delegatedRunId,
      agentId: targetAgentId,
      callbackRegistered: Boolean(callbackUrl),
    });
    return true;
  };
}
