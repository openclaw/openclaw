import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import * as absoluteDeadline from "../utils/absolute-deadline.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  type snapshotUpdateCandidateState as snapshot,
  UpdateCandidateSnapshotInventorySchema as InventorySchema,
  UpdateCandidateStateSnapshotSchema as SnapshotSchema,
} from "./update-candidate-state.js";

type Admission = Pick<Parameters<typeof snapshot>[0], "pluginPlanPath" | "databaseInventory">;
type Input = Omit<Parameters<typeof snapshot>[0], keyof Admission>;
const entrypoint = runtimeProcessEntrypoints.updateCandidateState;

/** Wake the inspection deadline without replacing native process-cleanup timers. */
export function captureUpdateCandidateDeadline(): () => void {
  const deadlines = vi.spyOn(absoluteDeadline, "scheduleAbsoluteDeadline");
  return () => {
    const call = deadlines.mock.calls.at(-1);
    const scheduled = deadlines.mock.results.at(-1);
    if (!call || scheduled?.type !== "return") {
      throw new Error("Inspection allowance was not scheduled");
    }
    const [deadlineAtMs, expire, now = Date.now] = call;
    if (now() < deadlineAtMs) {
      throw new Error("Inspection allowance has not expired");
    }
    scheduled.value();
    expire();
  };
}

export async function materializeUpdateCandidateStateWorker(candidateRoot: string): Promise<void> {
  const source = resolveRuntimeWorkerUrl(entrypoint);
  const worker = path.join(candidateRoot, "dist", entrypoint.distWorkerPath);
  const loader = source.pathname.endsWith(".ts")
    ? `const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
      register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)))} });`
    : "";
  const program = `void (async () => {
      ${loader}
      await import(${JSON.stringify(source.href)});
    })();`;
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(worker, program);
}

async function runWorker(input: Input, mode: "inventory" | "snapshot", admitted?: Admission) {
  // Backup/VACUUM cannot be cancelled in-process; join the worker before fixture cleanup.
  const worker = resolveRuntimeWorkerUrl(entrypoint);
  const result = await runCommandBuffered([process.execPath, ...resolveRuntimeWorkerArgv(worker)], {
    input: JSON.stringify({
      ...input,
      mode,
      ...admitted,
      includeLocalStoreVersions: true,
      includeClientCredentialStoreVersion: true,
    }),
    timeoutMs: 30_000,
    killGraceMs: 500,
    maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
  });
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return JSON.parse(result.stdout.toString("utf8"));
}

export async function inventoryUpdateCandidateStateWorker(input: Input): Promise<Admission> {
  const inventory = InventorySchema.parse(await runWorker(input, "inventory"));
  return {
    pluginPlanPath: path.join(input.targetStateDir, inventory.pluginPlan),
    databaseInventory: [...inventory.databases.keys()],
  };
}

export async function runUpdateCandidateSnapshotWorker(input: Input) {
  const admitted = await inventoryUpdateCandidateStateWorker(input);
  return SnapshotSchema.parse(await runWorker(input, "snapshot", admitted)).versions;
}

export function createStateSnapshotInput(root: string, stateDir: string, targetStateDir: string) {
  return {
    stateDir,
    targetStateDir,
    candidateRoot: fileURLToPath(new URL("../../", import.meta.url)),
    config: {},
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
    },
  };
}
