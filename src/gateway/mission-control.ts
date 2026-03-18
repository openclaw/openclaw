import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import { compileOperatorAgentRegistry } from "../operator-control/agent-registry.js";
import {
  DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION,
  DELEGATED_LEAD_TASK_ENVELOPE_SCHEMA_VERSION,
  operatorContextRefSchema,
  operatorReplyTargetSchema,
} from "../operator-control/contracts.js";
import { syncOperatorTaskToDeb } from "../operator-control/deb-sync.js";
import { submitOperatorTaskAndDispatch } from "../operator-control/dispatch.js";
import {
  listOperatorMemory,
  promoteOperatorMemory,
  upsertOperatorServiceContext,
  type OperatorMemoryCollection,
} from "../operator-control/memory-store.js";
import { getOperatorControlStatus } from "../operator-control/operator-status.js";
import { parseProjectOpsUpdatePayload } from "../operator-control/project-ops-payloads.js";
import {
  resolveDirectDebBaseUrl,
  resolveDirectDebSharedSecret,
  resolveInboundProjectOpsProxySharedSecret,
} from "../operator-control/project-ops-target.js";
import {
  acceptOperatorExternalReceipt,
  getOperatorTask,
  listOperatorTasks,
  patchOperatorTask,
  type OperatorTaskListFilters,
} from "../operator-control/task-store.js";
import {
  cancelOperatorWorkerTask,
  getOperatorWorkerReady,
  getOperatorWorkerTask,
  getOperatorWorkerTaskEvents,
  isOperatorWorkerClientError,
  listOperatorWorkerTasks,
} from "../operator-control/worker-client.js";
import { resolveOperatorReceiptTemplate } from "../operator-control/worker-status.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { buildControlUiCspHeader } from "./control-ui-csp.js";
import { isReadHttpMethod, respondNotFound } from "./control-ui-http-utils.js";
import { DELEGATED_MESSAGE_PATH } from "./delegated-http.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { sendUnauthorized } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import {
  getMissionControlAcpxSessionsSnapshot,
  ingestMissionControlAcpxEvents,
} from "./mission-control-acpx.js";
import {
  createMissionControlDebBacklogItem,
  createMissionControlDebCall,
  createMissionControlDebEmail,
  getMissionControlDebBacklog,
  getMissionControlDebEmails,
  getMissionControlDebProfile,
  getMissionControlDebSprint,
  getMissionControlDebWorkspace,
  parseMissionControlDebBacklogCreateInput,
  parseMissionControlDebBacklogPatchInput,
  parseMissionControlDebCallInput,
  parseMissionControlDebEmailDraftInput,
  parseMissionControlDebEmailReplaceInput,
  parseMissionControlDebProfileUpdateInput,
  removeMissionControlDebEmail,
  replaceMissionControlDebEmails,
  updateMissionControlDebBacklogItem,
  updateMissionControlDebEmail,
  updateMissionControlDebProfile,
} from "./mission-control-deb.js";
import type { ReadinessChecker } from "./server/readiness.js";

/** Legacy /mission-control path. Kept for backward compatibility. */
export const MISSION_CONTROL_BASE_PATH = "/mission-control" as const;
const MISSION_CONTROL_ACPX_EVENTS_PATH = `${MISSION_CONTROL_BASE_PATH}/api/acpx-events`;
const MISSION_CONTROL_DEB_API_PREFIX = `${MISSION_CONTROL_BASE_PATH}/api/deb`;
const MISSION_CONTROL_MEMORY_API_PREFIX = `${MISSION_CONTROL_BASE_PATH}/api/memory`;
const MISSION_CONTROL_PROJECT_OPS_API_PREFIX = `${MISSION_CONTROL_BASE_PATH}/api/project-ops`;
const MISSION_CONTROL_TASKS_API_PREFIX = `${MISSION_CONTROL_BASE_PATH}/api/tasks`;
const MISSION_CONTROL_WORKER_API_PREFIX = `${MISSION_CONTROL_BASE_PATH}/api/worker`;

const OPERATOR_API_PREFIX = "/api/operator";
const DEB_API_PREFIX = "/api/deb";

type OperatorApiClassification =
  | { kind: "not-operator-api" }
  | { kind: "serve"; routePath: string };

