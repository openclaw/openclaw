import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultContextMeshState } from "./defaults.js";
import {
  appendContextMeshBenchmarkResult,
  closeContextMeshStoreForTests,
  listContextMeshBenchmarkResults,
  loadContextMeshStateFromSqlite,
  saveContextMeshStateToSqlite,
} from "./store.sqlite.js";

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
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-store-"));
  tempRoots.push(root);
  process.env.OPENCLAW_HOME = root;
}

describe("contextmesh sqlite store", () => {
  it("persists state records", () => {
    makeTempHome();
    const state = defaultContextMeshState();
    state.workers.push({
      id: "worker-1",
      name: "laptop-1",
      deviceId: "device-1",
      status: "approved",
      scopes: ["contextmesh.worker"],
      hardwareFingerprint: "fp-1",
      hardware: {
        hostname: "laptop-1",
        os: "Windows 11",
        cpuModel: "CPU",
        cpuCores: 8,
        ramMb: 16000,
        cudaAvailable: false,
        ollamaAvailable: false,
        llamaCppAvailable: false,
        embeddingModelAvailable: false,
      },
      protocolVersion: "contextmesh-v1",
      workerVersion: "0.1.0",
      completedTasks: 3,
      failedTasks: 0,
      averageLatencyMs: 10,
      chunksPerSecond: 2,
    });
    state.jobs.push({
      id: "job-1",
      mode: "summarize",
      status: "completed",
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      distributed: true,
      totalChunks: 1,
      completedChunks: 1,
      failedChunks: 0,
    });
    state.tasks.push({
      id: "task-1",
      jobId: "job-1",
      type: "summarize_chunk",
      status: "completed",
      attempt: 1,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      payload: { text: "hello" },
    });
    state.audit.push({
      id: "audit-1",
      createdAt: "2026-05-13T00:00:00.000Z",
      workerId: "worker-1",
      taskId: "task-1",
      jobId: "job-1",
      taskType: "summarize_chunk",
      redactedPreview: "hello",
    });
    saveContextMeshStateToSqlite(state);
    const restored = loadContextMeshStateFromSqlite();
    expect(restored.workers).toHaveLength(1);
    expect(restored.jobs).toHaveLength(1);
    expect(restored.tasks).toHaveLength(1);
    expect(restored.audit).toHaveLength(1);
  });

  it("persists benchmark history", () => {
    makeTempHome();
    appendContextMeshBenchmarkResult({
      benchmarkId: "bench-1",
      createdAt: "2026-05-13T00:00:00.000Z",
      speedup: 2,
    });
    const rows = listContextMeshBenchmarkResults();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.benchmarkId).toBe("bench-1");
  });
});
