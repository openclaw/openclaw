import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { loadConfig } from "../../config/config.js";
import { getBearerToken } from "../../gateway/http-utils.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import {
  ReplayRunsCloseRequestSchema,
  ReplayRunsCreateRequestSchema,
  ReplayRunsGetStateResponseSchema,
  ReplayRunsStepRequestSchema,
  ReplayRunsStepResponseSchema,
  type ReplayRunsCloseRequest,
  type ReplayRunsCreateRequest,
  type ReplayRunsStepRequest,
} from "../../research/contracts/index.js";
import { isResearchEnabled } from "../../research/events/writer.js";
import { ReplayControlError, toHttpErrorResponse } from "./errors.js";
import {
  closeReplayRun,
  createReplayRun,
  stepReplayRun,
  toReplayRunStateResponse,
} from "./runner.js";
import type { ReplayControlServer, ReplayRunState } from "./types.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof SyntaxError ? err.message : String(err);
    throw new ReplayControlError({
      code: "invalid_request",
      status: 400,
      message: `Invalid JSON body: ${message}`,
    });
  }
}

function assertAuthorized(req: IncomingMessage, token: string): void {
  const bearerToken = getBearerToken(req);
  if (!bearerToken || bearerToken !== token) {
    throw new ReplayControlError({
      code: "unauthorized",
      status: 401,
      message: "Unauthorized",
    });
  }
}

function parseRunIdFromQuery(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const runId = url.searchParams.get("runId")?.trim() ?? "";
  if (!runId) {
    throw new ReplayControlError({
      code: "invalid_request",
      status: 400,
      message: "Missing runId query parameter",
    });
  }
  return runId;
}

function validateBody<T extends Record<string, unknown>>(params: {
  schema: Record<string, unknown>;
  cacheKey: string;
  value: unknown;
}): T {
  const validated = validateJsonSchemaValue({
    schema: params.schema,
    cacheKey: params.cacheKey,
    value: params.value,
  });
  if (!validated.ok) {
    const reason = validated.errors.map((error) => error.text).join("; ");
    throw new ReplayControlError({
      code: "invalid_request",
      status: 400,
      message: `Invalid request: ${reason}`,
    });
  }
  return params.value as T;
}

export async function startReplayControlServer(params: {
  enabled?: boolean;
  port?: number;
  token?: string;
  ttlMs?: number;
}): Promise<ReplayControlServer> {
  const cfg = loadConfig();
  const enabled = params.enabled ?? isResearchEnabled(cfg);
  if (!enabled) {
    throw new ReplayControlError({
      code: "replay_disabled",
      status: 404,
      message: "Replay control is disabled",
    });
  }

  const token = params.token?.trim() || randomBytes(24).toString("hex");
  const ttlMs = params.ttlMs ?? 15 * 60_000;
  const runs = new Map<string, ReplayRunState>();
  const cleanupTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [runId, run] of runs) {
        if (now - run.updatedAtMs > ttlMs) {
          runs.delete(runId);
        }
      }
    },
    Math.min(ttlMs, 30_000),
  );
  cleanupTimer.unref();

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        assertAuthorized(req, token);

        if (req.method === "POST" && path === "/api/replay/v1/runs.create") {
          const body = await readJsonBody(req);
          const createBody = validateBody<ReplayRunsCreateRequest>({
            schema: ReplayRunsCreateRequestSchema,
            cacheKey: "replay.control.request.create",
            value: body,
          });
          const runId = `replay-${randomUUID()}`;
          const run = await createReplayRun({ runId, request: createBody });
          runs.set(runId, run);
          sendJson(res, 200, { runId, status: "created", mode: run.mode });
          return;
        }

        if (req.method === "POST" && path === "/api/replay/v1/runs.step") {
          const body = await readJsonBody(req);
          const stepBody = validateBody<ReplayRunsStepRequest>({
            schema: ReplayRunsStepRequestSchema,
            cacheKey: "replay.control.request.step",
            value: body,
          });
          const run = runs.get(stepBody.runId);
          if (!run) {
            throw new ReplayControlError({
              code: "not_found",
              status: 404,
              message: `Run not found: ${stepBody.runId}`,
            });
          }
          const step = stepReplayRun({ run });
          const valid = validateJsonSchemaValue({
            schema: ReplayRunsStepResponseSchema,
            cacheKey: "replay.control.response.step",
            value: step,
          });
          if (!valid.ok) {
            throw new ReplayControlError({
              code: "internal_error",
              status: 500,
              message: "Invalid replay step response shape",
            });
          }
          sendJson(res, 200, step);
          return;
        }

        if (req.method === "GET" && path === "/api/replay/v1/runs.getState") {
          const runId = parseRunIdFromQuery(req);
          const run = runs.get(runId);
          if (!run) {
            throw new ReplayControlError({
              code: "not_found",
              status: 404,
              message: `Run not found: ${runId}`,
            });
          }
          const state = toReplayRunStateResponse(run);
          const valid = validateJsonSchemaValue({
            schema: ReplayRunsGetStateResponseSchema,
            cacheKey: "replay.control.response.state",
            value: state,
          });
          if (!valid.ok) {
            throw new ReplayControlError({
              code: "internal_error",
              status: 500,
              message: "Invalid replay state response shape",
            });
          }
          sendJson(res, 200, state);
          return;
        }

        if (req.method === "POST" && path === "/api/replay/v1/runs.close") {
          const body = await readJsonBody(req);
          const closeBody = validateBody<ReplayRunsCloseRequest>({
            schema: ReplayRunsCloseRequestSchema,
            cacheKey: "replay.control.request.close",
            value: body,
          });
          const run = runs.get(closeBody.runId);
          if (!run) {
            throw new ReplayControlError({
              code: "not_found",
              status: 404,
              message: `Run not found: ${closeBody.runId}`,
            });
          }
          closeReplayRun(run);
          runs.delete(closeBody.runId);
          sendJson(res, 200, { runId: closeBody.runId, status: "closed" });
          return;
        }

        sendJson(res, 404, { ok: false, error: { code: "not_found", message: "Not Found" } });
      } catch (err) {
        const response = toHttpErrorResponse(err);
        sendJson(res, response.status, response.body);
      }
    })();
  });

  const port = params.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    cleanupTimer.unref();
    throw new Error("Failed to resolve replay server address");
  }

  return {
    server,
    token,
    host: "127.0.0.1",
    port: address.port,
    close: async () => {
      clearInterval(cleanupTimer);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
