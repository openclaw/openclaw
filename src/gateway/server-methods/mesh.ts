import { randomUUID } from "node:crypto";
import { agentCommand } from "../../commands/agent.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMeshPlanAutoParams,
  validateMeshPlanParams,
  validateMeshRetryParams,
  validateMeshRunParams,
  validateMeshStatusParams,
  type MeshWorkflowPlan,
} from "../protocol/index.js";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";

type MeshStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
type MeshRunStatus = "pending" | "running" | "completed" | "failed";

type MeshStepRuntime = {
  id: string;
  name?: string;
  prompt: string;
  dependsOn: string[];
  agentId?: string;
  sessionKey?: string;
  thinking?: string;
  timeoutMs?: number;
  status: MeshStepStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  agentRunId?: string;
  error?: string;
};

type MeshRunRecord = {
  runId: string;
  plan: MeshWorkflowPlan;
  status: MeshRunStatus;
  startedAt: number;
  endedAt?: number;
  continueOnError: boolean;
  maxParallel: number;
  defaultStepTimeoutMs: number;
  lane?: string;
  stepOrder: string[];
  steps: Record<string, MeshStepRuntime>;
  history: Array<{ ts: number; type: string; stepId?: string; data?: Record<string, unknown> }>;
};

type MeshAutoStep = {
  id?: string;
  name?: string;
  prompt: string;
  dependsOn?: string[];
  agentId?: string;
  sessionKey?: string;
  thinking?: string;
  timeoutMs?: number;
};

type MeshAutoPlanShape = {
  steps?: MeshAutoStep[];
};

const meshRuns = new Map<string, MeshRunRecord>();
const MAX_KEEP_RUNS = 200;
const AUTO_PLAN_TIMEOUT_MS = 90_000;
const PLANNER_MAIN_KEY = "mesh-planner";

function trimMap() {
  if (meshRuns.size <= MAX_KEEP_RUNS) {
    return;
  }
  const sorted = [...meshRuns.values()].toSorted((a, b) => a.startedAt - b.startedAt);
  const overflow = meshRuns.size - MAX_KEEP_RUNS;
  for (const stale of sorted.slice(0, overflow)) {
    meshRuns.delete(stale.runId);
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeDependsOn(dependsOn: string[] | undefined): string[] {
  if (!Array.isArray(dependsOn)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of dependsOn) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizePlan(plan: MeshWorkflowPlan): MeshWorkflowPlan {
  return {
    planId: plan.planId.trim(),
    goal: plan.goal.trim(),
    createdAt: plan.createdAt,
    steps: plan.steps.map((step) => ({
      id: step.id.trim(),
      name: typeof step.name === "string" ? step.name.trim() || undefined : undefined,
      prompt: step.prompt.trim(),
      dependsOn: normalizeDependsOn(step.dependsOn),
      agentId: typeof step.agentId === "string" ? step.agentId.trim() || undefined : undefined,
      sessionKey:
        typeof step.sessionKey === "string" ? step.sessionKey.trim() || undefined : undefined,
      thinking: typeof step.thinking === "string" ? step.thinking : undefined,
      timeoutMs:
        typeof step.timeoutMs === "number" && Number.isFinite(step.timeoutMs)
          ? Math.max(1_000, Math.floor(step.timeoutMs))
          : undefined,
    })),
  };
}

function createPlanFromParams(params: { goal: string; steps?: MeshAutoStep[] }): MeshWorkflowPlan {
  const now = Date.now();
  const goal = params.goal.trim();
  const sourceSteps = params.steps?.length
    ? params.steps
    : [
        {
          id: "step-1",
          name: "Primary Task",
          prompt: goal,
        },
      ];

  const steps = sourceSteps.map((step, index) => {
    const stepId = step.id?.trim() || `step-${index + 1}`;
    return {
      id: stepId,
      name: step.name?.trim() || undefined,
      prompt: step.prompt.trim(),
      dependsOn: normalizeDependsOn(step.dependsOn),
      agentId: step.agentId?.trim() || undefined,
      sessionKey: step.sessionKey?.trim() || undefined,
      thinking: typeof step.thinking === "string" ? step.thinking : undefined,
      timeoutMs:
        typeof step.timeoutMs === "number" && Number.isFinite(step.timeoutMs)
          ? Math.max(1_000, Math.floor(step.timeoutMs))
          : undefined,
    };
  });

  return {
    planId: `mesh-plan-${randomUUID()}`,
    goal,
    createdAt: now,
    steps,
  };
}

function validatePlanGraph(
  plan: MeshWorkflowPlan,
): { ok: true; order: string[] } | { ok: false; error: string } {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      return { ok: false, error: `duplicate step id: ${step.id}` };
    }
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const depId of step.dependsOn ?? []) {
      if (!ids.has(depId)) {
        return { ok: false, error: `unknown dependency "${depId}" on step "${step.id}"` };
      }
      if (depId === step.id) {
        return { ok: false, error: `step "${step.id}" cannot depend on itself` };
      }
    }
  }

  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const step of plan.steps) {
    inDegree.set(step.id, 0);
    outgoing.set(step.id, []);
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn ?? []) {
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      const list = outgoing.get(dep);
      if (list) {
        list.push(step.id);
      }
    }
  }

  const queue = plan.steps.filter((step) => (inDegree.get(step.id) ?? 0) === 0).map((s) => s.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    order.push(current);
    const targets = outgoing.get(current) ?? [];
    for (const next of targets) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
      }
    }
  }

  if (order.length !== plan.steps.length) {
    return { ok: false, error: "workflow contains a dependency cycle" };
  }
  return { ok: true, order };
}

