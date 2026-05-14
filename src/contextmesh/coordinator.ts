import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
  verifyDeviceToken,
} from "../infra/device-pairing.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../tasks/detached-task-runtime.js";
import { chunkText } from "./chunking.js";
import { maskSensitiveText } from "./masking.js";
import { processTask } from "./processing.js";
import {
  appendContextMeshBenchmarkResult,
  listContextMeshBenchmarkResults,
} from "./store.sqlite.js";
import { loadContextMeshState, saveContextMeshState } from "./state.js";
import type {
  ContextMeshCoordinatorSocketMessage,
  ContextMeshJobMode,
  ContextMeshJobRecord,
  ContextMeshState,
  ContextMeshTaskRecord,
  ContextMeshTaskType,
  ContextMeshWorkerHardware,
  ContextMeshWorkerSocketMessage,
} from "./types.js";

const CONTEXTMESH_ROLE = "contextmesh";
const CONTEXTMESH_SCOPES = ["contextmesh.worker"];

type WorkerRegisterBody = {
  deviceId: string;
  publicKey: string;
  name: string;
  hardware: ContextMeshWorkerHardware;
  hardwareFingerprint: string;
  workerVersion: string;
  protocolVersion?: string;
};

type WorkerSession = {
  socket: WebSocket;
  workerId: string;
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

function summarizeTaskTypeForMode(mode: ContextMeshJobMode): ContextMeshTaskType {
  switch (mode) {
    case "qa":
      return "question_answer_over_chunks";
    case "compress":
      return "context_compression";
    case "keywords":
      return "extract_keywords";
    case "entities":
      return "extract_entities";
    case "semantic_search":
      return "semantic_search";
    case "summarize":
    default:
      return "summarize_chunk";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sendSocket(socket: WebSocket, payload: ContextMeshCoordinatorSocketMessage): void {
  socket.send(JSON.stringify(payload));
}

function rebuildMetrics(state: ContextMeshState): void {
  const onlineWorkers = state.workers.filter((worker) => worker.status === "online");
  const completedTasks = state.tasks.filter((task) => task.status === "completed");
  state.metrics.connectedWorkers = onlineWorkers.length;
  state.metrics.activeWorkers = state.workers.filter((worker) => worker.currentTaskId).length;
  state.metrics.totalJobs = state.jobs.length;
  state.metrics.activeJobs = state.jobs.filter((job) => job.status === "running").length;
  state.metrics.completedTasks = completedTasks.length;
  state.metrics.failedTasks = state.tasks.filter((task) => task.status === "failed").length;
  state.metrics.estimatedTokensProcessed = state.tasks.reduce(
    (sum, task) => sum + Number(task.payload.estimatedTokens ?? 0),
    0,
  );
  state.metrics.averageTaskLatencyMs =
    completedTasks.length > 0
      ? Math.round(
          state.workers.reduce((sum, worker) => sum + worker.averageLatencyMs, 0) /
            Math.max(1, state.workers.length),
        )
      : 0;
  state.metrics.estimatedTokensPerSecond = Number(
    onlineWorkers.reduce((sum, worker) => sum + worker.chunksPerSecond * 700, 0).toFixed(2),
  );
}

function updateJobOutput(state: ContextMeshState, job: ContextMeshJobRecord): void {
  job.output = state.tasks
    .filter((entry) => entry.jobId === job.id)
    .map((entry) => {
      const result = entry.result as { summary?: string; answer?: string; compressed?: string };
      return result?.summary ?? result?.answer ?? result?.compressed ?? "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function assignLocalFallback(task: ContextMeshTaskRecord): void {
  const result = processTask({
    taskType: task.type,
    text: task.payload.text,
    query: task.payload.query,
    chunks: task.payload.chunks,
  });
  task.status = "completed";
  task.result = result;
  task.updatedAt = nowIso();
}

export async function startContextMeshCoordinator(params: { host: string; port: number }) {
  let state = await loadContextMeshState();
  const workerSessions = new Map<string, WorkerSession>();

  async function persist() {
    rebuildMetrics(state);
    await saveContextMeshState(state);
  }

  function findWorkerById(workerId: string) {
    return state.workers.find((entry) => entry.id === workerId);
  }

  function completeJobIfDone(jobId: string): void {
    const job = state.jobs.find((entry) => entry.id === jobId);
    if (!job) {
      return;
    }
    const jobTasks = state.tasks.filter((entry) => entry.jobId === jobId);
    job.completedChunks = jobTasks.filter((entry) => entry.status === "completed").length;
    job.failedChunks = jobTasks.filter((entry) => entry.status === "failed").length;
    job.updatedAt = nowIso();
    if (job.completedChunks >= job.totalChunks) {
      job.status = "completed";
      job.taskLedgerStatus = "succeeded";
      updateJobOutput(state, job);
      if (job.runId) {
        finalizeTaskRunByRunId({
          runId: job.runId,
          status: "succeeded",
          endedAt: nowMs(),
          lastEventAt: nowMs(),
          progressSummary: `Completed ${job.completedChunks}/${job.totalChunks} distributed chunks`,
          terminalSummary: `ContextMesh completed ${job.mode} job across ${job.totalChunks} chunks`,
        });
      }
      return;
    }
    if (job.failedChunks > 0 && job.failedChunks + job.completedChunks >= job.totalChunks) {
      job.status = "failed";
      job.taskLedgerStatus = "failed";
      if (job.runId) {
        finalizeTaskRunByRunId({
          runId: job.runId,
          status: "failed",
          endedAt: nowMs(),
          lastEventAt: nowMs(),
          error: `ContextMesh job ${job.id} failed on ${job.failedChunks} chunks`,
          progressSummary: `Completed ${job.completedChunks}/${job.totalChunks} chunks`,
          terminalSummary: `ContextMesh failed ${job.mode} job`,
        });
      }
    }
  }

  async function authorizeWorker(deviceId: string, deviceToken: string): Promise<boolean> {
    const result = await verifyDeviceToken({
      deviceId,
      token: deviceToken,
      role: CONTEXTMESH_ROLE,
      scopes: CONTEXTMESH_SCOPES,
    });
    return result.ok;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${params.host}:${params.port}`);
    if (req.method === "GET" && url.pathname === "/contextmesh/status") {
      writeJson(res, 200, { status: "ok", metrics: state.metrics, jobs: state.jobs });
      return;
    }
    if (req.method === "GET" && url.pathname === "/contextmesh/workers") {
      writeJson(res, 200, { workers: state.workers });
      return;
    }
    if (req.method === "GET" && url.pathname === "/contextmesh/metrics") {
      writeJson(res, 200, state.metrics);
      return;
    }
    if (req.method === "GET" && url.pathname === "/contextmesh/dashboard") {
      writeJson(res, 200, {
        metrics: state.metrics,
        workers: state.workers,
        jobs: state.jobs.slice(-10).reverse(),
        activeTasks: state.tasks.filter((task) => task.status === "assigned"),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/contextmesh/benchmarks") {
      writeJson(res, 200, { benchmarks: listContextMeshBenchmarkResults() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/contextmesh/audit") {
      writeJson(res, 200, { audit: state.audit });
      return;
    }
    if (req.method === "POST" && url.pathname === "/contextmesh/workers/register") {
      const body = (await readJson(req)) as WorkerRegisterBody;
      if (
        !body?.deviceId ||
        !body?.publicKey ||
        !body?.name ||
        !body?.hardwareFingerprint ||
        !body?.workerVersion ||
        !body?.hardware
      ) {
        writeJson(res, 400, { error: "invalid_worker_registration" });
        return;
      }
      const pairing = await requestDevicePairing({
        deviceId: body.deviceId,
        publicKey: body.publicKey,
        displayName: body.name,
        platform: body.hardware.os,
        deviceFamily: "contextmesh-worker",
        clientId: "openclaw-contextmesh-worker",
        clientMode: "backend",
        role: CONTEXTMESH_ROLE,
        roles: [CONTEXTMESH_ROLE],
        scopes: CONTEXTMESH_SCOPES,
        silent: false,
      });
      let worker = state.workers.find((entry) => entry.deviceId === body.deviceId);
      if (!worker) {
        worker = {
          id: randomUUID(),
          name: body.name,
          deviceId: body.deviceId,
          pairingRequestId: pairing.request.requestId,
          status: "pending",
          scopes: CONTEXTMESH_SCOPES,
          hardware: body.hardware,
          hardwareFingerprint: body.hardwareFingerprint,
          protocolVersion: body.protocolVersion ?? state.config.protocolVersion,
          workerVersion: body.workerVersion,
          completedTasks: 0,
          failedTasks: 0,
          averageLatencyMs: 0,
          chunksPerSecond: 0,
        };
        state.workers.push(worker);
      } else {
        worker.name = body.name;
        worker.status = worker.approvedAt ? "approved" : "pending";
        worker.pairingRequestId = pairing.request.requestId;
        worker.hardware = body.hardware;
        worker.hardwareFingerprint = body.hardwareFingerprint;
        worker.workerVersion = body.workerVersion;
        worker.protocolVersion = body.protocolVersion ?? worker.protocolVersion;
      }
      await persist();
      writeJson(res, 200, {
        pending: true,
        workerId: worker.id,
        requestId: pairing.request.requestId,
        deviceId: body.deviceId,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/contextmesh/workers/approve") {
      const body = (await readJson(req)) as { workerId?: string; requestId?: string };
      if (!body?.workerId && !body?.requestId) {
        writeJson(res, 400, { error: "workerId_or_requestId_required" });
        return;
      }
      const worker = body.workerId ? findWorkerById(body.workerId) : state.workers.find((entry) => entry.pairingRequestId === body.requestId);
      if (!worker || !worker.pairingRequestId) {
        writeJson(res, 404, { error: "worker_not_found" });
        return;
      }
      const approved = await approveDevicePairing(worker.pairingRequestId);
      if (!approved || approved.status !== "approved") {
        writeJson(res, 400, { error: "pairing_approval_failed" });
        return;
      }
      const token = await ensureDeviceToken({
        deviceId: worker.deviceId,
        role: CONTEXTMESH_ROLE,
        scopes: CONTEXTMESH_SCOPES,
      });
      worker.status = "approved";
      worker.approvedAt = nowIso();
      worker.authTokenIssuedAtMs = token?.rotatedAtMs ?? token?.createdAtMs;
      await persist();
      writeJson(res, 200, {
        approved: true,
        workerId: worker.id,
        deviceId: worker.deviceId,
        deviceToken: token?.token,
        requestId: worker.pairingRequestId,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/contextmesh/jobs") {
      const body = (await readJson(req)) as {
        file?: string;
        text?: string;
        mode: ContextMeshJobMode;
        question?: string;
        distributed?: boolean;
      };
      const rawText = body.text ?? (body.file ? await readFile(body.file, "utf8") : "");
      const redacted = maskSensitiveText(rawText).maskedText;
      const chunks = chunkText(redacted, {
        maxChunkTokens: state.config.maxChunkTokens,
        overlapTokens: 120,
      });
      const jobId = randomUUID();
      const runId = randomUUID();
      const createdAt = nowIso();
      createRunningTaskRun({
        runtime: "cli",
        scopeKind: "system",
        runId,
        taskKind: "contextmesh.job",
        sourceId: "contextmesh",
        label: `ContextMesh ${body.mode}`,
        task: `ContextMesh ${body.mode} job with ${chunks.length} chunks`,
        startedAt: nowMs(),
        lastEventAt: nowMs(),
        progressSummary: `Prepared ${chunks.length} chunks`,
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      const job: ContextMeshJobRecord = {
        id: jobId,
        runId,
        mode: body.mode,
        status: "running",
        createdAt,
        updatedAt: createdAt,
        sourceFile: body.file,
        question: body.question,
        distributed: body.distributed !== false,
        totalChunks: chunks.length,
        completedChunks: 0,
        failedChunks: 0,
        taskLedgerStatus: "running",
      };
      state.jobs.push(job);
      const taskType = summarizeTaskTypeForMode(body.mode);
      for (const chunk of chunks) {
        state.tasks.push({
          id: randomUUID(),
          jobId,
          type: taskType,
          status: "queued",
          attempt: 0,
          createdAt,
          updatedAt: createdAt,
          payload: {
            chunkId: chunk.id,
            text: chunk.text,
            query: body.question,
            estimatedTokens: chunk.estimatedTokens,
          },
        });
      }
      const onlineWorkers = state.workers.some((worker) => worker.status === "online");
      if (!onlineWorkers || body.distributed === false) {
        for (const task of state.tasks.filter((entry) => entry.jobId === jobId)) {
          assignLocalFallback(task);
        }
        completeJobIfDone(jobId);
      }
      await persist();
      writeJson(res, 200, { jobId, runId, chunks: chunks.length, distributed: onlineWorkers });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/contextmesh/jobs/")) {
      const jobId = url.pathname.split("/").pop() ?? "";
      const job = state.jobs.find((entry) => entry.id === jobId);
      if (!job) {
        writeJson(res, 404, { error: "job_not_found" });
        return;
      }
      const tasks = state.tasks.filter((entry) => entry.jobId === jobId);
      writeJson(res, 200, { job, tasks });
      return;
    }
    if (req.method === "POST" && url.pathname === "/contextmesh/benchmarks") {
      const body = (await readJson(req)) as Record<string, unknown>;
      appendContextMeshBenchmarkResult(body);
      writeJson(res, 200, { ok: true });
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  });

  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${params.host}:${params.port}`);
    if (url.pathname !== "/contextmesh/ws") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit("connection", ws, req);
    });
  });

  wsServer.on("connection", (socket) => {
    let boundWorkerId: string | null = null;

    socket.on("message", async (raw) => {
      let message: ContextMeshWorkerSocketMessage | null = null;
      try {
        message = JSON.parse(String(raw)) as ContextMeshWorkerSocketMessage;
      } catch {
        sendSocket(socket, {
          type: "worker_hello_ack",
          workerId: "",
          accepted: false,
          reason: "invalid_json",
        });
        socket.close();
        return;
      }

      if (!message || !isRecord(message) || typeof message.type !== "string") {
        socket.close();
        return;
      }

      if (message.type === "worker_hello") {
        const worker = findWorkerById(message.workerId);
        if (!worker || worker.deviceId !== message.deviceId) {
          sendSocket(socket, {
            type: "worker_hello_ack",
            workerId: message.workerId,
            accepted: false,
            reason: "worker_not_registered",
          });
          socket.close();
          return;
        }
        const authorized = await authorizeWorker(message.deviceId, message.deviceToken);
        if (!authorized) {
          sendSocket(socket, {
            type: "worker_hello_ack",
            workerId: message.workerId,
            accepted: false,
            reason: "device_token_invalid",
          });
          socket.close();
          return;
        }
        worker.name = message.name;
        worker.status = "online";
        worker.lastHeartbeatAt = nowIso();
        worker.workerVersion = message.workerVersion;
        worker.protocolVersion = message.protocolVersion;
        worker.hardware = message.hardware;
        worker.hardwareFingerprint = message.hardwareFingerprint;
        boundWorkerId = worker.id;
        workerSessions.set(worker.id, { socket, workerId: worker.id });
        await persist();
        sendSocket(socket, {
          type: "worker_hello_ack",
          workerId: worker.id,
          accepted: true,
          heartbeatIntervalMs: Math.min(5_000, state.config.heartbeatTimeoutMs / 2),
        });
        return;
      }

      if (!boundWorkerId || message.workerId !== boundWorkerId) {
        socket.close();
        return;
      }

      const worker = findWorkerById(boundWorkerId);
      if (!worker) {
        socket.close();
        return;
      }

      if (message.type === "worker_heartbeat") {
        worker.status = "online";
        worker.lastHeartbeatAt = nowIso();
        await persist();
        return;
      }

      if (message.type === "worker_task_request") {
        const task = state.tasks.find((entry) => entry.status === "queued");
        if (!task) {
          sendSocket(socket, { type: "coordinator_task_assign", task: null });
          return;
        }
        task.status = "assigned";
        task.assignedWorkerId = worker.id;
        task.attempt += 1;
        task.updatedAt = nowIso();
        task.timeoutAt = new Date(nowMs() + state.config.taskTimeoutMs).toISOString();
        worker.currentTaskId = task.id;
        worker.currentTaskType = task.type;
        state.audit.push({
          id: randomUUID(),
          createdAt: nowIso(),
          workerId: worker.id,
          taskId: task.id,
          jobId: task.jobId,
          taskType: task.type,
          redactedPreview: String(task.payload.text ?? "").slice(0, 180),
        });
        await persist();
        sendSocket(socket, { type: "coordinator_task_assign", task });
        return;
      }

      if (message.type === "worker_task_complete") {
        const task = state.tasks.find((entry) => entry.id === message.taskId);
        if (!task || task.assignedWorkerId !== worker.id) {
          return;
        }
        task.status = "completed";
        task.result = message.result;
        task.updatedAt = nowIso();
        worker.currentTaskId = undefined;
        worker.currentTaskType = undefined;
        worker.lastHeartbeatAt = nowIso();
        worker.completedTasks += 1;
        if (typeof message.latencyMs === "number" && message.latencyMs > 0) {
          const previousCount = Math.max(0, worker.completedTasks - 1);
          worker.averageLatencyMs = Math.round(
            ((worker.averageLatencyMs * previousCount) + message.latencyMs) / worker.completedTasks,
          );
          const estimatedTokens = Math.max(1, Number(task.payload.estimatedTokens ?? 700));
          worker.chunksPerSecond = Number(
            (((estimatedTokens / 700) * 1000) / message.latencyMs).toFixed(2),
          );
        }
        const job = state.jobs.find((entry) => entry.id === task.jobId);
        if (job?.runId) {
          const completedCount = state.tasks.filter(
            (entry) => entry.jobId === job.id && entry.status === "completed",
          ).length;
          recordTaskRunProgressByRunId({
            runId: job.runId,
            lastEventAt: nowMs(),
            progressSummary: `Completed ${completedCount}/${job.totalChunks} chunks`,
          });
        }
        completeJobIfDone(task.jobId);
        await persist();
        return;
      }

      if (message.type === "worker_task_failed") {
        const task = state.tasks.find((entry) => entry.id === message.taskId);
        if (!task || task.assignedWorkerId !== worker.id) {
          return;
        }
        worker.currentTaskId = undefined;
        worker.currentTaskType = undefined;
        worker.failedTasks += 1;
        worker.lastError = message.error;
        task.error = message.error;
        task.updatedAt = nowIso();
        if (task.attempt < 3) {
          task.status = "queued";
          task.assignedWorkerId = undefined;
          state.metrics.retries += 1;
        } else {
          task.status = "failed";
        }
        completeJobIfDone(task.jobId);
        await persist();
      }
    });

    socket.on("close", async () => {
      if (!boundWorkerId) {
        return;
      }
      workerSessions.delete(boundWorkerId);
      const worker = findWorkerById(boundWorkerId);
      if (worker) {
        worker.status = "offline";
        worker.currentTaskId = undefined;
        worker.currentTaskType = undefined;
        worker.lastHeartbeatAt = nowIso();
        await persist();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(params.port, params.host, resolve));
  return server;
}
