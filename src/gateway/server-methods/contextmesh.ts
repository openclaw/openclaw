import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { approveDevicePairing, ensureDeviceToken } from "../../infra/device-pairing.js";
import { chunkText } from "../../contextmesh/chunking.js";
import { maskSensitiveText } from "../../contextmesh/masking.js";
import { processTask } from "../../contextmesh/processing.js";
import { loadContextMeshState, saveContextMeshState } from "../../contextmesh/state.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const contextmeshHandlers: GatewayRequestHandlers = {
  "contextmesh.status": async ({ respond }) => {
    const state = await loadContextMeshState();
    respond(true, { status: "ok", metrics: state.metrics, jobs: state.jobs }, undefined);
  },
  "contextmesh.dashboard": async ({ respond }) => {
    const state = await loadContextMeshState();
    respond(
      true,
      {
        metrics: state.metrics,
        workers: state.workers,
        jobs: state.jobs.slice(-10).reverse(),
        activeTasks: state.tasks.filter((task) => task.status === "assigned"),
      },
      undefined,
    );
  },
  "contextmesh.workers": async ({ respond }) => {
    const state = await loadContextMeshState();
    respond(true, { workers: state.workers }, undefined);
  },
  "contextmesh.worker.approve": async ({ params, respond, context }) => {
    if (
      !isRecord(params) ||
      (typeof params.workerId !== "string" && typeof params.requestId !== "string")
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "workerId or requestId required"),
      );
      return;
    }
    const state = await loadContextMeshState();
    const worker =
      typeof params.workerId === "string"
        ? state.workers.find((entry) => entry.id === params.workerId)
        : state.workers.find((entry) => entry.pairingRequestId === params.requestId);
    if (!worker) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "worker not found"));
      return;
    }
    if (!worker.pairingRequestId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "worker has no pending pairing"));
      return;
    }
    const approved = await approveDevicePairing(worker.pairingRequestId);
    if (!approved || approved.status !== "approved") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "pairing approval failed"));
      return;
    }
    const token = await ensureDeviceToken({
      deviceId: worker.deviceId,
      role: "contextmesh",
      scopes: ["contextmesh.worker"],
    });
    worker.status = "approved";
    worker.approvedAt = nowIso();
    worker.authTokenIssuedAtMs = token?.rotatedAtMs ?? token?.createdAtMs;
    await saveContextMeshState(state);
    context.broadcast(
      "contextmesh.worker.approved",
      { workerId: worker.id, deviceId: worker.deviceId, ts: Date.now() },
      { dropIfSlow: true },
    );
    respond(
      true,
      { approved: true, workerId: worker.id, deviceId: worker.deviceId, deviceToken: token?.token },
      undefined,
    );
  },
  "contextmesh.submit": async ({ params, respond }) => {
    if (!isRecord(params) || typeof params.mode !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "mode required"));
      return;
    }
    const text =
      typeof params.text === "string"
        ? params.text
        : typeof params.file === "string"
          ? await readFile(params.file, "utf8")
          : "";
    const state = await loadContextMeshState();
    const redacted = maskSensitiveText(text).maskedText;
    const chunks = chunkText(redacted, {
      maxChunkTokens: state.config.maxChunkTokens,
      overlapTokens: 120,
    });
    const jobId = randomUUID();
    const createdAt = nowIso();
    state.jobs.push({
      id: jobId,
      mode: params.mode as never,
      status: "completed",
      createdAt,
      updatedAt: createdAt,
      sourceFile: typeof params.file === "string" ? params.file : undefined,
      question: typeof params.question === "string" ? params.question : undefined,
      distributed: state.workers.some((worker) => worker.status === "online"),
      totalChunks: chunks.length,
      completedChunks: chunks.length,
      failedChunks: 0,
      output: chunks
        .map((chunk) =>
          processTask({
            taskType: "summarize_chunk",
            text: chunk.text,
            query: typeof params.question === "string" ? params.question : undefined,
          }).summary ?? "",
        )
        .join("\n\n"),
    });
    state.metrics.totalJobs = state.jobs.length;
    state.metrics.completedTasks += chunks.length;
    await saveContextMeshState(state);
    respond(
      true,
      {
        jobId,
        chunks: chunks.length,
        distributed: state.workers.some((worker) => worker.status === "online"),
      },
      undefined,
    );
  },
};