async function callGatewayHandler(
  handler: (opts: GatewayRequestHandlerOptions) => Promise<void> | void,
  opts: GatewayRequestHandlerOptions,
): Promise<{ ok: boolean; payload?: unknown; error?: unknown; meta?: Record<string, unknown> }> {
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (result: {
      ok: boolean;
      payload?: unknown;
      error?: unknown;
      meta?: Record<string, unknown>;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const respond: RespondFn = (ok, payload, error, meta) => {
      settle({ ok, payload, error, meta });
    };
    void Promise.resolve(
      handler({
        ...opts,
        respond,
      }),
    ).catch((err) => {
      settle({ ok: false, error: err });
    });
  });
}

function buildStepPrompt(step: MeshStepRuntime, run: MeshRunRecord): string {
  if (step.dependsOn.length === 0) {
    return step.prompt;
  }
  const lines = step.dependsOn.map((depId) => {
    const dep = run.steps[depId];
    const details = dep.agentRunId ? ` runId=${dep.agentRunId}` : "";
    return `- ${depId}: ${dep.status}${details}`;
  });
  return `${step.prompt}\n\nDependency context:\n${lines.join("\n")}`;
}

function resolveStepTimeoutMs(step: MeshStepRuntime, run: MeshRunRecord): number {
  if (typeof step.timeoutMs === "number" && Number.isFinite(step.timeoutMs)) {
    return Math.max(1_000, Math.floor(step.timeoutMs));
  }
  return run.defaultStepTimeoutMs;
}

async function executeStep(params: {
  run: MeshRunRecord;
  step: MeshStepRuntime;
  opts: GatewayRequestHandlerOptions;
}) {
  const { run, step, opts } = params;
  step.status = "running";
  step.startedAt = Date.now();
  step.endedAt = undefined;
  step.error = undefined;
  step.attempts += 1;
  run.history.push({ ts: Date.now(), type: "step.start", stepId: step.id });

  const agentRequestId = `${run.runId}:${step.id}:${step.attempts}`;
  const prompt = buildStepPrompt(step, run);
  const timeoutMs = resolveStepTimeoutMs(step, run);
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);

  const accepted = await callGatewayHandler(agentHandlers.agent, {
    ...opts,
    req: {
      type: "req",
      id: `${agentRequestId}:agent`,
      method: "agent",
      params: {},
    },
    params: {
      message: prompt,
      idempotencyKey: agentRequestId,
      ...(step.agentId ? { agentId: step.agentId } : {}),
      ...(step.sessionKey ? { sessionKey: step.sessionKey } : {}),
      ...(step.thinking ? { thinking: step.thinking } : {}),
      ...(run.lane ? { lane: run.lane } : {}),
      timeout: timeoutSeconds,
      deliver: false,
    },
  });

  if (!accepted.ok) {
    step.status = "failed";
    step.endedAt = Date.now();
    step.error = stringifyUnknown(accepted.error ?? "agent request failed");
    run.history.push({
      ts: Date.now(),
      type: "step.error",
      stepId: step.id,
      data: { error: step.error },
    });
    return;
  }

  const runId = (() => {
    const candidate = accepted.payload as { runId?: unknown } | undefined;
    return typeof candidate?.runId === "string" ? candidate.runId : undefined;
  })();
  step.agentRunId = runId;

  if (!runId) {
    step.status = "failed";
    step.endedAt = Date.now();
    step.error = "agent did not return runId";
    run.history.push({
      ts: Date.now(),
      type: "step.error",
      stepId: step.id,
      data: { error: step.error },
    });
    return;
  }

  const waited = await callGatewayHandler(agentHandlers["agent.wait"], {
    ...opts,
    req: {
      type: "req",
      id: `${agentRequestId}:wait`,
      method: "agent.wait",
      params: {},
    },
    params: {
      runId,
      timeoutMs,
    },
  });

  const waitPayload = waited.payload as { status?: unknown; error?: unknown } | undefined;
  const waitStatus = typeof waitPayload?.status === "string" ? waitPayload.status : "error";
  if (waited.ok && waitStatus === "ok") {
    step.status = "succeeded";
    step.endedAt = Date.now();
    run.history.push({ ts: Date.now(), type: "step.ok", stepId: step.id, data: { runId } });
    return;
  }

  step.status = "failed";
  step.endedAt = Date.now();
  step.error =
    typeof waitPayload?.error === "string"
      ? waitPayload.error
      : stringifyUnknown(waited.error ?? `agent.wait returned status ${waitStatus}`);
  run.history.push({
    ts: Date.now(),
    type: "step.error",
    stepId: step.id,
    data: { runId, status: waitStatus, error: step.error },
  });
}

