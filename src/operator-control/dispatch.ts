import { ZodError } from "zod";
import { resolveOperatorDelegatedDefaultAlias } from "./agent-registry.js";
import {
  CANONICAL_DELEGATED_EXECUTION_TRANSPORT,
  LEGACY_DELEGATED_EXECUTION_TRANSPORT,
  canonicalizeOperatorExecutionTransport,
  type OperatorBlockerCode,
} from "./contracts.js";
import { resolveProjectOpsCommandTarget, type ProjectOpsTargetMode } from "./project-ops-target.js";
import { resolveOperatorRuntimeFreshness } from "./runtime-freshness.js";
import { getOperatorTask, patchOperatorTask, submitOperatorTask } from "./task-store.js";
import type { OperatorTaskRecord } from "./task-store.js";
import { getResolvedOperatorTaskTeam } from "./team-routing.js";
import {
  assertOperatorTransportCircuitClosed,
  OperatorTransportCircuitOpenError,
  recordOperatorTransportDispatchFailure,
  recordOperatorTransportDispatchSuccess,
  type OperatorTransportCircuitName,
} from "./transport-circuit-breaker.js";
import { getOperatorWorkerReady, isOperatorWorkerClientError } from "./worker-client.js";
import {
  coerceOperatorRuntimeIdentity,
  resolveOperatorIdentityFreshness,
  resolveOperatorWorkerFreshness,
} from "./worker-freshness.js";
import {
  resolve2TonyBaseUrl,
  resolve2TonySharedSecret,
  resolveOperatorReceiptTemplate,
} from "./worker-status.js";

type TeamDispatchConfig = {
  baseUrl: string | null;
  authToken: string | null;
};

type DelegateReadinessPolicy = {
  label: string;
  maxAgeEnv: string;
  approvedRefsEnv: string;
  requireIdentityEnv: string;
};

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

class DispatchBlockError extends Error {
  readonly code: OperatorBlockerCode;

  constructor(code: OperatorBlockerCode, message: string) {
    super(message);
    this.name = "DispatchBlockError";
    this.code = code;
  }
}

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

async function readJsonLikeResponse(response: Response): Promise<{
  payload: unknown;
  message: string;
}> {
  const text = await response.text();
  if (!text.trim()) {
    return {
      payload: null,
      message: `${response.status} ${response.statusText}`,
    };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      if ("message" in parsed && typeof parsed.message === "string" && parsed.message.trim()) {
        return { payload: parsed, message: parsed.message.trim() };
      }
      if ("status" in parsed && typeof parsed.status === "string" && parsed.status.trim()) {
        return { payload: parsed, message: parsed.status.trim() };
      }
      if ("output" in parsed && typeof parsed.output === "string" && parsed.output.trim()) {
        return { payload: parsed, message: parsed.output.trim() };
      }
    }
    return {
      payload: parsed,
      message: `${response.status} ${response.statusText}`,
    };
  } catch {
    return {
      payload: text.trim(),
      message: text.trim() || `${response.status} ${response.statusText}`,
    };
  }
}

