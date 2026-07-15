/**
 * Loop log directory management.
 *
 * Creates and manages a directory hierarchy under the state directory
 * that records each phase's prompts, results, and the final report.
 *
 * Directory layout:
 *   <stateDir>/loops/<task-slug>-<timestamp>/
 *     loop.json          — loop metadata (task, phases, timestamps)
 *     01-analysis/
 *       prompt.md        — prompt sent to the agent
 *       result.json      — structured result
 *     02-plan/
 *       prompt.md
 *       subtasks.json    — subtask decomposition
 *     03-execution/
 *       <subtask-name>/
 *         prompt.md
 *         result.json
 *     04-verification/
 *       <subtask-name>/
 *         prompt.md
 *         verdict.json
 *     05-report/
 *       prompt.md
 *       summary.md       — final report
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoopSubtask } from "./loop-types.js";

const LOOP_STATE_DIR = ".openclaw/loops";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "loop";
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function phaseDirName(phase: string, index: number): string {
  const idx = String(index).padStart(2, "0");
  return `${idx}-${phase}`;
}

function resolveStateDir(env?: NodeJS.ProcessEnv): string {
  const home = env?.HOME ?? process.env.HOME ?? "/tmp";
  return home;
}

/** Creates the loop root directory and returns its path. */
export async function createLoopDirectory(
  task: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const root = resolveStateDir(env);
  const name = `${slugify(task)}-${timestamp()}`;
  const dir = path.join(root, LOOP_STATE_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeLoopMetadata(dir, { task, createdAt: new Date().toISOString() });
  return dir;
}

async function writeLoopMetadata(
  dir: string,
  meta: { task: string; createdAt: string },
): Promise<void> {
  await writeFile(
    path.join(dir, "loop.json"),
    JSON.stringify({ ...meta, phases: [] }, null, 2),
    "utf-8",
  );
}

/** Updates the loop.json with phase tracking info. */
export async function appendPhaseToMetadata(
  dir: string,
  phase: string,
  subtaskCount?: number,
): Promise<void> {
  const metaPath = path.join(dir, "loop.json");
  try {
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(metaPath, "utf-8").catch(() => "{}"),
    );
    const meta = JSON.parse(raw);
    meta.phases = meta.phases ?? [];
    meta.phases.push({
      phase,
      startedAt: new Date().toISOString(),
      subtaskCount: subtaskCount ?? 0,
    });
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    // Best-effort metadata updates.
  }
}

/** Gets the phase directory path for the given phase index. */
export function getPhaseDir(
  loopDir: string,
  phase: string,
  index: number,
): string {
  return path.join(loopDir, phaseDirName(phase, index));
}

/** Writes the prompt that was sent to the agent for a phase. */
export async function writePhasePrompt(
  phaseDir: string,
  prompt: string,
): Promise<void> {
  await mkdir(phaseDir, { recursive: true });
  await writeFile(path.join(phaseDir, "prompt.md"), prompt, "utf-8");
}

/** Writes the structured result from a phase completion. */
export async function writePhaseResult(
  phaseDir: string,
  data: unknown,
): Promise<void> {
  await mkdir(phaseDir, { recursive: true });
  await writeFile(
    path.join(phaseDir, "result.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

/** Writes the subtask list from the planning phase. */
export async function writeSubtasks(
  phaseDir: string,
  subtasks: LoopSubtask[],
): Promise<void> {
  await mkdir(phaseDir, { recursive: true });
  await writeFile(
    path.join(phaseDir, "subtasks.json"),
    JSON.stringify(subtasks, null, 2),
    "utf-8",
  );
}

/** Creates and returns the execution subtask directory. */
export function getSubtaskExecDir(
  loopDir: string,
  subtaskName: string,
): string {
  return path.join(loopDir, "03-execution", slugify(subtaskName));
}

/** Creates and returns the verification subtask directory. */
export function getSubtaskVerifyDir(
  loopDir: string,
  subtaskName: string,
): string {
  return path.join(loopDir, "04-verification", slugify(subtaskName));
}

/** Writes the final report (Phase 5). */
export async function writeFinalReport(
  reportDir: string,
  report: string,
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "summary.md"), report, "utf-8");
}