function createRunRecord(params: {
  runId: string;
  plan: MeshWorkflowPlan;
  order: string[];
  continueOnError: boolean;
  maxParallel: number;
  defaultStepTimeoutMs: number;
  lane?: string;
}): MeshRunRecord {
  const steps: Record<string, MeshStepRuntime> = {};
  for (const step of params.plan.steps) {
    steps[step.id] = {
      id: step.id,
      name: step.name,
      prompt: step.prompt,
      dependsOn: step.dependsOn ?? [],
      agentId: step.agentId,
      sessionKey: step.sessionKey,
      thinking: step.thinking,
      timeoutMs: step.timeoutMs,
      status: "pending",
      attempts: 0,
    };
  }
  return {
    runId: params.runId,
    plan: params.plan,
    status: "pending",
    startedAt: Date.now(),
    continueOnError: params.continueOnError,
    maxParallel: params.maxParallel,
    defaultStepTimeoutMs: params.defaultStepTimeoutMs,
    lane: params.lane,
    stepOrder: params.order,
    steps,
    history: [],
  };
}

function findReadySteps(run: MeshRunRecord): MeshStepRuntime[] {
  const ready: MeshStepRuntime[] = [];
  for (const stepId of run.stepOrder) {
    const step = run.steps[stepId];
    if (!step || step.status !== "pending") {
      continue;
    }
    const deps = step.dependsOn.map((depId) => run.steps[depId]).filter(Boolean);
    if (deps.some((dep) => dep.status === "failed" || dep.status === "skipped")) {
      step.status = "skipped";
      step.endedAt = Date.now();
      step.error = "dependency failed";
      continue;
    }
    if (deps.every((dep) => dep.status === "succeeded")) {
      ready.push(step);
    }
  }
  return ready;
}

async function runWorkflow(run: MeshRunRecord, opts: GatewayRequestHandlerOptions) {
  run.status = "running";
  run.history.push({ ts: Date.now(), type: "run.start" });

  const inFlight = new Set<Promise<void>>();
  let stopScheduling = false;

  while (true) {
    const failed = Object.values(run.steps).some((step) => step.status === "failed");
    if (failed && !run.continueOnError) {
      stopScheduling = true;
    }

    if (!stopScheduling) {
      const ready = findReadySteps(run);
      for (const step of ready) {
        if (inFlight.size >= run.maxParallel) {
          break;
        }
        const task = executeStep({ run, step, opts }).finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
      }
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight);
      continue;
    }

    const pending = Object.values(run.steps).filter((step) => step.status === "pending");
    if (pending.length === 0) {
      break;
    }

    for (const step of pending) {
      step.status = "skipped";
      step.endedAt = Date.now();
      step.error = stopScheduling ? "cancelled after failure" : "unresolvable dependencies";
    }
    break;
  }

  const hasFailure = Object.values(run.steps).some((step) => step.status === "failed");
  run.status = hasFailure ? "failed" : "completed";
  run.endedAt = Date.now();
  run.history.push({
    ts: Date.now(),
    type: "run.end",
    data: { status: run.status },
  });
}

function resolveStepIdsForRetry(run: MeshRunRecord, requested?: string[]): string[] {
  if (Array.isArray(requested) && requested.length > 0) {
    return requested.map((stepId) => stepId.trim()).filter(Boolean);
  }
  return Object.values(run.steps)
    .filter((step) => step.status === "failed" || step.status === "skipped")
    .map((step) => step.id);
}

