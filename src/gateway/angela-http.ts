import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunCronAgentTurnResult } from "../cron/isolated-agent.js";
import { angelaTaskEnvelopeSchema, type OperatorTaskState } from "../operator-control/contracts.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { sendUnauthorized } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

export const ANGELA_MESSAGE_PATH = "/api/message";
const DEFAULT_MARKETING_AGENT_ID = "tonys-angels";
const DEFAULT_BODY_BYTES = 128 * 1024;

type AngelaTaskEnvelope = ReturnType<typeof angelaTaskEnvelopeSchema.parse>;

type AngelaTaskRunObserver = {
  onStarted: () => void;
  onFinished: (result: RunCronAgentTurnResult) => void;
  onError: (error: unknown) => void;
};

function resolveAngelaSharedSecret(): string | null {
  const secret = process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

export function buildAngelaAgentMessage(task: AngelaTaskEnvelope): string {
  const contextLines = task.context_refs.map(
    (ref) => `- [${ref.kind}] ${ref.label ? `${ref.label}: ` : ""}${ref.value}`,
  );
  const inputText =
    Object.keys(task.inputs).length > 0 ? JSON.stringify(task.inputs, null, 2) : "{}";

  return [
    "You are executing a marketing-domain task dispatched by Tonya.",
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

async function postAngelaReceipt(params: {
  callbackUrl: string;
  receipt: {
    schema: "AngelaTaskReceiptV1";
    task_id: string;
    run_id: string;
    state: OperatorTaskState;
    owner: "angela";
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
        `angela receipt callback rejected ${params.receipt.task_id}: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    params.log.warn(`angela receipt callback failed ${params.receipt.task_id}: ${String(error)}`);
  }
}

function mapResultToReceiptState(
  result: RunCronAgentTurnResult,
): Pick<
  Awaited<Parameters<typeof postAngelaReceipt>[0]>["receipt"],
  "state" | "failure_code" | "result_status" | "summary" | "output"
> {
  if (result.status === "ok") {
    return {
      state: "completed",
      failure_code: null,
      result_status: "SUCCESS",
      summary: result.summary?.trim() || result.outputText?.trim() || "Angela task completed",
      output: {
        delivered: result.delivered ?? null,
        deliveryAttempted: result.deliveryAttempted ?? null,
      },
    };
  }
  if (result.status === "skipped") {
    return {
      state: "blocked",
      failure_code: "angela-task-skipped",
      result_status: null,
      summary: result.error?.trim() || result.summary?.trim() || "Angela task was skipped",
      output: {
        delivered: result.delivered ?? null,
        deliveryAttempted: result.deliveryAttempted ?? null,
      },
    };
  }
  return {
    state: "dead-letter",
    failure_code: "angela-task-error",
    result_status: "FAILED",
    summary: result.error?.trim() || result.summary?.trim() || "Angela task failed",
    output: {
      delivered: result.delivered ?? null,
      deliveryAttempted: result.deliveryAttempted ?? null,
      outputText: result.outputText?.trim() || null,
    },
  };
}

export function createAngelaTaskRequestHandler(params: {
  runTask: (params: {
    task: AngelaTaskEnvelope;
    targetAgentId: string;
    message: string;
    observer: AngelaTaskRunObserver;
  }) => string;
  log: {
    warn: (message: string) => void;
  };
  maxBodyBytes?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== ANGELA_MESSAGE_PATH) {
      return false;
    }

    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }

    const expectedSecret = resolveAngelaSharedSecret();
    if (expectedSecret && !safeEqualSecret(getBearerToken(req), expectedSecret)) {
      sendUnauthorized(res);
      return true;
    }

    const body = await readJsonBodyOrError(req, res, params.maxBodyBytes ?? DEFAULT_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const task = angelaTaskEnvelopeSchema.parse(body);
    const targetAgentId =
      task.alias?.trim() ||
      process.env.OPENCLAW_ANGELA_DEFAULT_AGENT_ID?.trim() ||
      DEFAULT_MARKETING_AGENT_ID;
    const acceptedAt = Date.now();
    const callbackUrl = task.callback_url?.trim() || null;

    const runId = params.runTask({
      task,
      targetAgentId,
      message: buildAngelaAgentMessage(task),
      observer: {
        onStarted: () => {
          if (!callbackUrl) {
            return;
          }
          void postAngelaReceipt({
            callbackUrl,
            log: params.log,
            receipt: {
              schema: "AngelaTaskReceiptV1",
              task_id: task.task_id,
              run_id: task.run_id,
              state: "started",
              owner: "angela",
              attempt: 0,
              created_at: acceptedAt,
              updated_at: Date.now(),
              queue_latency_ms: Date.now() - acceptedAt,
              summary: `Angela started ${targetAgentId}`,
              artifacts: [],
              failure_code: null,
              result_status: null,
              output: {
                agentId: targetAgentId,
              },
              metadata: {
                source: "angela-http",
                targetAgentId,
              },
            },
          });
        },
        onFinished: (result) => {
          if (!callbackUrl) {
            return;
          }
          const mapped = mapResultToReceiptState(result);
          void postAngelaReceipt({
            callbackUrl,
            log: params.log,
            receipt: {
              schema: "AngelaTaskReceiptV1",
              task_id: task.task_id,
              run_id: task.run_id,
              state: mapped.state,
              owner: "angela",
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
              },
              metadata: {
                source: "angela-http",
                targetAgentId,
              },
            },
          });
        },
        onError: (error) => {
          if (!callbackUrl) {
            return;
          }
          void postAngelaReceipt({
            callbackUrl,
            log: params.log,
            receipt: {
              schema: "AngelaTaskReceiptV1",
              task_id: task.task_id,
              run_id: task.run_id,
              state: "dead-letter",
              owner: "angela",
              attempt: 0,
              created_at: acceptedAt,
              updated_at: Date.now(),
              queue_latency_ms: Date.now() - acceptedAt,
              summary: String(error),
              artifacts: [],
              failure_code: "angela-dispatch-error",
              result_status: "FAILED",
              output: {
                agentId: targetAgentId,
              },
              metadata: {
                source: "angela-http",
                targetAgentId,
              },
            },
          });
        },
      },
    });

    sendJson(res, 202, {
      ok: true,
      status: "accepted",
      taskId: task.task_id,
      runId: runId || task.run_id,
      agentId: targetAgentId,
      callbackRegistered: Boolean(callbackUrl),
    });
    return true;
  };
}
