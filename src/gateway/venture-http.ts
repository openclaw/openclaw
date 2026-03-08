import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluatePolicy } from "../../extensions/decision-engine/src/policy-engine.js";
import { funnelBuilderModule } from "../../extensions/funnel-builder/src/module.js";
import { marketIntelligenceModule } from "../../extensions/market-intelligence/src/module.js";
import type { VentureModule } from "../../extensions/venture-core/src/module-contract.js";
import { createVentureRunContext, NOOP_VENTURE_LOGGER } from "../../extensions/venture-core/src/run-context.js";
import type { VenturePriority } from "../../extensions/venture-core/src/types.js";
import { InMemoryIdempotencyStore } from "../../extensions/workflow-engine/src/idempotency.js";
import type { WorkflowJobPayload, WorkflowJobRecord } from "../../extensions/workflow-engine/src/job-types.js";
import { InMemoryWorkflowQueue } from "../../extensions/workflow-engine/src/queue.js";
import { WorkflowWorker } from "../../extensions/workflow-engine/src/worker.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

type VentureHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type VentureJobCreateRequest = {
  moduleId?: unknown;
  input?: unknown;
  priority?: unknown;
  dedupeKey?: unknown;
  risk?: unknown;
  toolName?: unknown;
  budgetUsage?: unknown;
};

const ventureQueue = new InMemoryWorkflowQueue();
const ventureIdempotency = new InMemoryIdempotencyStore();

let workerStarted = false;

async function runKnownModule(job: WorkflowJobRecord): Promise<{
  ok: boolean;
  summary: string;
  output: unknown;
}> {
  const moduleMap: Record<string, VentureModule> = {
    "market-intelligence": marketIntelligenceModule,
    "funnel-builder": funnelBuilderModule,
  };
  const selected = moduleMap[job.payload.moduleId];
  if (!selected) {
    return {
      ok: true,
      summary: `module ${job.payload.moduleId} accepted (no contract handler yet)`,
      output: { passthrough: true, moduleId: job.payload.moduleId },
    };
  }

  const ctx = createVentureRunContext({
    metadata: {
      runId: job.id,
      moduleId: job.payload.moduleId,
      requestedAt: new Date(job.createdAt).toISOString(),
      priority: job.priority,
      tags: job.payload.tags,
    },
    logger: NOOP_VENTURE_LOGGER,
  });

  const input =
    job.payload.input && typeof job.payload.input === "object"
      ? (job.payload.input as Record<string, unknown>)
      : {};
  const moduleInput = (input.input ?? input) as unknown;
  const plan = await selected.plan(moduleInput, ctx);
  const output = await selected.execute(plan, ctx);
  const validation = await selected.validate(output, ctx);
  const report = await selected.report(output, validation, ctx);

  return {
    ok: report.ok,
    summary: report.summary,
    output: {
      validation,
      report,
    },
  };
}

function ensureWorkerStarted(): void {
  if (workerStarted) {
    return;
  }
  const worker = new WorkflowWorker({
    workerId: "venture-worker-default",
    queue: ventureQueue,
    pollIntervalMs: 250,
    leaseMs: 30_000,
    handler: {
      run: async (job) => {
        const body = asCreateRequest(job.payload.input);
        const toolName = typeof body.toolName === "string" ? body.toolName : "none";
        const risk = normalizeRisk(body.risk);
        const budgetUsage = normalizeBudgetUsage(body.budgetUsage);
        const decision = evaluatePolicy(
          {
            tools: { mode: "denylist", entries: [] },
            approvals: {
              requireApprovalAtOrAbove: "high",
              sideEffectTools: ["browser", "exec", "system.run", "deploy"],
            },
            budget: {
              maxUsd: 100,
              maxTokens: 500_000,
              maxRuntimeMs: 10 * 60_000,
            },
          },
          { toolName, risk, budgetUsage },
        );
        if (!decision.allowed) {
          return {
            ok: true,
            summary: "policy blocked execution; approval required or guard violated",
            output: { policy: decision },
          };
        }
        return runKnownModule(job);
      },
    },
  });
  worker.start();
  workerStarted = true;
}

function asCreateRequest(value: unknown): VentureJobCreateRequest {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as VentureJobCreateRequest;
}

function normalizePriority(value: unknown): VenturePriority {
  if (value === "low" || value === "normal" || value === "high" || value === "critical") {
    return value;
  }
  return "normal";
}

function normalizeRisk(value: unknown): "low" | "medium" | "high" | "critical" {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
}

function normalizeBudgetUsage(value: unknown):
  | { usd?: number; tokens?: number; runtimeMs?: number }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const toNum = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    usd: toNum(obj.usd),
    tokens: toNum(obj.tokens),
    runtimeMs: toNum(obj.runtimeMs),
  };
}

function toResponseRecord(job: WorkflowJobRecord) {
  return {
    id: job.id,
    status: job.status,
    moduleId: job.payload.moduleId,
    priority: job.priority,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastError: job.lastError,
  };
}

export async function handleVentureHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: VentureHttpOptions,
): Promise<boolean> {
  ensureWorkerStarted();

  const createHandled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/venture/jobs",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: 512 * 1024,
  });
  if (createHandled === false) {
    // continue to next endpoint branch
  } else if (!createHandled) {
    return true;
  } else {
    const body = asCreateRequest(createHandled.body);
    const moduleId = typeof body.moduleId === "string" ? body.moduleId.trim() : "";
    if (!moduleId) {
      sendJson(res, 400, { ok: false, error: "moduleId is required" });
      return true;
    }

    const priority = normalizePriority(body.priority);
    const dedupeKey = typeof body.dedupeKey === "string" ? body.dedupeKey.trim() : undefined;
    if (dedupeKey) {
      const existing = ventureIdempotency.get(dedupeKey);
      if (existing) {
        const job = await ventureQueue.get(existing.jobId);
        if (job) {
          sendJson(res, 200, { ok: true, deduped: true, job: toResponseRecord(job) });
          return true;
        }
      }
    }

    const jobId = `venture_${randomUUID()}`;
    if (dedupeKey) {
      ventureIdempotency.reserve({ key: dedupeKey, jobId, ttlMs: 24 * 60 * 60_000 });
    }
    const payload: WorkflowJobPayload = {
      moduleId,
      input: createHandled.body,
      tags: typeof body.input === "object" && body.input ? { source: "http" } : undefined,
    };
    const job = await ventureQueue.enqueue({
      id: jobId,
      payload,
      priority,
      dedupeKey,
    });
    sendJson(res, 202, { ok: true, job: toResponseRecord(job) });
    return true;
  }

  const statusHandled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/venture/jobs/status",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: 64 * 1024,
  });
  if (statusHandled === false) {
    return false;
  }
  if (!statusHandled) {
    return true;
  }

  const statusBody =
    statusHandled.body && typeof statusHandled.body === "object"
      ? (statusHandled.body as Record<string, unknown>)
      : {};
  const jobId = typeof statusBody.jobId === "string" ? statusBody.jobId.trim() : "";
  if (!jobId) {
    sendJson(res, 400, { ok: false, error: "jobId is required" });
    return true;
  }
  const job = await ventureQueue.get(jobId);
  if (!job) {
    sendJson(res, 404, { ok: false, error: "job not found" });
    return true;
  }
  sendJson(res, 200, { ok: true, job: toResponseRecord(job) });
  return true;
}