function normalizeIdentifier(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function readEnvValue(name: string | null | undefined): string | null {
  if (!name?.trim()) {
    return null;
  }
  const value = process.env[name]?.trim();
  return value || null;
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

function readStringArrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value
      .map((entry) => (typeof entry === "string" && entry.trim() ? entry.trim() : null))
      .filter((entry): entry is string => Boolean(entry));
    if (items.length > 0) {
      return items;
    }
  }
  return [];
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

function resolveExplicit2TonyTaskTypeOverride(inputs: Record<string, unknown>): string | null {
  return readStringField(
    inputs,
    "worker_task_type",
    "workerTaskType",
    "2tony_task_type",
    "two_tony_task_type",
  );
}

function resolveOperatorIntentType(inputs: Record<string, unknown>): string | null {
  return readStringField(inputs, "task_type", "taskType", "type");
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

function buildTaskDecomposition(task: OperatorTaskRecord, workerTaskType: string) {
  const inputs = asRecord(task.envelope.inputs) ?? {};
  const fileRefs = task.envelope.context_refs
    .filter((ref) => ref.kind === "file")
    .map((ref) => ref.value);
  const memoryRefs = task.envelope.context_refs
    .filter((ref) => ref.kind === "memory" || ref.kind === "session")
    .map((ref) => ref.value);
  const scopeHints = Array.from(
    new Set([
      ...fileRefs,
      ...readStringArrayField(inputs, "files", "paths"),
      ...readStringArrayField(inputs, "tests"),
    ]),
  );
  return {
    operatorIntent: resolveOperatorIntentType(inputs) ?? task.envelope.target.capability,
    workerTaskType,
    target: {
      capability: task.envelope.target.capability,
      teamId: task.envelope.target.team_id ?? null,
      alias: task.envelope.target.alias ?? null,
      transport: task.envelope.execution.transport,
    },
    scope: {
      files: fileRefs,
      memoryRefs,
      hints: scopeHints,
    },
    validationChecklist: task.envelope.acceptance_criteria,
  };
}

type SupportedDispatchTransport =
  | "2tony-http"
  | "deb-http"
  | typeof CANONICAL_DELEGATED_EXECUTION_TRANSPORT
  | typeof LEGACY_DELEGATED_EXECUTION_TRANSPORT;

const SUPPORTED_RUNTIME_BY_TRANSPORT: Record<
  SupportedDispatchTransport,
  ReadonlySet<"acpx" | "subagent" | "inline">
> = {
  "2tony-http": new Set(["acpx"]),
  "deb-http": new Set(["acpx"]),
  "delegated-http": new Set(["acpx", "subagent"]),
  "angela-http": new Set(["acpx", "subagent"]),
};

function resolveCircuitTransport(task: OperatorTaskRecord): OperatorTransportCircuitName | null {
  const transport = canonicalizeOperatorExecutionTransport(task.envelope.execution.transport);
  if (transport === "2tony-http" || transport === "deb-http" || transport === "delegated-http") {
    return transport;
  }
  return null;
}

function shouldRecordCircuitFailure(error: unknown): boolean {
  if (error instanceof OperatorTransportCircuitOpenError) {
    return false;
  }
  if (!(error instanceof DispatchBlockError)) {
    return true;
  }
  return (
    error.code === "delegate_unavailable" ||
    error.code === "dispatch_failed" ||
    error.code === "stale_runtime"
  );
}

function resolve2TonyTaskType(task: OperatorTaskRecord): string {
  const inputs = asRecord(task.envelope.inputs) ?? {};
  const explicitType = resolveExplicit2TonyTaskTypeOverride(inputs);
  if (explicitType) {
    const normalizedExplicitType = normalizeIdentifier(explicitType);
    if (!SUPPORTED_2TONY_TASK_TYPES.has(normalizedExplicitType)) {
      throw new DispatchBlockError(
        "unmapped_task_type",
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

  throw new DispatchBlockError(
    "unmapped_task_type",
    `2Tony task type could not be inferred for capability "${task.envelope.target.capability}". Set inputs.worker_task_type to one of ${Array.from(SUPPORTED_2TONY_TASK_TYPES).join(", ")} or provide compatible inputs (source/code, tests, manifest/yaml, schema, template, files/dependencies, git status fields).`,
  );
}

function build2TonyPayload(task: OperatorTaskRecord) {
  const team = getResolvedOperatorTaskTeam(task.envelope);
  const taskType = resolve2TonyTaskType(task);
  const rawInputs = asRecord(task.envelope.inputs) ?? {};
  const decomposition = buildTaskDecomposition(task, taskType);
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
      dispatchPlan: decomposition,
    },
    metadata: {
      operatorTaskId: task.envelope.task_id,
      operatorRunId: task.receipt.run_id,
      requesterId: task.envelope.requester.id,
      capability: task.envelope.target.capability,
      requestedTaskType: resolveOperatorIntentType(rawInputs) ?? task.envelope.target.capability,
      workerTaskType: taskType,
      teamId: task.envelope.target.team_id ?? null,
      teamLead: team?.lead ?? null,
      alias: task.envelope.target.alias ?? null,
      tier: task.envelope.tier,
      decomposition,
    },
  };
}

function resolveDelegatedTransportBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL ?? process.env.OPENCLAW_OPERATOR_ANGELA_URL,
  );
}

function resolveDelegatedTransportSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

function resolveTeamDispatchConfig(
  team: ReturnType<typeof getResolvedOperatorTaskTeam>,
  fallback: {
    baseUrl: () => string | null;
    authToken: () => string | null;
  },
): TeamDispatchConfig {
  return {
    baseUrl: normalizeBaseUrl(
      readEnvValue(team?.dispatchEndpointEnv) ?? fallback.baseUrl() ?? undefined,
    ),
    authToken: readEnvValue(team?.dispatchAuthEnv) ?? fallback.authToken(),
  };
}

function joinEndpoint(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

function isAcceptedDebResponse(
  command: "status" | "sync" | "task" | "update",
  payload: unknown,
): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }
  if (record.ok !== true) {
    return false;
  }
  if (command !== "task") {
    return true;
  }
  return readStringField(record, "status") === "accepted";
}