function descendantsOf(run: MeshRunRecord, roots: Set<string>): Set<string> {
  const descendants = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const step of Object.values(run.steps)) {
      if (!step.dependsOn.includes(current) || descendants.has(step.id)) {
        continue;
      }
      descendants.add(step.id);
      queue.push(step.id);
    }
  }
  return descendants;
}

function resetStepsForRetry(run: MeshRunRecord, stepIds: string[]) {
  const rootSet = new Set(stepIds);
  const descendants = descendantsOf(run, rootSet);
  const resetIds = new Set([...rootSet, ...descendants]);
  for (const stepId of resetIds) {
    const step = run.steps[stepId];
    if (!step) {
      continue;
    }
    if (step.status === "succeeded" && !rootSet.has(stepId)) {
      continue;
    }
    step.status = "pending";
    step.startedAt = undefined;
    step.endedAt = undefined;
    step.error = undefined;
    if (rootSet.has(stepId)) {
      step.agentRunId = undefined;
    }
  }
}

function summarizeRun(run: MeshRunRecord) {
  return {
    runId: run.runId,
    plan: run.plan,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    stats: {
      total: Object.keys(run.steps).length,
      succeeded: Object.values(run.steps).filter((step) => step.status === "succeeded").length,
      failed: Object.values(run.steps).filter((step) => step.status === "failed").length,
      skipped: Object.values(run.steps).filter((step) => step.status === "skipped").length,
      running: Object.values(run.steps).filter((step) => step.status === "running").length,
      pending: Object.values(run.steps).filter((step) => step.status === "pending").length,
    },
    steps: run.stepOrder.map((stepId) => run.steps[stepId]),
    history: run.history,
  };
}

function extractTextFromAgentResult(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: unknown }> } | undefined)?.payloads;
  if (!Array.isArray(payloads)) {
    return "";
  }
  const texts: string[] = [];
  for (const payload of payloads) {
    if (typeof payload?.text === "string" && payload.text.trim()) {
      texts.push(payload.text.trim());
    }
  }
  return texts.join("\n\n");
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // keep trying
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // keep trying
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function buildAutoPlannerPrompt(params: { goal: string; maxSteps: number }) {
  return [
    "You are a workflow planner. Convert the user's goal into executable workflow steps.",
    "Return STRICT JSON only, no markdown, no prose.",
    'JSON schema: {"steps": [{"id": string, "name"?: string, "prompt": string, "dependsOn"?: string[]}]}',
    "Rules:",
    `- Use 2 to ${params.maxSteps} steps.`,
    "- Keep ids short, lowercase, kebab-case.",
    "- dependsOn must reference earlier step ids when needed.",
    "- prompts must be concrete and executable by an AI coding assistant.",
    "- Do not include extra fields.",
    `Goal: ${params.goal}`,
  ].join("\n");
}

async function generateAutoPlan(params: {
  goal: string;
  maxSteps: number;
  agentId?: string;
  sessionKey?: string;
  thinking?: string;
  timeoutMs?: number;
  lane?: string;
  opts: GatewayRequestHandlerOptions;
}): Promise<{ plan: MeshWorkflowPlan; source: "llm" | "fallback"; plannerText?: string }> {
  const prompt = buildAutoPlannerPrompt({ goal: params.goal, maxSteps: params.maxSteps });
  const timeoutSeconds = Math.ceil((params.timeoutMs ?? AUTO_PLAN_TIMEOUT_MS) / 1000);
  const resolvedAgentId = normalizeAgentId(params.agentId ?? "main");
  const plannerSessionKey =
    params.sessionKey?.trim() || `agent:${resolvedAgentId}:${PLANNER_MAIN_KEY}`;

  try {
    const runResult = await agentCommand(
      {
        message: prompt,
        deliver: false,
        timeout: String(timeoutSeconds),
        agentId: resolvedAgentId,
        sessionKey: plannerSessionKey,
        ...(params.thinking ? { thinking: params.thinking } : {}),
        ...(params.lane ? { lane: params.lane } : {}),
      },
      defaultRuntime,
      params.opts.context.deps,
    );

    const text = extractTextFromAgentResult(runResult);
    const parsed = parseJsonObjectFromText(text) as MeshAutoPlanShape | null;
    const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    if (rawSteps.length > 0) {
      const plan = normalizePlan(
        createPlanFromParams({
          goal: params.goal,
          steps: rawSteps.slice(0, params.maxSteps),
        }),
      );
      return { plan, source: "llm", plannerText: text };
    }

    const fallbackPlan = normalizePlan(createPlanFromParams({ goal: params.goal }));
    return { plan: fallbackPlan, source: "fallback", plannerText: text };
  } catch {
    const fallbackPlan = normalizePlan(createPlanFromParams({ goal: params.goal }));
    return { plan: fallbackPlan, source: "fallback" };
  }
}

