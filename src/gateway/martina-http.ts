import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { buildArtifactPreview, getArtifactMimeType } from "../martina/artifacts.js";
import { buildMartinaApiPath, MARTINA_API_BASE_PATH } from "../martina/paths.js";
import { martinaService } from "../martina/service.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed, sendText } from "./http-common.js";

const MAX_BODY_BYTES = 256_000;

export type MartinaHttpAuthContext = {
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
};

const ARTIFACT_BUCKETS = {
  coverLetters: martinaService.paths.outputDirs.coverLetters,
  dossiers: martinaService.paths.outputDirs.dossiers,
  reports: martinaService.paths.outputDirs.reports,
  resumes: martinaService.paths.outputDirs.resumes,
} as const;

function sendMartinaJson(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, status, body);
}

function sendMartinaText(res: ServerResponse, status: number, body: string): void {
  res.setHeader("Cache-Control", "no-store");
  sendText(res, status, body);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isKnownClientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === "message is required" ||
    error.message === "message is too long" ||
    error.message === "jobId is required" ||
    error.message === "Wait for the active Martina run to finish before mutating queues." ||
    error.message.includes("targetQueue must be one of") ||
    error.message.includes("was not found in master_log.json")
  );
}

async function authorizeMartinaRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  authContext?: MartinaHttpAuthContext;
}): Promise<boolean> {
  const { req, res, authContext } = params;
  if (!authContext) {
    return true;
  }
  if (isLocalDirectRequest(req, authContext.trustedProxies, authContext.allowRealIpFallback)) {
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

function resolveArtifactRequest(routePath: string) {
  const parts = routePath.split("/").filter(Boolean);
  if (parts[0] !== "artifacts") {
    return null;
  }
  if (parts.length !== 3 && parts.length !== 4) {
    return null;
  }
  const bucket = parts[1] as keyof typeof ARTIFACT_BUCKETS;
  const name = parts[2];
  if (!bucket || !name || name !== path.basename(name)) {
    return null;
  }
  const dirPath = ARTIFACT_BUCKETS[bucket];
  if (!dirPath) {
    return null;
  }
  return {
    bucket,
    dirPath,
    filePath: path.join(dirPath, name),
    isPreview: parts[3] === "preview",
    name,
  };
}

export async function handleMartinaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authContext?: MartinaHttpAuthContext,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    url.pathname !== MARTINA_API_BASE_PATH &&
    !url.pathname.startsWith(`${MARTINA_API_BASE_PATH}/`)
  ) {
    return false;
  }
  if (!(await authorizeMartinaRequest({ req, res, authContext }))) {
    return true;
  }

  const routePath =
    url.pathname === MARTINA_API_BASE_PATH ? "/" : url.pathname.slice(MARTINA_API_BASE_PATH.length);

  try {
    if (routePath === "/health") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      sendMartinaJson(res, 200, {
        ok: true,
        martinaHome: martinaService.paths.home,
        port: null,
      });
      return true;
    }

    if (routePath === "/dashboard") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      sendMartinaJson(res, 200, await martinaService.getDashboard());
      return true;
    }

    if (routePath === "/doctor") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return true;
      }
      const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
      if (body === undefined) {
        return true;
      }
      const request = asRecord(body);
      const command =
        typeof request.command === "string" && request.command.trim()
          ? request.command.trim()
          : "/top-10";
      sendMartinaJson(res, 200, await martinaService.runDoctor(command));
      return true;
    }

    if (routePath === "/runs") {
      if (req.method === "GET") {
        sendMartinaJson(res, 200, martinaService.listRuns());
        return true;
      }
      if (req.method === "POST") {
        const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
        if (body === undefined) {
          return true;
        }
        const request = asRecord(body);
        sendMartinaJson(
          res,
          202,
          await martinaService.startRun({
            message: request.message,
            label: request.label,
          }),
        );
        return true;
      }
      sendMethodNotAllowed(res, "GET, POST");
      return true;
    }

    if (routePath.startsWith("/runs/")) {
      const runId = routePath.slice("/runs/".length);
      if (!runId) {
        sendMartinaJson(res, 404, { error: "run not found" });
        return true;
      }
      if (req.method === "GET") {
        const run = martinaService.getRun(runId);
        if (!run) {
          sendMartinaJson(res, 404, { error: "run not found" });
          return true;
        }
        sendMartinaJson(res, 200, martinaService.serializeRun(run));
        return true;
      }
      if (req.method === "DELETE") {
        const run = martinaService.cancelRun(runId);
        if (!run) {
          sendMartinaJson(res, 404, { error: "run not found" });
          return true;
        }
        sendMartinaJson(res, 200, run);
        return true;
      }
      sendMethodNotAllowed(res, "GET, DELETE");
      return true;
    }

    if (routePath === "/queues/move") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return true;
      }
      const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
      if (body === undefined) {
        return true;
      }
      const request = asRecord(body);
      sendMartinaJson(
        res,
        200,
        await martinaService.moveQueue({
          jobId: request.jobId,
          note: request.note,
          targetQueue: request.targetQueue,
        }),
      );
      return true;
    }

    if (routePath.startsWith("/artifacts/")) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      const artifact = resolveArtifactRequest(routePath);
      if (!artifact) {
        sendMartinaText(res, 404, "Artifact not found");
        return true;
      }
      try {
        if (artifact.isPreview) {
          sendMartinaJson(
            res,
            200,
            await buildArtifactPreview({
              bucket: artifact.bucket,
              filePath: artifact.filePath,
              name: artifact.name,
              apiBasePath: buildMartinaApiPath(),
            }),
          );
          return true;
        }
        const body = await fs.readFile(artifact.filePath);
        res.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${artifact.name}"`,
          "Content-Type": getArtifactMimeType(artifact.name),
        });
        res.end(body);
        return true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          sendMartinaText(res, 404, "Artifact not found");
          return true;
        }
        throw error;
      }
    }

    sendMartinaText(res, 404, "Not Found");
    return true;
  } catch (error) {
    if (isKnownClientError(error)) {
      const status =
        error instanceof Error && error.message.startsWith("Wait for the active Martina run")
          ? 409
          : error instanceof Error && error.message.includes("was not found in master_log.json")
            ? 404
            : 400;
      sendMartinaJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
    sendMartinaJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
