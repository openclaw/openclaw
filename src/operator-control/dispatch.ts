import { ZodError } from "zod";
import { getOperatorTask, patchOperatorTask, submitOperatorTask } from "./task-store.js";
import type { OperatorTaskRecord } from "./task-store.js";
import { getResolvedOperatorTaskTeam } from "./team-routing.js";
import {
  resolve2TonyBaseUrl,
  resolve2TonySharedSecret,
  resolveOperatorReceiptTemplate,
} from "./worker-status.js";

const SUPPORTED_2TONY_TASK_TYPES = new Set([
  "build",
  "generate-docs",
  "git-status",
  "lint",
  "prisma-validate",
  "security-scan",
  "test",
  "validate-k8s",
]);

type DispatchResult =
  | {
      attempted: false;
      reason: string;
    }
  | {
      attempted: true;
      accepted: boolean;
      endpoint: string;
      statusCode: number;
      message: string;
    };

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/u, "");
}

function mapTierToPriority(tier: "LITE" | "STANDARD" | "HEAVY"): "low" | "normal" | "high" {
  switch (tier) {
    case "LITE":
      return "low";
    case "HEAVY":
      return "high";
    default:
      return "normal";
  }
}

function resolveReceiptUrl(taskId: string): string | undefined {
  const template = resolveOperatorReceiptTemplate();
  if (!template) {
    return undefined;
  }
  return template.replace(/\{taskId\}/gu, encodeURIComponent(taskId));
}

function readJsonLikeMessage(response: Response): Promise<string> {
  return response
    .json()
    .then((parsed) => {
      if (parsed && typeof parsed === "object") {
        if ("message" in parsed && typeof parsed.message === "string" && parsed.message.trim()) {
          return parsed.message.trim();
        }
        if ("status" in parsed && typeof parsed.status === "string" && parsed.status.trim()) {
          return parsed.status.trim();
        }
        if ("output" in parsed && typeof parsed.output === "string" && parsed.output.trim()) {
          return parsed.output.trim();
        }
      }
      return `${response.status} ${response.statusText}`;
    })
    .catch(() => `${response.status} ${response.statusText}`);
}

function normalizeIdentifier(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function hasArrayField(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => Array.isArray(record[key]) && record[key].length > 0);
}

function hasRecordField(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => {
    const value = record[key];
    return typeof value === "object" && value !== null && !Array.isArray(value);
  });
}

function resolveExplicit2TonyTaskType(inputs: Record<string, unknown>): string | null {
  return readStringField(
    inputs,
    "worker_task_type",
    "workerTaskType",
    "task_type",
    "taskType",
    "2tony_task_type",
    "two_tony_task_type",
  );
}

function infer2TonyTaskTypeFromInputs(inputs: Record<string, unknown>): string | null {
  if (readStringField(inputs, "manifest", "yaml")) {
    return "validate-k8s";
  }
  if (readStringField(inputs, "schema")) {
    return "prisma-validate";
  }
  if (hasArrayField(inputs, "tests")) {
    return "test";
  }
  if (readStringField(inputs, "source", "code")) {
    return "build";
  }
  if (readStringField(inputs, "template")) {
    return "generate-docs";
  }
  if (hasRecordField(inputs, "files", "dependencies")) {
    return "security-scan";
  }
  if (
    readStringField(inputs, "branch") ||
    hasArrayField(inputs, "modified", "staged", "untracked") ||
    typeof inputs.aheadBy === "number" ||
    typeof inputs.behindBy === "number"
  ) {
    return "git-status";
  }
  return null;
}

function resolve2TonyTaskType(task: OperatorTaskRecord): string {
  const inputs = asRecord(task.envelope.inputs) ?? {};
  const explicitType = resolveExplicit2TonyTaskType(inputs);
  if (explicitType) {
    const normalizedExplicitType = normalizeIdentifier(explicitType);
    if (!SUPPORTED_2TONY_TASK_TYPES.has(normalizedExplicitType)) {
      throw new Error(
        `unsupported 2Tony task type override "${explicitType}" (supported: ${Array.from(SUPPORTED_2TONY_TASK_TYPES).join(", ")})`,
      );
    }
    return normalizedExplicitType;
  }

  const capability = normalizeIdentifier(task.envelope.target.capability);
  if (SUPPORTED_2TONY_TASK_TYPES.has(capability)) {
    return capability;
  }

  const inferredType = infer2TonyTaskTypeFromInputs(inputs);
  if (inferredType) {
    return inferredType;
  }

  throw new Error(
    `2Tony task type could not be inferred for capability "${task.envelope.target.capability}". Set inputs.worker_task_type to one of ${Array.from(SUPPORTED_2TONY_TASK_TYPES).join(", ")} or provide compatible inputs (source/code, tests, manifest/yaml, schema, template, files/dependencies, git status fields).`,
  );
}

