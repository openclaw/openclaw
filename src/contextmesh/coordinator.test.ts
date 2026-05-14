import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { closeContextMeshStoreForTests } from "./store.sqlite.js";
import { startContextMeshCoordinator } from "./coordinator.js";

const tempRoots: string[] = [];

afterEach(() => {
  closeContextMeshStoreForTests();
  delete process.env.OPENCLAW_HOME;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeTempHome() {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-coordinator-"));
  tempRoots.push(root);
  process.env.OPENCLAW_HOME = root;
  return root;
}

describe("contextmesh coordinator", () => {
  it("reuses device pairing and executes assigned work over websocket", async () => {
    const root = makeTempHome();
    const port = 18890;
    const server = await startContextMeshCoordinator({ host: "127.0.0.1", port });
    const identity = loadOrCreateDeviceIdentity(path.join(root, "worker-device.json"));

    try {
      const registerResponse = await fetch(`http://127.0.0.1:${port}/contextmesh/workers/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          name: "test-worker",
          hardwareFingerprint: "fp-test",
          workerVersion: "0.2.0",
          protocolVersion: "1",
          hardware: {
            hostname: "test-worker",
            os: "test",
            cpuModel: "cpu",
            cpuCores: 4,
            ramMb: 1024,
            cudaAvailable: false,
            ollamaAvailable: false,
            llamaCppAvailable: false,
            embeddingModelAvailable: false,
          },
        }),
      });
      const registerJson = (await registerResponse.json()) as {
        workerId: string;
      };

      const approveResponse = await fetch(`http://127.0.0.1:${port}/contextmesh/workers/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: registerJson.workerId }),
      });
      const approveJson = (await approveResponse.json()) as {
        deviceToken: string;
      };

      const ws = new WebSocket(`ws://127.0.0.1:${port}/contextmesh/ws`);
      const completed = new Promise<void>((resolve, reject) => {
        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              type: "worker_hello",
              workerId: registerJson.workerId,
              deviceId: identity.deviceId,
              deviceToken: approveJson.deviceToken,
              name: "test-worker",
              workerVersion: "0.2.0",
              protocolVersion: "1",
              hardwareFingerprint: "fp-test",
              hardware: {
                hostname: "test-worker",
                os: "test",
                cpuModel: "cpu",
                cpuCores: 4,
                ramMb: 1024,
                cudaAvailable: false,
                ollamaAvailable: false,
                llamaCppAvailable: false,
                embeddingModelAvailable: false,
              },
            }),
          );
        });

        ws.on("message", async (raw) => {
          const message = JSON.parse(String(raw)) as {
            type: string;
            task?: { id: string };
          };
          if (message.type === "worker_hello_ack") {
            await fetch(`http://127.0.0.1:${port}/contextmesh/jobs`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(450),
                mode: "summarize",
                distributed: true,
              }),
            });
            ws.send(JSON.stringify({ type: "worker_task_request", workerId: registerJson.workerId }));
            return;
          }
          if (message.type === "coordinator_task_assign" && message.task) {
            ws.send(
              JSON.stringify({
                type: "worker_task_complete",
                workerId: registerJson.workerId,
                taskId: message.task.id,
                result: { summary: "distributed-ok" },
                latencyMs: 20,
              }),
            );
            const statusResponse = await fetch(`http://127.0.0.1:${port}/contextmesh/status`);
            const statusJson = (await statusResponse.json()) as {
              jobs: Array<{ status: string }>;
            };
            if (statusJson.jobs.some((job) => job.status === "completed")) {
              resolve();
              ws.close();
            } else {
              ws.send(JSON.stringify({ type: "worker_task_request", workerId: registerJson.workerId }));
            }
          }
        });
        ws.on("error", reject);
      });

      await completed;

      const workersResponse = await fetch(`http://127.0.0.1:${port}/contextmesh/workers`);
      const workersJson = (await workersResponse.json()) as {
        workers: Array<{ status: string }>;
      };
      expect(workersJson.workers[0]?.status).toBe("online");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
