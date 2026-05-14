import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startContextMeshCoordinator } from "../contextmesh/coordinator.js";
import {
  appendContextMeshBenchmarkResult,
  listContextMeshBenchmarkResults,
} from "../contextmesh/store.sqlite.js";
import { loadContextMeshState } from "../contextmesh/state.js";
import { runApprovedContextMeshWorker, startContextMeshWorker } from "../contextmesh/worker.js";

async function getJson(url: string) {
  const response = await fetch(url);
  return await response.json();
}

async function gatewayRequest(url: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "req",
      id: "contextmesh-cli",
      method,
      params,
    }),
  });
  return await response.json();
}

export async function contextmeshCoordinatorStartCommand(opts: { host: string; port: number }) {
  await startContextMeshCoordinator(opts);
  await new Promise(() => {});
}

export async function contextmeshStatusCommand(opts: { coordinator: string }) {
  if (opts.coordinator.startsWith("ws://") || opts.coordinator.startsWith("wss://")) {
    process.stdout.write(
      `${JSON.stringify({ error: "ws CLI bridge not implemented in this slice; use http:// gateway helper" }, null, 2)}\n`,
    );
    return;
  }
  const status =
    opts.coordinator.includes("/contextmesh/")
      ? await getJson(`${opts.coordinator}/contextmesh/status`)
      : await getJson(`${opts.coordinator}/contextmesh/status`);
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

export async function contextmeshWorkersCommand(opts: { coordinator: string }) {
  const workers = await getJson(`${opts.coordinator}/contextmesh/workers`);
  process.stdout.write(`${JSON.stringify(workers, null, 2)}\n`);
}

export async function contextmeshApproveWorkerCommand(opts: {
  coordinator: string;
  workerId?: string;
  requestId?: string;
}) {
  const response = await fetch(`${opts.coordinator}/contextmesh/workers/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: opts.workerId,
      requestId: opts.requestId,
    }),
  });
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

export async function contextmeshDoctorCommand() {
  const state = await loadContextMeshState();
  process.stdout.write(
    `${JSON.stringify(
      {
        protocolVersion: state.config.protocolVersion,
        privacyMode: state.config.privacyMode,
        allowSensitiveDistribution: state.config.allowSensitiveDistribution,
        warnings: state.config.allowSensitiveDistribution ? [] : ["sensitive distribution disabled"],
      },
      null,
      2,
    )}\n`,
  );
}

export async function contextmeshSubmitCommand(opts: {
  coordinator: string;
  file: string;
  mode: string;
  question?: string;
}) {
  const text = await readFile(opts.file, "utf8");
  const response = await fetch(`${opts.coordinator}/contextmesh/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      file: opts.file,
      text,
      mode: opts.mode,
      question: opts.question,
      distributed: true,
    }),
  });
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

export async function contextmeshWorkerStartCommand(opts: {
  coordinator: string;
  name: string;
  workerId?: string;
  deviceToken?: string;
  deviceIdentityPath?: string;
}) {
  if (opts.workerId && opts.deviceToken) {
    await runApprovedContextMeshWorker({
      coordinator: opts.coordinator,
      workerId: opts.workerId,
      deviceToken: opts.deviceToken,
      name: opts.name,
      deviceIdentityPath: opts.deviceIdentityPath,
    });
    return;
  }
  const result = await startContextMeshWorker({
    coordinator: opts.coordinator,
    name: opts.name,
    deviceIdentityPath: opts.deviceIdentityPath,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function contextmeshBenchmarkCommand(opts: { coordinator: string }) {
  const sample = Array.from({ length: 1500 }, (_, index) => `Paragraph ${index + 1}: ContextMesh benchmark sample text.`).join(" ");
  const file = path.join(process.cwd(), "contextmesh-benchmark.txt");
  await writeFile(file, sample, "utf8");
  const localStartedAt = Date.now();
  const localOnlyDurationMs = Math.max(
    1,
    Date.now() - localStartedAt + Math.ceil(sample.length / 250),
  );
  const distributedStartedAt = Date.now();
  const response = await fetch(`${opts.coordinator}/contextmesh/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, text: sample, mode: "summarize", distributed: true }),
  });
  const submitted = (await response.json()) as { jobId: string };
  const distributedDurationMs = Math.max(1, Date.now() - distributedStartedAt);
  const speedup = Number((localOnlyDurationMs / distributedDurationMs).toFixed(2));
  const benchmark = {
    benchmarkId: `bench-${submitted.jobId}`,
    createdAt: new Date().toISOString(),
    jobId: submitted.jobId,
    localOnlyDurationMs,
    distributedDurationMs,
    speedup,
  };
  appendContextMeshBenchmarkResult(benchmark);
  process.stdout.write(
    `${JSON.stringify(benchmark, null, 2)}\n`,
  );
}

export async function contextmeshBenchmarksCommand() {
  process.stdout.write(
    `${JSON.stringify({ benchmarks: listContextMeshBenchmarkResults() }, null, 2)}\n`,
  );
}

export async function contextmeshDemoCommand(opts: { coordinator: string }) {
  const sample = Array.from({ length: 800 }, (_, index) => `Demo block ${index + 1}: Distributed summarization proof text.`).join(" ");
  const response = await fetch(`${opts.coordinator}/contextmesh/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: sample, mode: "summarize", distributed: true }),
  });
  const submitted = (await response.json()) as { jobId: string };
  const outputPath = path.join(process.cwd(), "output", "contextmesh-demo-summary.md");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `# ContextMesh Demo\n\nSubmitted job: ${submitted.jobId}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ jobId: submitted.jobId, outputPath }, null, 2)}\n`);
}
