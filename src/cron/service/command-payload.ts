import fs from "node:fs";
import path from "node:path";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { CronJob, CronRunOutcome } from "../types.js";
import { DEFAULT_JOB_TIMEOUT_MS, resolveCronJobTimeoutMs } from "./timeout-policy.js";

const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 512;
const MAX_OUTPUT_SUMMARY_LENGTH = 500;

export type CronCommandPayload = {
  kind: "command";
  script: string;
  args?: string[];
};

export type CronCommandJobRunner = (params: {
  job: CronJob;
  payload: CronCommandPayload;
  storePath: string;
  workspaceRoot?: string;
  abortSignal?: AbortSignal;
  nowMs: () => number;
}) => Promise<CronRunOutcome>;

function buildDiagnostic(params: {
  ts: number;
  severity: "info" | "warn" | "error";
  message: string;
  exitCode?: number | null;
  truncated?: boolean;
}): NonNullable<CronRunOutcome["diagnostics"]> {
  return {
    summary: params.message,
    entries: [
      {
        ts: params.ts,
        source: "exec",
        severity: params.severity,
        message: params.message,
        exitCode: params.exitCode,
        truncated: params.truncated,
      },
    ],
  };
}

function truncateForSummary(value: string): { text: string; truncated: boolean } {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_OUTPUT_SUMMARY_LENGTH) {
    return { text: normalized, truncated: false };
  }
  return { text: `${normalized.slice(0, MAX_OUTPUT_SUMMARY_LENGTH)}...`, truncated: true };
}

function failPreflight(params: {
  nowMs: () => number;
  message: string;
  severity?: "warn" | "error";
}): CronRunOutcome {
  return {
    status: "error",
    error: params.message,
    diagnostics: buildDiagnostic({
      ts: params.nowMs(),
      severity: params.severity ?? "error",
      message: params.message,
    }),
  };
}

function inferWorkspaceRoot(storePath: string): string {
  const cronDir = path.dirname(storePath);
  const stateDir = path.dirname(cronDir);
  if (path.basename(cronDir).toLowerCase() === "cron" && path.basename(stateDir) === ".openclaw") {
    return path.dirname(stateDir);
  }
  return process.cwd();
}

function hasOpenClawProjectMarkers(workspaceRoot: string): boolean {
  return (
    fs.existsSync(path.join(workspaceRoot, "package.json")) &&
    fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(workspaceRoot, "pnpm-lock.yaml"))
  );
}

function readPackageScripts(workspaceRoot: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    return parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? (parsed.scripts as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

function validateCommandPayload(payload: CronCommandPayload): string | null {
  const script = payload.script.trim();
  if (!SCRIPT_NAME_RE.test(script)) {
    return `cron command payload has invalid package script name: ${JSON.stringify(payload.script)}`;
  }
  const args = payload.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) {
    return `cron command payload args must contain at most ${MAX_ARGS} literal strings`;
  }
  for (const arg of args) {
    if (
      typeof arg !== "string" ||
      arg.length > MAX_ARG_LENGTH ||
      arg.includes("\u0000") ||
      arg.includes("\r") ||
      arg.includes("\n")
    ) {
      return "cron command payload args must be newline-free literal strings";
    }
  }
  return null;
}

export const runCronCommandJob: CronCommandJobRunner = async ({
  job,
  payload,
  storePath,
  workspaceRoot,
  nowMs,
}) => {
  const validationError = validateCommandPayload(payload);
  if (validationError) {
    return failPreflight({ nowMs, message: validationError });
  }
  const script = payload.script.trim();

  const root = path.resolve(workspaceRoot ?? inferWorkspaceRoot(storePath));
  if (!hasOpenClawProjectMarkers(root)) {
    return failPreflight({
      nowMs,
      message: `cron command payload requires an OpenClaw repo root with package.json, pnpm-workspace.yaml, and pnpm-lock.yaml: ${root}`,
    });
  }

  const scripts = readPackageScripts(root);
  if (!scripts) {
    return failPreflight({
      nowMs,
      message: `cron command payload could not read ${path.join(root, "package.json")}`,
    });
  }
  if (typeof scripts[script] !== "string") {
    return failPreflight({
      nowMs,
      message: `cron command payload script is not declared in package.json: ${script}`,
    });
  }

  const timeoutMs = resolveCronJobTimeoutMs(job) ?? DEFAULT_JOB_TIMEOUT_MS;
  const args = payload.args ?? [];
  const argv = ["pnpm", script, ...args];
  const label = argv.join(" ");
  try {
    const result = await runCommandWithTimeout(argv, {
      cwd: root,
      timeoutMs,
      env: { OPENCLAW_CRON_COMMAND: "1" },
    });
    const output = truncateForSummary(result.stderr || result.stdout || "");
    if (result.code === 0 && result.termination === "exit") {
      const summary = output.text ? `${label} ok: ${output.text}` : `${label} ok`;
      return {
        status: "ok",
        summary,
        diagnostics: buildDiagnostic({
          ts: nowMs(),
          severity: "info",
          message: summary,
          exitCode: result.code,
          truncated: output.truncated,
        }),
      };
    }
    const status =
      result.termination === "timeout"
        ? "timed out"
        : `exited with code ${result.code ?? "unknown"}`;
    const detail = output.text ? `: ${output.text}` : "";
    const error = `cron command failed: ${label} ${status}${detail}`;
    return {
      status: "error",
      error,
      diagnostics: buildDiagnostic({
        ts: nowMs(),
        severity: "error",
        message: error,
        exitCode: result.code,
        truncated: output.truncated,
      }),
    };
  } catch (err) {
    const error = `cron command failed: ${label}: ${String(err)}`;
    return {
      status: "error",
      error,
      diagnostics: buildDiagnostic({
        ts: nowMs(),
        severity: "error",
        message: error,
      }),
    };
  }
};
