import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { processTask } from "./processing.js";
import type {
  ContextMeshCoordinatorSocketMessage,
  ContextMeshWorkerHello,
  ContextMeshWorkerSocketMessage,
} from "./types.js";

async function postJson(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await response.json();
}

function resolveWorkerBaseUrl(coordinator: string): URL {
  return new URL(coordinator.endsWith("/") ? coordinator : `${coordinator}/`);
}

function resolveWorkerSocketUrl(coordinator: string): string {
  const base = resolveWorkerBaseUrl(coordinator);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/contextmesh/ws";
  base.search = "";
  return base.toString();
}

export async function startContextMeshWorker(params: {
  coordinator: string;
  name: string;
  deviceIdentityPath?: string;
}) {
  const identity = loadOrCreateDeviceIdentity(
    params.deviceIdentityPath ??
      path.join(process.cwd(), ".contextmesh", `${params.name.replace(/\s+/g, "-").toLowerCase()}.device.json`),
  );
  const registerResult = await postJson(
    `${resolveWorkerBaseUrl(params.coordinator).toString().replace(/\/$/, "")}/contextmesh/workers/register`,
    {
      name: params.name,
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      hardwareFingerprint: `${os.hostname()}-${os.platform()}-${os.arch()}`,
      workerVersion: "0.2.0",
      protocolVersion: "1",
      hardware: {
        hostname: os.hostname(),
        os: `${os.platform()} ${os.release()}`,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        cpuCores: os.cpus().length,
        ramMb: Math.floor(os.totalmem() / (1024 * 1024)),
        cudaAvailable: false,
        ollamaAvailable: false,
        llamaCppAvailable: false,
        embeddingModelAvailable: false,
      },
    },
  );
  return {
    ...registerResult,
    deviceId: identity.deviceId,
    identityPath:
      params.deviceIdentityPath ??
      path.join(process.cwd(), ".contextmesh", `${params.name.replace(/\s+/g, "-").toLowerCase()}.device.json`),
  };
}

export async function runApprovedContextMeshWorker(params: {
  coordinator: string;
  workerId: string;
  deviceToken: string;
  name: string;
  deviceIdentityPath?: string;
}) {
  const identity = loadOrCreateDeviceIdentity(
    params.deviceIdentityPath ??
      path.join(process.cwd(), ".contextmesh", `${params.name.replace(/\s+/g, "-").toLowerCase()}.device.json`),
  );
  const socket = new WebSocket(resolveWorkerSocketUrl(params.coordinator));
  const hello: ContextMeshWorkerHello = {
    type: "worker_hello",
    workerId: params.workerId,
    deviceId: identity.deviceId,
    deviceToken: params.deviceToken,
    name: params.name,
    workerVersion: "0.2.0",
    protocolVersion: "1",
    hardwareFingerprint: `${os.hostname()}-${os.platform()}-${os.arch()}`,
    hardware: {
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpuCores: os.cpus().length,
      ramMb: Math.floor(os.totalmem() / (1024 * 1024)),
      cudaAvailable: false,
      ollamaAvailable: false,
      llamaCppAvailable: false,
      embeddingModelAvailable: false,
    },
  };

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify(hello));
      resolve();
    });
    socket.once("error", reject);
  });

  socket.on("message", async (raw) => {
    const message = JSON.parse(String(raw)) as ContextMeshCoordinatorSocketMessage;
    if (message.type === "worker_hello_ack") {
      if (!message.accepted) {
        throw new Error(`ContextMesh worker rejected: ${message.reason ?? "unknown"}`);
      }
      const heartbeatEveryMs = message.heartbeatIntervalMs ?? 2_000;
      setInterval(() => {
        const heartbeat: ContextMeshWorkerSocketMessage = {
          type: "worker_heartbeat",
          workerId: params.workerId,
        };
        socket.send(JSON.stringify(heartbeat));
      }, heartbeatEveryMs).unref();
      const request: ContextMeshWorkerSocketMessage = {
        type: "worker_task_request",
        workerId: params.workerId,
      };
      socket.send(JSON.stringify(request));
      return;
    }
    if (message.type !== "coordinator_task_assign") {
      return;
    }
    if (!message.task) {
      setTimeout(() => {
        const request: ContextMeshWorkerSocketMessage = {
          type: "worker_task_request",
          workerId: params.workerId,
        };
        socket.send(JSON.stringify(request));
      }, 1_000).unref();
      return;
    }
    const startedAt = Date.now();
    try {
      const result = processTask({
        taskType: message.task.type,
        text: message.task.payload?.text,
        query: message.task.payload?.query,
        chunks: message.task.payload?.chunks,
      });
      const complete: ContextMeshWorkerSocketMessage = {
        type: "worker_task_complete",
        workerId: params.workerId,
        taskId: message.task.id,
        result,
        latencyMs: Date.now() - startedAt,
      };
      socket.send(JSON.stringify(complete));
    } catch (error) {
      const failed: ContextMeshWorkerSocketMessage = {
        type: "worker_task_failed",
        workerId: params.workerId,
        taskId: message.task.id,
        error: error instanceof Error ? error.message : String(error),
      };
      socket.send(JSON.stringify(failed));
    }
    const request: ContextMeshWorkerSocketMessage = {
      type: "worker_task_request",
      workerId: params.workerId,
    };
    socket.send(JSON.stringify(request));
  });

  await new Promise(() => {});
}