function isAcceptedDelegatedTransportResponse(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }
  return record.ok === true || readStringField(record, "status") === "accepted";
}

function isReadyResponse(payload: unknown): boolean {
  const record = asRecord(payload);
  return record?.ready === true;
}

function readAuthorizationHeader(headers: RequestInit["headers"]): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get("authorization");
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === "authorization");
    return match?.[1] ?? null;
  }
  const authorization = headers.authorization ?? headers.Authorization;
  return typeof authorization === "string" && authorization.trim() ? authorization.trim() : null;
}

function resolveExplicitDebCommand(inputs: Record<string, unknown>): string | null {
  const command = readStringField(inputs, "deb_command", "debCommand");
  return command ? command.toLowerCase() : null;
}

function shouldDispatchPawAndOrderTask(
  task: OperatorTaskRecord,
  team: ReturnType<typeof getResolvedOperatorTaskTeam>,
  inputs: Record<string, unknown>,
): boolean {
  if (
    readStringField(
      inputs,
      "specialist_role",
      "specialistRole",
      "dog_role",
      "dogRole",
      "artifact_type",
      "artifactType",
    )
  ) {
    return true;
  }
  if (readStringField(inputs, "delivery_mode", "deliveryMode", "channel_target", "channelTarget")) {
    return true;
  }
  if (team?.id !== "project-ops") {
    return false;
  }
  const alias = task.envelope.target.alias?.trim().toLowerCase();
  const lead = team.lead?.trim().toLowerCase();
  return Boolean(alias && alias !== lead);
}

function buildDebPayload(task: OperatorTaskRecord): {
  baseUrl: string;
  endpoint: string;
  readyEndpoint: string;
  init: RequestInit;
  owner: string;
  successState: "completed" | "queued";
  command: "status" | "sync" | "task" | "update";
  targetMode: ProjectOpsTargetMode;
} {
  const inputs = asRecord(task.envelope.inputs) ?? {};
  const team = getResolvedOperatorTaskTeam(task.envelope);
  const command =
    resolveExplicitDebCommand(inputs) ??
    (shouldDispatchPawAndOrderTask(task, team, inputs) ? "task" : "update");
  const projectOpsTarget = resolveProjectOpsCommandTarget(command);
  if (!projectOpsTarget) {
    throw new Error("project-ops transport not configured");
  }
  const baseUrl = projectOpsTarget.baseUrl;

  if (command === "status" || command === "sync") {
    return {
      baseUrl,
      endpoint: projectOpsTarget.endpoint,
      readyEndpoint: projectOpsTarget.readyEndpoint,
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(projectOpsTarget.authToken
            ? {
                authorization: `Bearer ${projectOpsTarget.authToken}`,
              }
            : {}),
        },
      },
      owner: "deb",
      successState: "completed",
      command,
      targetMode: projectOpsTarget.mode,
    };
  }

  if (command === "task") {
    const specialistRole =
      task.envelope.target.alias?.trim() ||
      readStringField(inputs, "specialist_role", "specialistRole", "dog_role", "dogRole", "role") ||
      "deb";

    return {
      baseUrl,
      endpoint: projectOpsTarget.endpoint,
      readyEndpoint: projectOpsTarget.readyEndpoint,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(projectOpsTarget.authToken
            ? {
                authorization: `Bearer ${projectOpsTarget.authToken}`,
              }
            : {}),
        },
        body: JSON.stringify({
          schema: "PawAndOrderTaskV1",
          task_id: task.envelope.task_id,
          run_id: task.receipt.run_id,
          objective: task.envelope.objective,
          capability: task.envelope.target.capability,
          team_id: task.envelope.target.team_id ?? null,
          team_lead: team?.lead ?? null,
          alias: task.envelope.target.alias ?? null,
          specialist_role: specialistRole,
          dog_role: specialistRole,
          artifact_type: readStringField(inputs, "artifact_type", "artifactType"),
          channel_target: readStringField(inputs, "channel_target", "channelTarget"),
          delivery_mode: readStringField(inputs, "delivery_mode", "deliveryMode"),
          requester: task.envelope.requester,
          acceptance_criteria: task.envelope.acceptance_criteria,
          context_refs: task.envelope.context_refs,
          reply_to: task.envelope.reply_to ?? null,
          inputs,
        }),
      },
      owner: "deb",
      successState: "queued",
      command,
      targetMode: projectOpsTarget.mode,
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
    baseUrl,
    endpoint: projectOpsTarget.endpoint,
    readyEndpoint: projectOpsTarget.readyEndpoint,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(projectOpsTarget.authToken
          ? {
              authorization: `Bearer ${projectOpsTarget.authToken}`,
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
    command: "update",
    targetMode: projectOpsTarget.mode,
  };
}