export const meshHandlers: GatewayRequestHandlers = {
  "mesh.plan": ({ params, respond }) => {
    if (!validateMeshPlanParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mesh.plan params: ${formatValidationErrors(validateMeshPlanParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const plan = normalizePlan(
      createPlanFromParams({
        goal: p.goal,
        steps: p.steps,
      }),
    );
    const graph = validatePlanGraph(plan);
    if (!graph.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, graph.error));
      return;
    }
    respond(
      true,
      {
        plan,
        order: graph.order,
      },
      undefined,
    );
  },
  "mesh.plan.auto": async ({ params, respond, ...rest }) => {
    if (!validateMeshPlanAutoParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mesh.plan.auto params: ${formatValidationErrors(validateMeshPlanAutoParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const maxSteps =
      typeof p.maxSteps === "number" && Number.isFinite(p.maxSteps)
        ? Math.max(1, Math.min(16, Math.floor(p.maxSteps)))
        : 6;
    const auto = await generateAutoPlan({
      goal: p.goal,
      maxSteps,
      agentId: p.agentId,
      sessionKey: p.sessionKey,
      thinking: p.thinking,
      timeoutMs: p.timeoutMs,
      lane: p.lane,
      opts: {
        ...rest,
        params,
        respond,
      },
    });

    const graph = validatePlanGraph(auto.plan);
    if (!graph.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, graph.error));
      return;
    }

    respond(
      true,
      {
        plan: auto.plan,
        order: graph.order,
        source: auto.source,
        plannerText: auto.plannerText,
      },
      undefined,
    );
  },
  "mesh.run": async (opts) => {
    const { params, respond } = opts;
    if (!validateMeshRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mesh.run params: ${formatValidationErrors(validateMeshRunParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const plan = normalizePlan(p.plan);
    const graph = validatePlanGraph(plan);
    if (!graph.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, graph.error));
      return;
    }

    const maxParallel =
      typeof p.maxParallel === "number" && Number.isFinite(p.maxParallel)
        ? Math.min(16, Math.max(1, Math.floor(p.maxParallel)))
        : 2;
    const defaultStepTimeoutMs =
      typeof p.defaultStepTimeoutMs === "number" && Number.isFinite(p.defaultStepTimeoutMs)
        ? Math.max(1_000, Math.floor(p.defaultStepTimeoutMs))
        : 120_000;
    const runId = `mesh-run-${randomUUID()}`;
    const record = createRunRecord({
      runId,
      plan,
      order: graph.order,
      continueOnError: p.continueOnError === true,
      maxParallel,
      defaultStepTimeoutMs,
      lane: typeof p.lane === "string" ? p.lane : undefined,
    });
    meshRuns.set(runId, record);
    trimMap();

    await runWorkflow(record, opts);
    respond(true, summarizeRun(record), undefined);
  },
  "mesh.status": ({ params, respond }) => {
    if (!validateMeshStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mesh.status params: ${formatValidationErrors(validateMeshStatusParams.errors)}`,
        ),
      );
      return;
    }
    const run = meshRuns.get(params.runId.trim());
    if (!run) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "mesh run not found"));
      return;
    }
    respond(true, summarizeRun(run), undefined);
  },
  "mesh.retry": async (opts) => {
    const { params, respond } = opts;
    if (!validateMeshRetryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mesh.retry params: ${formatValidationErrors(validateMeshRetryParams.errors)}`,
        ),
      );
      return;
    }
    const runId = params.runId.trim();
    const run = meshRuns.get(runId);
    if (!run) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "mesh run not found"));
      return;
    }
    if (run.status === "running") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "mesh run is currently running"),
      );
      return;
    }
    const stepIds = resolveStepIdsForRetry(run, params.stepIds);
    if (stepIds.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "no failed or skipped steps available to retry"),
      );
      return;
    }
    for (const stepId of stepIds) {
      if (!run.steps[stepId]) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown retry step id: ${stepId}`),
        );
        return;
      }
    }

    resetStepsForRetry(run, stepIds);
    run.status = "pending";
    run.endedAt = undefined;
    run.history.push({
      ts: Date.now(),
      type: "run.retry",
      data: { stepIds },
    });
    await runWorkflow(run, opts);
    respond(true, summarizeRun(run), undefined);
  },
};

export function __resetMeshRunsForTest() {
  meshRuns.clear();
}