function build2TonyPayload(task: OperatorTaskRecord) {
  const team = getResolvedOperatorTaskTeam(task.envelope);
  const taskType = resolve2TonyTaskType(task);
  const rawInputs = asRecord(task.envelope.inputs) ?? {};
  return {
    taskId: task.envelope.task_id,
    runId: task.receipt.run_id,
    type: taskType,
    timeoutMs: task.envelope.timeout_s * 1000,
    priority: mapTierToPriority(task.envelope.tier),
    callbackUrl: resolveReceiptUrl(task.envelope.task_id),
    payload: {
      ...rawInputs,
      objective: task.envelope.objective,
      inputs: rawInputs,
      contextRefs: task.envelope.context_refs,
      acceptanceCriteria: task.envelope.acceptance_criteria,
      requester: task.envelope.requester,
      target: task.envelope.target,
      execution: task.envelope.execution,
      requestedCapability: task.envelope.target.capability,
      workerTaskType: taskType,
    },
    metadata: {
      operatorTaskId: task.envelope.task_id,
      operatorRunId: task.receipt.run_id,
      requesterId: task.envelope.requester.id,
      capability: task.envelope.target.capability,
      workerTaskType: taskType,
      teamId: task.envelope.target.team_id ?? null,
      teamLead: team?.lead ?? null,
      alias: task.envelope.target.alias ?? null,
      tier: task.envelope.tier,
    },
  };
}

function resolveDebBaseUrl(): string | null {
  return normalizeBaseUrl(process.env.OPENCLAW_OPERATOR_DEB_URL);
}

function resolveDebSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_DEB_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_DEB_SHARED_SECRET?.trim();
  return secret || null;
}

function resolveAngelaBaseUrl(): string | null {
  return normalizeBaseUrl(process.env.OPENCLAW_OPERATOR_ANGELA_URL);
}

function resolveAngelaSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

function buildDebPayload(task: OperatorTaskRecord): {
  endpoint: string;
  init: RequestInit;
  owner: string;
  successState: "completed";
} {
  const baseUrl = resolveDebBaseUrl();
  if (!baseUrl) {
    throw new Error("Deb base URL not configured");
  }

  const inputs = task.envelope.inputs ?? {};
  const command =
    typeof inputs.deb_command === "string" && inputs.deb_command.trim().length > 0
      ? inputs.deb_command.trim().toLowerCase()
      : "update";

  if (command === "status" || command === "sync") {
    return {
      endpoint: `${baseUrl}/${command}`,
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(resolveDebSharedSecret()
            ? {
                authorization: `Bearer ${resolveDebSharedSecret()}`,
              }
            : {}),
        },
      },
      owner: "deb",
      successState: "completed",
    };
  }

  const itemUrl =
    typeof inputs.item_url === "string" && inputs.item_url.trim().length > 0
      ? inputs.item_url.trim()
      : typeof inputs.itemUrl === "string" && inputs.itemUrl.trim().length > 0
        ? inputs.itemUrl.trim()
        : null;
  const set = typeof inputs.set === "object" && inputs.set !== null ? inputs.set : {};
  const clear = Array.isArray(inputs.clear) ? inputs.clear : [];
  if (!itemUrl) {
    throw new Error("deb-http dispatch requires inputs.item_url or inputs.itemUrl");
  }

  return {
    endpoint: `${baseUrl}/update`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(resolveDebSharedSecret()
          ? {
              authorization: `Bearer ${resolveDebSharedSecret()}`,
            }
          : {}),
      },
      body: JSON.stringify({
        item_url: itemUrl,
        set,
        clear,
      }),
    },
    owner: "deb",
    successState: "completed",
  };
}

function buildAngelaPayload(task: OperatorTaskRecord): {
  endpoint: string;
  init: RequestInit;
  owner: string;
  successState: "queued";
} {
  const baseUrl = resolveAngelaBaseUrl();
  if (!baseUrl) {
    throw new Error("Angela base URL not configured");
  }

  const team = getResolvedOperatorTaskTeam(task.envelope);
  return {
    endpoint: `${baseUrl}/api/message`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(resolveAngelaSharedSecret()
          ? {
              authorization: `Bearer ${resolveAngelaSharedSecret()}`,
            }
          : {}),
      },
      body: JSON.stringify({
        schema: "AngelaTaskEnvelopeV1",
        task_id: task.envelope.task_id,
        run_id: task.receipt.run_id,
        callback_url: resolveReceiptUrl(task.envelope.task_id) ?? null,
        receipt_schema: "AngelaTaskReceiptV1",
        objective: task.envelope.objective,
        capability: task.envelope.target.capability,
        team_id: task.envelope.target.team_id ?? null,
        team_lead: team?.lead ?? null,
        alias: task.envelope.target.alias ?? null,
        requester: task.envelope.requester,
        acceptance_criteria: task.envelope.acceptance_criteria,
        context_refs: task.envelope.context_refs,
        inputs: task.envelope.inputs,
        reply_to: task.envelope.reply_to ?? null,
        execution: task.envelope.execution,
      }),
    },
    owner: "angela",
    successState: "queued",
  };
}