export function classifyOperatorApiRequest(params: {
  pathname: string;
  method: string | undefined;
}): OperatorApiClassification {
  const { pathname, method } = params;
  if (pathname.startsWith(OPERATOR_API_PREFIX)) {
    const suffix = pathname.slice(OPERATOR_API_PREFIX.length) || "/";
    if (suffix === "/agents") {
      return { kind: "serve", routePath: "/agents" };
    }
    if (suffix === "/acpx-events") {
      if (method === "POST") {
        return { kind: "serve", routePath: "/acpx-events" };
      }
      return { kind: "not-operator-api" };
    }
    if (suffix === "/status") {
      return { kind: "serve", routePath: "/operator/status" };
    }
    if (suffix === "/tasks" || suffix.startsWith("/tasks/")) {
      return { kind: "serve", routePath: suffix };
    }
    if (
      suffix === "/memory" ||
      suffix === "/memory/promote" ||
      suffix === "/memory/service-context"
    ) {
      return { kind: "serve", routePath: suffix };
    }
    if (
      suffix === "/worker/ready" ||
      suffix === "/worker/tasks" ||
      suffix.startsWith("/worker/tasks/")
    ) {
      return { kind: "serve", routePath: suffix };
    }
    if (
      suffix === "/project-ops/ready" ||
      suffix === "/project-ops/status" ||
      suffix === "/project-ops/sync" ||
      suffix === "/project-ops/update" ||
      suffix === "/project-ops/task" ||
      suffix === "/project-ops/operator/events"
    ) {
      return { kind: "serve", routePath: suffix };
    }
  }
  if (pathname === DEB_API_PREFIX || pathname.startsWith(`${DEB_API_PREFIX}/`)) {
    const suffix = pathname === DEB_API_PREFIX ? "" : pathname.slice(DEB_API_PREFIX.length);
    return { kind: "serve", routePath: `/deb${suffix}` };
  }
  return { kind: "not-operator-api" };
}

type MissionControlRequestClassification =
  | { kind: "not-mission-control" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve" };

export function classifyMissionControlRequest(params: {
  pathname: string;
  search: string;
  method: string | undefined;
}): MissionControlRequestClassification {
  const { pathname, search, method } = params;
  if (pathname === MISSION_CONTROL_BASE_PATH) {
    if (!isReadHttpMethod(method)) {
      return { kind: "not-mission-control" };
    }
    return {
      kind: "redirect",
      location: `${MISSION_CONTROL_BASE_PATH}/${search}`,
    };
  }
  if (!pathname.startsWith(`${MISSION_CONTROL_BASE_PATH}/`)) {
    return { kind: "not-mission-control" };
  }
  if (!isReadHttpMethod(method)) {
    if (method === "POST" && pathname === MISSION_CONTROL_ACPX_EVENTS_PATH) {
      return { kind: "serve" };
    }
    if (
      (method === "POST" && pathname === MISSION_CONTROL_TASKS_API_PREFIX) ||
      (method === "POST" &&
        pathname.startsWith(`${MISSION_CONTROL_TASKS_API_PREFIX}/`) &&
        pathname.endsWith("/receipts")) ||
      (method === "PATCH" && pathname.startsWith(`${MISSION_CONTROL_TASKS_API_PREFIX}/`))
    ) {
      return { kind: "serve" };
    }
    if (
      method === "POST" &&
      pathname.startsWith(`${MISSION_CONTROL_WORKER_API_PREFIX}/tasks/`) &&
      pathname.endsWith("/cancel")
    ) {
      return { kind: "serve" };
    }
    if (
      pathname === MISSION_CONTROL_MEMORY_API_PREFIX ||
      pathname === `${MISSION_CONTROL_MEMORY_API_PREFIX}/promote` ||
      pathname === `${MISSION_CONTROL_MEMORY_API_PREFIX}/service-context`
    ) {
      return { kind: "serve" };
    }
    if (
      pathname === `${MISSION_CONTROL_PROJECT_OPS_API_PREFIX}/ready` ||
      pathname === `${MISSION_CONTROL_PROJECT_OPS_API_PREFIX}/status` ||
      pathname === `${MISSION_CONTROL_PROJECT_OPS_API_PREFIX}/sync` ||
      pathname === `${MISSION_CONTROL_PROJECT_OPS_API_PREFIX}/update` ||
      pathname === `${MISSION_CONTROL_PROJECT_OPS_API_PREFIX}/task` ||
      pathname === `${MISSION_CONTROL_PROJECT_OPS_API_PREFIX}/operator/events`
    ) {
      return { kind: "serve" };
    }
    if (
      pathname === MISSION_CONTROL_DEB_API_PREFIX ||
      pathname.startsWith(`${MISSION_CONTROL_DEB_API_PREFIX}/`)
    ) {
      return { kind: "serve" };
    }
    return { kind: "not-found" };
  }
  return { kind: "serve" };
}

const MISSION_CONTROL_API_BASE_PATH = `${MISSION_CONTROL_BASE_PATH}/api`;
const MISSION_CONTROL_ACPX_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MISSION_CONTROL_DEB_MAX_BODY_BYTES = 512 * 1024;
const PROJECT_OPS_TASK_SCHEMA_VERSION = "PawAndOrderTaskV1" as const;

const missionControlProjectOpsTaskSchema = z.object({
  schema: z.literal(PROJECT_OPS_TASK_SCHEMA_VERSION).default(PROJECT_OPS_TASK_SCHEMA_VERSION),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  capability: z.string().trim().min(1),
  team_id: z.string().trim().min(1).nullable().optional(),
  team_lead: z.string().trim().min(1).nullable().optional(),
  alias: z.string().trim().min(1).nullable().optional(),
  specialist_role: z.string().trim().min(1).nullable().optional(),
  dog_role: z.string().trim().min(1).nullable().optional(),
  artifact_type: z.string().trim().min(1).nullable().optional(),
  channel_target: z.string().trim().min(1).nullable().optional(),
  delivery_mode: z.string().trim().min(1).nullable().optional(),
  requester: z.object({
    id: z.string().trim().min(1),
    kind: z.enum(["operator", "agent", "system"]).default("operator"),
  }),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  context_refs: z.array(operatorContextRefSchema).default([]),
  reply_to: operatorReplyTargetSchema.nullable().optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

export type MissionControlHttpAuthContext = {
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
};

function applyMissionControlSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/u, "");
}

function readMessageFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  for (const key of ["message", "status", "output", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveMissionControlDelegatedTransportBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL ??
      process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_URL ??
      process.env.OPENCLAW_OPERATOR_ANGELA_URL,
  );
}

function resolveMissionControlDelegatedTransportSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

function buildOperatorReceiptUrl(taskId: string): string | null {
  const template = resolveOperatorReceiptTemplate();
  if (!template) {
    return null;
  }
  return template.replace(/\{taskId\}/gu, encodeURIComponent(taskId));
}

function respondJson(
  res: ServerResponse,
  status: number,
  req: IncomingMessage,
  payload?: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(payload === undefined ? undefined : JSON.stringify(payload));
}

function isMissionControlApiPath(pathname: string): boolean {
  return (
    pathname === MISSION_CONTROL_API_BASE_PATH ||
    pathname.startsWith(`${MISSION_CONTROL_API_BASE_PATH}/`)
  );
}

function decodePathSegment(value: string): string | null {
  if (!value) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

function headerToString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

class MissionControlApiRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "MissionControlApiRequestError";
    this.statusCode = statusCode;
  }
}