function buildDelegatedTransportPayload(task: OperatorTaskRecord): {
  baseUrl: string;
  endpoint: string;
  init: RequestInit;
  owner: string;
  delegateName: string;
  successState: "queued";
} {
  const team = getResolvedOperatorTaskTeam(task.envelope);
  const dispatchConfig = resolveTeamDispatchConfig(team, {
    baseUrl: resolveDelegatedTransportBaseUrl,
    authToken: resolveDelegatedTransportSharedSecret,
  });
  const baseUrl = dispatchConfig.baseUrl;
  if (!baseUrl) {
    throw new Error("Delegated transport base URL not configured");
  }
  const owner = resolveOperatorDelegatedDefaultAlias({
    explicitAlias: task.envelope.target.alias ?? null,
    teamId: task.envelope.target.team_id ?? null,
  });
  if (!owner) {
    throw new Error("delegated first-class-agent target alias not configured");
  }
  const delegateName = `${owner} via delegated first-class-agent boundary`;

  return {
    baseUrl,
    endpoint: joinEndpoint(baseUrl, team?.dispatchPath ?? "/api/message"),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(dispatchConfig.authToken
          ? {
              authorization: `Bearer ${dispatchConfig.authToken}`,
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
        alias: owner,
        requester: task.envelope.requester,
        acceptance_criteria: task.envelope.acceptance_criteria,
        context_refs: task.envelope.context_refs,
        inputs: task.envelope.inputs,
        reply_to: task.envelope.reply_to ?? null,
        execution: task.envelope.execution,
      }),
    },
    owner,
    delegateName,
    successState: "queued",
  };
}