async function dispatchTo2Tony(task: OperatorTaskRecord): Promise<DispatchResult> {
  const baseUrl = resolve2TonyBaseUrl();
  if (!baseUrl) {
    return {
      attempted: false,
      reason: "2Tony base URL not configured",
    };
  }

  const payload = build2TonyPayload(task);
  const endpoint = `${baseUrl}/task`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(resolve2TonySharedSecret()
        ? {
            authorization: `Bearer ${resolve2TonySharedSecret()}`,
          }
        : {}),
    },
    body: JSON.stringify(payload),
  });
  const message = await readJsonLikeMessage(response);

  if (response.ok) {
    patchOperatorTask(task.envelope.task_id, {
      state: "queued",
      owner: "2tony",
      note: `dispatched to 2Tony: ${message}`,
    });
  }

  return {
    attempted: true,
    accepted: response.ok,
    endpoint,
    statusCode: response.status,
    message,
  };
}

async function dispatchToDeb(task: OperatorTaskRecord): Promise<DispatchResult> {
  const request = buildDebPayload(task);
  const response = await fetch(request.endpoint, request.init);
  const message = await readJsonLikeMessage(response);
  if (response.ok) {
    patchOperatorTask(task.envelope.task_id, {
      state: request.successState,
      owner: request.owner,
      note: `dispatched to Deb: ${message}`,
    });
  }

  return {
    attempted: true,
    accepted: response.ok,
    endpoint: request.endpoint,
    statusCode: response.status,
    message,
  };
}

async function dispatchToAngela(task: OperatorTaskRecord): Promise<DispatchResult> {
  const request = buildAngelaPayload(task);
  const response = await fetch(request.endpoint, request.init);
  const message = await readJsonLikeMessage(response);
  if (response.ok) {
    patchOperatorTask(task.envelope.task_id, {
      state: request.successState,
      owner: request.owner,
      note: `dispatched to Angela: ${message}`,
    });
  }

  return {
    attempted: true,
    accepted: response.ok,
    endpoint: request.endpoint,
    statusCode: response.status,
    message,
  };
}

export async function dispatchOperatorTask(taskId: string): Promise<DispatchResult> {
  const task = getOperatorTask(taskId);
  if (!task) {
    throw new Error(`unknown operator task: ${taskId}`);
  }

  switch (task.envelope.execution.transport) {
    case "2tony-http":
      return await dispatchTo2Tony(task);
    case "deb-http":
      return await dispatchToDeb(task);
    case "angela-http":
      return await dispatchToAngela(task);
    default:
      return {
        attempted: false,
        reason: `transport ${task.envelope.execution.transport} is not wired for automatic dispatch`,
      };
  }
}

export async function submitOperatorTaskAndDispatch(input: unknown): Promise<{
  created: boolean;
  task: ReturnType<typeof submitOperatorTask>["task"];
  dispatch: DispatchResult;
}> {
  const submitted = submitOperatorTask(input);
  if (!submitted.created) {
    return {
      ...submitted,
      dispatch: {
        attempted: false,
        reason: "task already existed",
      },
    };
  }

  const task = submitted.task;
  if (
    task.envelope.execution.transport === "manual" ||
    task.envelope.execution.transport === "inline"
  ) {
    return {
      ...submitted,
      dispatch: {
        attempted: false,
        reason: `transport ${task.envelope.execution.transport} does not use automatic dispatch`,
      },
    };
  }

  try {
    return {
      ...submitted,
      dispatch: await dispatchOperatorTask(task.envelope.task_id),
    };
  } catch (error) {
    patchOperatorTask(task.envelope.task_id, {
      state: "blocked",
      owner: "tonya",
      failure_code: "dispatch-failed",
      note: error instanceof Error ? error.message : "automatic dispatch failed",
    });
    return {
      created: true,
      task: getOperatorTask(task.envelope.task_id) ?? task,
      dispatch: {
        attempted: true,
        accepted: false,
        endpoint:
          task.envelope.execution.transport === "deb-http"
            ? `${resolveDebBaseUrl() ?? "<unconfigured>"}/update`
            : task.envelope.execution.transport === "angela-http"
              ? `${resolveAngelaBaseUrl() ?? "<unconfigured>"}/api/message`
              : `${resolve2TonyBaseUrl() ?? "<unconfigured>"}/task`,
        statusCode: 0,
        message: error instanceof Error ? error.message : "automatic dispatch failed",
      },
    };
  }
}

export function isDispatchValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
