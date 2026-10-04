import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../../logging/redact.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import {
  type PreparedWorkerSsh,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";

export type WorkerBootstrapCommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<SpawnResult>;

export const BOOTSTRAP_OUTPUT_TAG = "OPENCLAW_WORKER_BOOTSTRAP_V1";

export function parseTaggedOutput(stdout: string): { action: string; payload: string } | undefined {
  const prefix = `${BOOTSTRAP_OUTPUT_TAG}\t`;
  const record = stdout.split(/\r?\n/u).findLast((line) => line.startsWith(prefix));
  if (!record) {
    return undefined;
  }
  const actionEnd = record.indexOf("\t", prefix.length);
  if (actionEnd === -1) {
    return undefined;
  }
  const action = record.slice(prefix.length, actionEnd);
  const payload = record.slice(actionEnd + 1).trim();
  return action && payload ? { action, payload } : undefined;
}

export function commandFailure(phase: string, result: SpawnResult): Error {
  const output = truncateUtf16Safe(
    redactSensitiveText(result.stderr.trim() || result.stdout.trim(), {
      mode: "tools",
    }).replace(/\s+/gu, " "),
    512,
  );
  const status =
    result.termination === "exit" ? `exit ${result.code ?? "unknown"}` : result.termination;
  return new Error(`Worker bootstrap ${phase} failed (${status})${output ? `: ${output}` : ""}`);
}

export function isSuccess(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

export function matchesCommandFailure(result: SpawnResult, code: number, marker: string): boolean {
  return result.code === code || result.stderr.includes(marker) || result.stdout.includes(marker);
}

export async function runSshScript(params: {
  prepared: PreparedWorkerSsh;
  runCommand: WorkerBootstrapCommandRunner;
  script: string;
  scriptArgs: readonly string[];
  timeoutMs: number;
  port?: number;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  return await params.runCommand(
    [
      "ssh",
      ...workerSshOptions(params.prepared, { forwarding: "disabled" }),
      "-a",
      "-x",
      "-T",
      "-p",
      String(params.port ?? params.prepared.port),
      "--",
      params.prepared.sshTarget,
      workerSshRemoteCommand(["sh", "-s", "--", ...params.scriptArgs]),
    ],
    workerSshCommandOptions({
      input: params.script,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    }),
  );
}