async function assertHttpDelegateReady(
  delegateName: string,
  readyEndpoint: string,
  authorizationHeader: string | null,
  policy: DelegateReadinessPolicy,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(readyEndpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(authorizationHeader
          ? {
              authorization: authorizationHeader,
            }
          : {}),
      },
    });
  } catch (error) {
    throw new DispatchBlockError(
      "delegate_unavailable",
      `${delegateName} readiness failed: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }

  const { payload, message } = await readJsonLikeResponse(response);
  if (!response.ok) {
    throw new DispatchBlockError("delegate_unavailable", `${delegateName} not ready (${message})`);
  }

  if (!isReadyResponse(payload)) {
    throw new DispatchBlockError(
      "delegate_unavailable",
      `${delegateName} readiness contract invalid`,
    );
  }

  const freshness = resolveOperatorIdentityFreshness({
    identity: coerceOperatorRuntimeIdentity(asRecord(payload)?.identity),
    label: policy.label,
    maxAgeEnv: policy.maxAgeEnv,
    approvedRefsEnv: policy.approvedRefsEnv,
    requireIdentityEnv: policy.requireIdentityEnv,
  });
  if (!freshness.ready) {
    throw new DispatchBlockError(
      "stale_runtime",
      `${delegateName} runtime not ready for dispatch: ${freshness.reasons.join("; ")}`,
    );
  }
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

  try {
    const readiness = await getOperatorWorkerReady();
    if (readiness.status !== "ok") {
      throw new DispatchBlockError(
        "delegate_unavailable",
        `2Tony not ready (pending=${readiness.pending}, active=${readiness.active}, shuttingDown=${String(readiness.shuttingDown)})`,
      );
    }
    const workerFreshness = resolveOperatorWorkerFreshness({
      ready: readiness,
    });
    if (!workerFreshness.ready) {
      throw new DispatchBlockError(
        "stale_runtime",
        `2Tony runtime not ready for dispatch: ${workerFreshness.reasons.join("; ")}`,
      );
    }
  } catch (error) {
    if (error instanceof DispatchBlockError) {
      throw error;
    }
    if (isOperatorWorkerClientError(error)) {
      throw new DispatchBlockError(
        "delegate_unavailable",
        `2Tony readiness failed: ${error.message}`,
      );
    }
    throw error;
  }

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
  const { message } = await readJsonLikeResponse(response);

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

function blockOperatorTask(
  task: OperatorTaskRecord,
  code: OperatorBlockerCode,
  message: string,
  owner = "tonya",
) {
  const now = Date.now();
  return patchOperatorTask(task.envelope.task_id, {
    state: "blocked",
    owner,
    failure_code: code,
    note: message,
    outcome: {
      schema: "OutcomeRecordV1",
      task_id: task.envelope.task_id,
      run_id: task.receipt.run_id,
      outcome: "blocked",
      verification_status: code === "verification_missing" ? "failed" : "pending",
      rework_needed: true,
      rework_reason: message,
      context_gap_detected: code === "missing_input" || code === "unmapped_task_type",
      infrastructure_failure: code === "delegate_unavailable" || code === "stale_runtime",
      recorded_at: now,
    },
  });
}

async function dispatchToDeb(task: OperatorTaskRecord): Promise<DispatchResult> {
  const request = buildDebPayload(task);
  await assertHttpDelegateReady(
    request.targetMode === "control-plane-proxy" ? "Tonya project-ops control plane" : "Deb",
    request.readyEndpoint,
    readAuthorizationHeader(request.init.headers),
    {
      label: "Deb",
      maxAgeEnv: "OPENCLAW_OPERATOR_DEB_MAX_AGE_HOURS",
      approvedRefsEnv: "OPENCLAW_OPERATOR_DEB_APPROVED_REFS",
      requireIdentityEnv: "OPENCLAW_OPERATOR_REQUIRE_DEB_IDENTITY",
    },
  );
  const response = await fetch(request.endpoint, request.init);
  const { payload, message } = await readJsonLikeResponse(response);
  if (response.ok && isAcceptedDebResponse(request.command, payload)) {
    patchOperatorTask(task.envelope.task_id, {
      state: request.successState,
      owner: request.owner,
      note: `dispatched to Deb: ${message}`,
    });
  } else if (response.ok) {
    throw new DispatchBlockError(
      "dispatch_failed",
      `Deb response did not satisfy the ${request.command} contract`,
    );
  }

  return {
    attempted: true,
    accepted: response.ok,
    endpoint: request.endpoint,
    statusCode: response.status,
    message,
  };
}

async function dispatchToDelegatedTransport(task: OperatorTaskRecord): Promise<DispatchResult> {
  const request = buildDelegatedTransportPayload(task);
  await assertHttpDelegateReady(
    request.delegateName,
    joinEndpoint(request.baseUrl, "/ready"),
    readAuthorizationHeader(request.init.headers),
    {
      label: "Delegated first-class-agent boundary",
      maxAgeEnv: "OPENCLAW_OPERATOR_INTERNAL_CONTROL_MAX_AGE_HOURS",
      approvedRefsEnv: "OPENCLAW_OPERATOR_INTERNAL_CONTROL_APPROVED_REFS",
      requireIdentityEnv: "OPENCLAW_OPERATOR_REQUIRE_INTERNAL_CONTROL_IDENTITY",
    },
  );
  const response = await fetch(request.endpoint, request.init);
  const { payload, message } = await readJsonLikeResponse(response);
  if (response.ok && isAcceptedDelegatedTransportResponse(payload)) {
    patchOperatorTask(task.envelope.task_id, {
      state: request.successState,
      owner: request.owner,
      note: `dispatched to ${request.delegateName}: ${message}`,
    });
  } else if (response.ok) {
    throw new DispatchBlockError(
      "dispatch_failed",
      "delegated transport response did not satisfy the acceptance contract",
    );
  }

  return {
    attempted: true,
    accepted: response.ok,
    endpoint: request.endpoint,
    statusCode: response.status,
    message,
  };
}

function resolveDispatchFailureEndpoint(task: OperatorTaskRecord): string {
  switch (task.envelope.execution.transport) {
    case "deb-http":
      try {
        return buildDebPayload(task).endpoint;
      } catch {
        return resolveProjectOpsCommandTarget("update")?.endpoint ?? "<unconfigured>";
      }
    case "delegated-http":
    case "angela-http":
      try {
        return buildDelegatedTransportPayload(task).endpoint;
      } catch {
        return `${resolveDelegatedTransportBaseUrl() ?? "<unconfigured>"}/api/message`;
      }
    default:
      return `${resolve2TonyBaseUrl() ?? "<unconfigured>"}/task`;
  }
}

function assertSupportedTransportRuntime(task: OperatorTaskRecord): void {
  const transport = task.envelope.execution.transport;
  if (transport === "manual" || transport === "inline" || transport === "sessions_send") {
    return;
  }
  const runtime = task.envelope.execution.runtime;
  const supported = SUPPORTED_RUNTIME_BY_TRANSPORT[transport];
  if (supported.has(runtime)) {
    return;
  }
  throw new DispatchBlockError(
    "dispatch_failed",
    `transport ${transport} does not support runtime ${runtime}`,
  );
}

export async function dispatchOperatorTask(taskId: string): Promise<DispatchResult> {
  const task = getOperatorTask(taskId);
  if (!task) {
    throw new Error(`unknown operator task: ${taskId}`);
  }

  const runtimeFreshness = resolveOperatorRuntimeFreshness({
    moduleUrl: import.meta.url,
  });
  if (!runtimeFreshness.ready) {
    throw new DispatchBlockError(
      "stale_runtime",
      `operator runtime not ready for dispatch: ${runtimeFreshness.reasons.join("; ")}`,
    );
  }

  assertSupportedTransportRuntime(task);
  const circuitTransport = resolveCircuitTransport(task);
  if (circuitTransport) {
    assertOperatorTransportCircuitClosed(circuitTransport);
  }

  try {
    let result: DispatchResult;
    switch (task.envelope.execution.transport) {
      case "2tony-http":
        result = await dispatchTo2Tony(task);
        break;
      case "deb-http":
        result = await dispatchToDeb(task);
        break;
      case "delegated-http":
      case "angela-http":
        result = await dispatchToDelegatedTransport(task);
        break;
      default:
        result = {
          attempted: false,
          reason: `transport ${task.envelope.execution.transport} is not wired for automatic dispatch`,
        };
    }
    if (circuitTransport) {
      if (result.attempted && result.accepted) {
        recordOperatorTransportDispatchSuccess(circuitTransport);
      } else if (result.attempted) {
        recordOperatorTransportDispatchFailure(circuitTransport);
      }
    }
    return result;
  } catch (error) {
    if (circuitTransport && shouldRecordCircuitFailure(error)) {
      recordOperatorTransportDispatchFailure(circuitTransport);
    }
    throw error;
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
      created: false,
      task: getOperatorTask(submitted.task.envelope.task_id) ?? submitted.task,
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
      created: true,
      task: getOperatorTask(task.envelope.task_id) ?? task,
      dispatch: {
        attempted: false,
        reason: `transport ${task.envelope.execution.transport} does not use automatic dispatch`,
      },
    };
  }

  try {
    const dispatch = await dispatchOperatorTask(task.envelope.task_id);
    if (!dispatch.attempted) {
      blockOperatorTask(task, "delegate_unavailable", dispatch.reason);
    }
    return {
      created: true,
      task: getOperatorTask(task.envelope.task_id) ?? task,
      dispatch,
    };
  } catch (error) {
    const code =
      error instanceof DispatchBlockError
        ? error.code
        : error instanceof OperatorTransportCircuitOpenError
          ? ("delegate_unavailable" satisfies OperatorBlockerCode)
          : ("dispatch_failed" satisfies OperatorBlockerCode);
    blockOperatorTask(
      task,
      code,
      error instanceof Error ? error.message : "automatic dispatch failed",
    );
    return {
      created: true,
      task: getOperatorTask(task.envelope.task_id) ?? task,
      dispatch: {
        attempted: true,
        accepted: false,
        endpoint: resolveDispatchFailureEndpoint(task),
        statusCode: 0,
        message: error instanceof Error ? error.message : "automatic dispatch failed",
      },
    };
  }
}

export function isDispatchValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