function isMissionControlDebRoute(routePath: string): boolean {
  return routePath === "/deb" || routePath.startsWith("/deb/");
}

function isMissionControlTaskRoute(routePath: string): boolean {
  return routePath === "/tasks" || routePath.startsWith("/tasks/");
}

function isMissionControlMemoryRoute(routePath: string): boolean {
  return (
    routePath === "/memory" ||
    routePath === "/memory/promote" ||
    routePath === "/memory/service-context"
  );
}

function isMissionControlProjectOpsRoute(routePath: string): boolean {
  return (
    routePath === "/project-ops/ready" ||
    routePath === "/project-ops/status" ||
    routePath === "/project-ops/sync" ||
    routePath === "/project-ops/update" ||
    routePath === "/project-ops/task" ||
    routePath === "/project-ops/operator/events"
  );
}

function isMissionControlWorkerRoute(routePath: string): boolean {
  return (
    routePath === "/worker/ready" ||
    routePath === "/worker/tasks" ||
    routePath.startsWith("/worker/tasks/")
  );
}

async function authorizeProjectOpsProxyRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  authContext?: MissionControlHttpAuthContext;
}): Promise<boolean> {
  const { req, res, authContext } = params;
  const expectedSecret = resolveInboundProjectOpsProxySharedSecret();
  if (expectedSecret) {
    if (!safeEqualSecret(getBearerToken(req), expectedSecret)) {
      sendUnauthorized(res);
      return false;
    }
    return true;
  }
  if (!authContext) {
    return true;
  }
  return await authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: authContext.auth,
    trustedProxies: authContext.trustedProxies,
    allowRealIpFallback: authContext.allowRealIpFallback,
    rateLimiter: authContext.rateLimiter,
  });
}

function projectOpsAllowHeader(routePath: string): string {
  return routePath === "/project-ops/ready" ? "GET, HEAD" : "POST";
}

async function handleMissionControlProjectOpsTaskRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<boolean> {
  const { req, res } = params;

  try {
    const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
    const parsed = missionControlProjectOpsTaskSchema.parse(payload);
    const delegatedBaseUrl = resolveMissionControlDelegatedTransportBaseUrl();
    if (!delegatedBaseUrl) {
      respondJson(res, 503, req, {
        error: {
          message: "Delegated project-ops control path is not configured",
        },
      });
      return true;
    }

    const callbackUrl = buildOperatorReceiptUrl(parsed.task_id);
    if (!callbackUrl) {
      respondJson(res, 503, req, {
        error: {
          message: "Operator receipt callback URL is not configured",
        },
      });
      return true;
    }

    const specialistRole = parsed.specialist_role?.trim() || parsed.dog_role?.trim() || "deb";
    const dogRole = parsed.dog_role?.trim() || specialistRole;
    const response = await fetch(`${delegatedBaseUrl}${DELEGATED_MESSAGE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(resolveMissionControlDelegatedTransportSharedSecret()
          ? {
              authorization: `Bearer ${resolveMissionControlDelegatedTransportSharedSecret()}`,
            }
          : {}),
      },
      body: JSON.stringify({
        schema: DELEGATED_LEAD_TASK_ENVELOPE_SCHEMA_VERSION,
        task_id: parsed.task_id,
        run_id: parsed.run_id,
        callback_url: callbackUrl,
        receipt_schema: DELEGATED_LEAD_RECEIPT_SCHEMA_VERSION,
        objective: parsed.objective,
        capability: parsed.capability,
        team_id: parsed.team_id?.trim() || "project-ops",
        team_lead: "deb",
        alias: "deb",
        requester: parsed.requester,
        acceptance_criteria: parsed.acceptance_criteria,
        context_refs: parsed.context_refs,
        inputs: {
          ...parsed.inputs,
          specialist_role: specialistRole,
          dog_role: dogRole,
          artifact_type: parsed.artifact_type ?? null,
          channel_target: parsed.channel_target ?? null,
          delivery_mode: parsed.delivery_mode ?? null,
          requested_alias: parsed.alias ?? null,
          upstream_task_id: parsed.task_id,
          upstream_run_id: parsed.run_id,
          paw_and_order: true,
          orchestration_source: "mission-control-project-ops-task",
        },
        reply_to: parsed.reply_to ?? null,
        execution: {
          transport: "delegated-http",
          runtime: "subagent",
          durable: true,
        },
      }),
    });

    const rawPayload = await response.text();
    let upstreamPayload: unknown = null;
    try {
      upstreamPayload = rawPayload.trim() ? (JSON.parse(rawPayload) as unknown) : null;
    } catch {
      upstreamPayload = rawPayload.trim() || null;
    }

    if (!response.ok) {
      respondJson(res, response.status, req, {
        error: {
          message:
            readMessageFromPayload(upstreamPayload) ??
            (typeof upstreamPayload === "string" && upstreamPayload ? upstreamPayload : null) ??
            `Project-ops task dispatch failed (${response.status} ${response.statusText})`,
        },
      });
      return true;
    }

    respondJson(res, 202, req, {
      ...asRecord(upstreamPayload),
      ok: true,
      status: "accepted",
      owner: "deb",
      agentId: "deb",
      taskId: parsed.task_id,
      runId: parsed.run_id,
      specialistRole,
      dogRole,
      callbackRegistered: true,
    });
    return true;
  } catch (error) {
    if (error instanceof ZodError) {
      respondValidationError(res, req, error);
      return true;
    }
    if (error instanceof MissionControlApiRequestError) {
      respondJson(res, error.statusCode, req, {
        error: {
          message: error.message,
        },
      });
      return true;
    }
    respondJson(res, 502, req, {
      error: {
        message:
          error instanceof Error ? error.message : "Project-ops task dispatch request failed",
      },
    });
    return true;
  }
}

async function handleMissionControlProjectOpsProxyRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  routePath: string;
  authContext?: MissionControlHttpAuthContext;
}): Promise<boolean> {
  const { req, res, routePath, authContext } = params;

  if (!isMissionControlProjectOpsRoute(routePath)) {
    return false;
  }

  const allow = projectOpsAllowHeader(routePath);
  const isReadRoute = routePath === "/project-ops/ready";
  if (isReadRoute ? req.method !== "GET" && req.method !== "HEAD" : req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", allow);
    res.end();
    return true;
  }

  if (!(await authorizeProjectOpsProxyRequest({ req, res, authContext }))) {
    return true;
  }

  if (routePath === "/project-ops/task") {
    return await handleMissionControlProjectOpsTaskRequest({ req, res });
  }

  const debBaseUrl = resolveDirectDebBaseUrl();
  if (!debBaseUrl) {
    respondJson(res, 503, req, {
      error: {
        message: "Project-ops upstream not configured",
      },
    });
    return true;
  }

  const upstreamEndpoint = `${debBaseUrl}${routePath.slice("/project-ops".length)}`;

  try {
    const rawBody =
      req.method === "POST"
        ? await readRequestBodyWithLimit(req, {
            maxBytes: MISSION_CONTROL_DEB_MAX_BODY_BYTES,
          })
        : undefined;
    let contentType = headerToString(req.headers["content-type"]);
    let forwardedBody = rawBody;
    if (routePath === "/project-ops/update" && rawBody !== undefined) {
      const parsedBody = parseJsonBody(rawBody);
      try {
        forwardedBody = JSON.stringify(parseProjectOpsUpdatePayload(parsedBody));
      } catch (error) {
        throw new MissionControlApiRequestError(
          error instanceof Error ? error.message : "Invalid project-ops update payload",
          422,
        );
      }
      contentType = "application/json";
    }
    const response = await fetch(upstreamEndpoint, {
      method: req.method,
      headers: {
        accept: "application/json",
        ...(contentType && forwardedBody !== undefined
          ? {
              "content-type": contentType,
            }
          : {}),
        ...(resolveDirectDebSharedSecret()
          ? {
              authorization: `Bearer ${resolveDirectDebSharedSecret()}`,
            }
          : {}),
      },
      body: forwardedBody,
    });
    const payload = await response.text();
    res.statusCode = response.status;
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ?? "application/json; charset=utf-8",
    );
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(payload);
    return true;
  } catch (error) {
    if (error instanceof MissionControlApiRequestError) {
      respondJson(res, error.statusCode, req, {
        error: {
          message: error.message,
        },
      });
      return true;
    }
    respondJson(res, 502, req, {
      error: {
        message: error instanceof Error ? error.message : "Project-ops proxy request failed",
      },
    });
    return true;
  }
}

async function readJsonRequestBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const rawBody = await readRequestBodyWithLimit(req, {
    maxBytes,
  });
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new MissionControlApiRequestError("Invalid JSON payload", 400);
  }
}

function parseJsonBody(rawBody: string): unknown {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new MissionControlApiRequestError("Invalid JSON payload", 400);
  }
}

function respondValidationError(res: ServerResponse, req: IncomingMessage, error: ZodError): void {
  respondJson(res, 422, req, {
    error: {
      message: "Validation failed",
      issues: error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
      })),
    },
  });
}

async function handleMissionControlDebApiRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  routePath: string;
}): Promise<boolean> {
  const { req, res, routePath } = params;

  if (!isMissionControlDebRoute(routePath)) {
    return false;
  }

  try {
    if (routePath === "/deb") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end();
        return true;
      }
      respondJson(res, 200, req, getMissionControlDebWorkspace());
      return true;
    }

    if (routePath === "/deb/emails") {
      if (req.method === "GET" || req.method === "HEAD") {
        respondJson(res, 200, req, getMissionControlDebEmails());
        return true;
      }

      if (req.method === "PUT") {
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const parsed = parseMissionControlDebEmailReplaceInput(payload);
        respondJson(res, 200, req, replaceMissionControlDebEmails(parsed));
        return true;
      }

      if (req.method === "POST") {
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const parsed = parseMissionControlDebEmailDraftInput(payload);
        respondJson(res, 201, req, createMissionControlDebEmail(parsed));
        return true;
      }

      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD, PUT, POST");
      res.end();
      return true;
    }

    if (routePath.startsWith("/deb/emails/")) {
      const encodedId = routePath.slice("/deb/emails/".length);
      if (!encodedId || encodedId.includes("/")) {
        respondNotFound(res);
        return true;
      }
      const emailId = decodePathSegment(encodedId);
      if (!emailId) {
        respondNotFound(res);
        return true;
      }

      if (req.method === "PATCH") {
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const parsed = parseMissionControlDebEmailDraftInput(payload);
        const updated = updateMissionControlDebEmail(emailId, parsed);
        if (!updated) {
          respondJson(res, 404, req, {
            error: {
              message: "Deb email recipient not found",
            },
          });
          return true;
        }
        respondJson(res, 200, req, updated);
        return true;
      }

      if (req.method === "DELETE") {
        const removed = removeMissionControlDebEmail(emailId);
        if (!removed) {
          respondJson(res, 404, req, {
            error: {
              message: "Deb email recipient not found",
            },
          });
          return true;
        }
        res.statusCode = 204;
        res.end();
        return true;
      }

      res.statusCode = 405;
      res.setHeader("Allow", "PATCH, DELETE");
      res.end();
      return true;
    }

    if (routePath === "/deb/profile") {
      if (req.method === "GET" || req.method === "HEAD") {
        respondJson(res, 200, req, getMissionControlDebProfile());
        return true;
      }
      if (req.method !== "PUT") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD, PUT");
        res.end();
        return true;
      }
      const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
      const parsed = parseMissionControlDebProfileUpdateInput(payload);
      respondJson(res, 200, req, updateMissionControlDebProfile(parsed));
      return true;
    }

    if (routePath === "/deb/sprint") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end();
        return true;
      }
      respondJson(res, 200, req, getMissionControlDebSprint());
      return true;
    }

    if (routePath === "/deb/backlog") {
      if (req.method === "GET" || req.method === "HEAD") {
        respondJson(res, 200, req, getMissionControlDebBacklog());
        return true;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD, POST");
        res.end();
        return true;
      }
      const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
      const parsed = parseMissionControlDebBacklogCreateInput(payload);
      const created = createMissionControlDebBacklogItem(parsed);
      const compatItem = getMissionControlDebWorkspace().backlog.find(
        (entry) => entry.id === created.id,
      );
      respondJson(
        res,
        201,
        req,
        compatItem ?? {
          id: created.id,
          title: created.title,
          section: created.section,
          priority: created.priority.toUpperCase(),
          status: created.status === "in_progress" ? "in-progress" : created.status,
          owner: created.owner,
          notes: created.notes,
          updatedAt: created.updatedAt,
        },
      );
      return true;
    }

    if (routePath.startsWith("/deb/backlog/")) {
      const encodedId = routePath.slice("/deb/backlog/".length);
      if (!encodedId || encodedId.includes("/")) {
        respondNotFound(res);
        return true;
      }
      const itemId = decodePathSegment(encodedId);
      if (!itemId) {
        respondNotFound(res);
        return true;
      }
      if (req.method !== "PATCH") {
        res.statusCode = 405;
        res.setHeader("Allow", "PATCH");
        res.end();
        return true;
      }
      const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
      const parsed = parseMissionControlDebBacklogPatchInput(payload);
      const updated = updateMissionControlDebBacklogItem(itemId, parsed);
      if (!updated) {
        respondJson(res, 404, req, {
          error: {
            message: "Backlog item not found",
          },
        });
        return true;
      }

      const compatItem = getMissionControlDebWorkspace().backlog.find(
        (entry) => entry.id === updated.id,
      );
      respondJson(
        res,
        200,
        req,
        compatItem ?? {
          id: updated.id,
          title: updated.title,
          section: updated.section,
          priority: updated.priority.toUpperCase(),
          status: updated.status === "in_progress" ? "in-progress" : updated.status,
          owner: updated.owner,
          notes: updated.notes,
          updatedAt: updated.updatedAt,
        },
      );
      return true;
    }

    if (routePath === "/deb/call") {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return true;
      }
      const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
      const parsed = parseMissionControlDebCallInput(payload);
      respondJson(res, 202, req, createMissionControlDebCall(parsed));
      return true;
    }

    respondNotFound(res);
    return true;
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      respondJson(res, error.statusCode, req, {
        error: {
          message: requestBodyErrorToText(error.code),
        },
      });
      return true;
    }

    if (error instanceof MissionControlApiRequestError) {
      respondJson(res, error.statusCode, req, {
        error: {
          message: error.message,
        },
      });
      return true;
    }

    if (error instanceof ZodError) {
      respondValidationError(res, req, error);
      return true;
    }

    const message = error instanceof Error ? error.message : "Mission Control Deb API failed";
    respondJson(res, 500, req, {
      error: {
        message,
      },
    });
    return true;
  }
}

async function handleMissionControlApiRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  authContext?: MissionControlHttpAuthContext;
}): Promise<boolean> {
  const { req, res, url, authContext } = params;

  if (!isMissionControlApiPath(url.pathname)) {
    return false;
  }

  const routePath =
    url.pathname === MISSION_CONTROL_API_BASE_PATH
      ? "/"
      : url.pathname.slice(MISSION_CONTROL_API_BASE_PATH.length);

  if (routePath === "/acpx-events") {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end();
      return true;
    }

    if (authContext) {
      const authorized = await authorizeGatewayBearerRequestOrReply({
        req,
        res,
        auth: authContext.auth,
        trustedProxies: authContext.trustedProxies,
        allowRealIpFallback: authContext.allowRealIpFallback,
        rateLimiter: authContext.rateLimiter,
      });
      if (!authorized) {
        return true;
      }
    }

    try {
      const rawBody = await readRequestBodyWithLimit(req, {
        maxBytes: MISSION_CONTROL_ACPX_MAX_BODY_BYTES,
      });
      const payload = ingestMissionControlAcpxEvents({
        rawBody,
        contentType: headerToString(req.headers["content-type"]),
      });
      const status = payload.accepted > 0 ? 202 : 400;
      respondJson(res, status, req, payload);
      return true;
    } catch (error) {
      if (isRequestBodyLimitError(error)) {
        respondJson(res, error.statusCode, req, {
          error: {
            message: requestBodyErrorToText(error.code),
          },
        });
        return true;
      }

      const message = error instanceof Error ? error.message : "Mission Control ACPX ingest failed";
      respondJson(res, 400, req, {
        error: {
          message,
        },
      });
      return true;
    }
  }

  if (isMissionControlProjectOpsRoute(routePath)) {
    return await handleMissionControlProjectOpsProxyRequest({
      req,
      res,
      routePath,
      authContext,
    });
  }

  if (isMissionControlTaskRoute(routePath)) {
    if (authContext) {
      const authorized = await authorizeGatewayBearerRequestOrReply({
        req,
        res,
        auth: authContext.auth,
        trustedProxies: authContext.trustedProxies,
        allowRealIpFallback: authContext.allowRealIpFallback,
        rateLimiter: authContext.rateLimiter,
      });
      if (!authorized) {
        return true;
      }
    }

    try {
      if (routePath === "/tasks") {
        if (req.method === "GET" || req.method === "HEAD") {
          const payload = listOperatorTasks({
            state: decodePathSegment(
              url.searchParams.get("state") ?? "",
            ) as OperatorTaskListFilters["state"],
            tier: decodePathSegment(
              url.searchParams.get("tier") ?? "",
            ) as OperatorTaskListFilters["tier"],
            capability: decodePathSegment(url.searchParams.get("capability") ?? ""),
            limit: Number(url.searchParams.get("limit") ?? "50"),
          });
          respondJson(res, 200, req, payload);
          return true;
        }
        if (req.method === "POST") {
          const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
          const created = await submitOperatorTaskAndDispatch(payload);
          await syncOperatorTaskToDeb(created.task, "submit");
          respondJson(res, created.created ? 201 : 200, req, created);
          return true;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD, POST");
        res.end();
        return true;
      }

      const receiptSuffix = "/receipts";
      const isReceiptRoute = routePath.endsWith(receiptSuffix);
      const encodedId = isReceiptRoute
        ? routePath.slice("/tasks/".length, -receiptSuffix.length)
        : routePath.slice("/tasks/".length);
      if (!encodedId || encodedId.includes("/")) {
        respondNotFound(res);
        return true;
      }
      const taskId = decodePathSegment(encodedId);
      if (!taskId) {
        respondNotFound(res);
        return true;
      }
      if (isReceiptRoute) {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          res.end();
          return true;
        }
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const result = acceptOperatorExternalReceipt(taskId, payload);
        if (result.queued) {
          respondJson(res, 202, req, {
            queued: true,
            reason: result.reason,
            pendingReceipt: result.pendingReceipt,
          });
          return true;
        }
        if (!result.task) {
          respondJson(res, 404, req, {
            error: {
              message: "Operator task not found",
            },
          });
          return true;
        }
        await syncOperatorTaskToDeb(result.task, "receipt");
        respondJson(res, 200, req, result.task);
        return true;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const task = getOperatorTask(taskId);
        if (!task) {
          respondJson(res, 404, req, {
            error: {
              message: "Operator task not found",
            },
          });
          return true;
        }
        respondJson(res, 200, req, task);
        return true;
      }
      if (req.method === "PATCH") {
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const updated = patchOperatorTask(taskId, payload);
        if (!updated) {
          respondJson(res, 404, req, {
            error: {
              message: "Operator task not found",
            },
          });
          return true;
        }
        await syncOperatorTaskToDeb(updated, "patch");
        respondJson(res, 200, req, updated);
        return true;
      }
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD, PATCH, POST");
      res.end();
      return true;
    } catch (error) {
      if (isRequestBodyLimitError(error)) {
        respondJson(res, error.statusCode, req, {
          error: {
            message: requestBodyErrorToText(error.code),
          },
        });
        return true;
      }
      if (error instanceof ZodError) {
        respondValidationError(res, req, error);
        return true;
      }
      respondJson(res, 400, req, {
        error: {
          message:
            error instanceof Error ? error.message : "Mission Control operator task API failed",
        },
      });
      return true;
    }
  }

  if (isMissionControlWorkerRoute(routePath)) {
    if (authContext) {
      const authorized = await authorizeGatewayBearerRequestOrReply({
        req,
        res,
        auth: authContext.auth,
        trustedProxies: authContext.trustedProxies,
        allowRealIpFallback: authContext.allowRealIpFallback,
        rateLimiter: authContext.rateLimiter,
      });
      if (!authorized) {
        return true;
      }
    }

    try {
      if (routePath === "/worker/ready") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end();
          return true;
        }
        const payload = await getOperatorWorkerReady();
        respondJson(res, 200, req, payload);
        return true;
      }

      if (routePath === "/worker/tasks") {
        if (req.method === "GET" || req.method === "HEAD") {
          const payload = await listOperatorWorkerTasks(
            Number(url.searchParams.get("limit") ?? "50"),
          );
          respondJson(res, 200, req, payload);
          return true;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end();
        return true;
      }

      const cancelSuffix = "/cancel";
      const eventsSuffix = "/events";
      const isCancelRoute = routePath.endsWith(cancelSuffix);
      const isEventsRoute = routePath.endsWith(eventsSuffix);
      const encodedId = isCancelRoute
        ? routePath.slice("/worker/tasks/".length, -cancelSuffix.length)
        : isEventsRoute
          ? routePath.slice("/worker/tasks/".length, -eventsSuffix.length)
          : routePath.slice("/worker/tasks/".length);
      if (!encodedId || encodedId.includes("/")) {
        respondNotFound(res);
        return true;
      }
      const taskId = decodePathSegment(encodedId);
      if (!taskId) {
        respondNotFound(res);
        return true;
      }

      if (isCancelRoute) {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          res.end();
          return true;
        }
        const payload = await cancelOperatorWorkerTask(taskId);
        respondJson(res, payload.cancelled ? 200 : 409, req, payload);
        return true;
      }

      if (isEventsRoute) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end();
          return true;
        }
        const payload = await getOperatorWorkerTaskEvents(taskId);
        respondJson(res, 200, req, payload);
        return true;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end();
        return true;
      }
      const payload = await getOperatorWorkerTask(taskId);
      respondJson(res, 200, req, payload);
      return true;
    } catch (error) {
      if (isOperatorWorkerClientError(error)) {
        respondJson(res, error.statusCode, req, {
          error: {
            message: error.message,
          },
          worker: error.payload,
        });
        return true;
      }

      respondJson(res, 502, req, {
        error: {
          message: error instanceof Error ? error.message : "Mission Control worker API failed",
        },
      });
      return true;
    }
  }

  if (isMissionControlMemoryRoute(routePath)) {
    if (authContext) {
      const authorized = await authorizeGatewayBearerRequestOrReply({
        req,
        res,
        auth: authContext.auth,
        trustedProxies: authContext.trustedProxies,
        allowRealIpFallback: authContext.allowRealIpFallback,
        rateLimiter: authContext.rateLimiter,
      });
      if (!authorized) {
        return true;
      }
    }

    try {
      if (routePath === "/memory") {
        if (req.method === "GET" || req.method === "HEAD") {
          const payload = listOperatorMemory({
            collection: decodePathSegment(
              url.searchParams.get("collection") ?? "",
            ) as OperatorMemoryCollection | null,
            limit: Number(url.searchParams.get("limit") ?? "50"),
          });
          respondJson(res, 200, req, payload);
          return true;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end();
        return true;
      }

      if (routePath === "/memory/promote") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          res.end();
          return true;
        }
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const promoted = promoteOperatorMemory(payload);
        respondJson(res, promoted.created ? 201 : 200, req, promoted);
        return true;
      }

      if (routePath === "/memory/service-context") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          res.end();
          return true;
        }
        const payload = await readJsonRequestBody(req, MISSION_CONTROL_DEB_MAX_BODY_BYTES);
        const updated = upsertOperatorServiceContext(payload);
        respondJson(res, updated.created ? 201 : 200, req, updated);
        return true;
      }
    } catch (error) {
      if (isRequestBodyLimitError(error)) {
        respondJson(res, error.statusCode, req, {
          error: {
            message: requestBodyErrorToText(error.code),
          },
        });
        return true;
      }
      if (error instanceof ZodError) {
        respondValidationError(res, req, error);
        return true;
      }
      respondJson(res, 400, req, {
        error: {
          message:
            error instanceof Error ? error.message : "Mission Control operator memory API failed",
        },
      });
      return true;
    }
  }

  if (isMissionControlDebRoute(routePath)) {
    if (authContext) {
      const authorized = await authorizeGatewayBearerRequestOrReply({
        req,
        res,
        auth: authContext.auth,
        trustedProxies: authContext.trustedProxies,
        allowRealIpFallback: authContext.allowRealIpFallback,
        rateLimiter: authContext.rateLimiter,
      });
      if (!authorized) {
        return true;
      }
    }

    return await handleMissionControlDebApiRequest({
      req,
      res,
      routePath,
    });
  }

  if (!isReadHttpMethod(req.method)) {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return true;
  }

  if (authContext) {
    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: authContext.auth,
      trustedProxies: authContext.trustedProxies,
      allowRealIpFallback: authContext.allowRealIpFallback,
      rateLimiter: authContext.rateLimiter,
    });
    if (!authorized) {
      return true;
    }
  }

  try {
    if (routePath === "/agents") {
      const payload = compileOperatorAgentRegistry();
      respondJson(res, 200, req, payload);
      return true;
    }

    if (routePath === "/operator/status") {
      const payload = getOperatorControlStatus();
      respondJson(res, 200, req, payload);
      return true;
    }

    if (routePath === "/acpx-sessions") {
      const payload = getMissionControlAcpxSessionsSnapshot();
      respondJson(res, 200, req, payload);
      return true;
    }

    respondNotFound(res);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mission Control API failed";
    respondJson(res, 500, req, {
      error: {
        message,
      },
    });
    return true;
  }
}

export async function handleOperatorHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authContext?: MissionControlHttpAuthContext,
): Promise<boolean> {
  const rawUrl = req.url;
  if (!rawUrl) {
    return false;
  }

  const url = new URL(rawUrl, "http://localhost");
  let effectiveUrl = url;

  const operatorClassified = classifyOperatorApiRequest({
    pathname: url.pathname,
    method: req.method,
  });
  if (operatorClassified.kind === "serve") {
    effectiveUrl = new URL(
      `${MISSION_CONTROL_API_BASE_PATH}${operatorClassified.routePath}${url.search}`,
      url.href,
    );
  }

  const classified =
    operatorClassified.kind === "serve"
      ? ({ kind: "serve" } as const)
      : classifyMissionControlRequest({
          pathname: url.pathname,
          search: url.search,
          method: req.method,
        });

  if (classified.kind === "not-mission-control") {
    return false;
  }

  applyMissionControlSecurityHeaders(res);

  if (classified.kind === "not-found") {
    respondNotFound(res);
    return true;
  }

  if (classified.kind === "redirect") {
    res.statusCode = 302;
    res.setHeader("Location", classified.location);
    res.end();
    return true;
  }

  if (
    await handleMissionControlApiRequest({
      req,
      res,
      url: effectiveUrl,
      authContext,
    })
  ) {
    return true;
  }

  respondNotFound(res);
  return true;
}
