import type { SessionVerifyReport } from "../config/sessions/types.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

function readCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const command =
    typeof record.command === "string"
      ? record.command.trim()
      : typeof record.cmd === "string"
        ? record.cmd.trim()
        : "";
  return command || undefined;
}

function readExecToolDetails(result: unknown): ExecToolDetails | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const candidate =
    outer.details && typeof outer.details === "object" && !Array.isArray(outer.details)
      ? (outer.details as Record<string, unknown>)
      : outer;
  const status = candidate.status;
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "running" &&
    status !== "approval-pending" &&
    status !== "approval-unavailable"
  ) {
    return null;
  }
  return candidate as unknown as ExecToolDetails;
}

function detectVerifyKind(command: string): SessionVerifyReport["entries"][number]["kind"] | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    /\b(vitest|jest|pytest|phpunit|rspec)\b/.test(normalized) ||
    /\b(cargo|go|deno)\s+test\b/.test(normalized) ||
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?test\b/.test(normalized)
  ) {
    return "test";
  }
  if (
    /\b(eslint|stylelint|ruff|biome)\b/.test(normalized) ||
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?lint\b/.test(normalized) ||
    /\bcargo\s+clippy\b/.test(normalized)
  ) {
    return "lint";
  }
  if (
    /\btsc\b/.test(normalized) ||
    /\bpyright\b/.test(normalized) ||
    /\bmypy\b/.test(normalized) ||
    /\bnode\s+(--check|-c)\b/.test(normalized) ||
    /\bcargo\s+check\b/.test(normalized) ||
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?check\b/.test(normalized)
  ) {
    return "check";
  }
  if (
    /\b(next|vite)\s+build\b/.test(normalized) ||
    /\bcargo\s+build\b/.test(normalized) ||
    /\bgo\s+build\b/.test(normalized) ||
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?build\b/.test(normalized)
  ) {
    return "build";
  }
  return null;
}

export function buildVerifyEntryFromToolResult(params: {
  toolName: string;
  meta?: string;
  args: unknown;
  result: unknown;
  isToolError: boolean;
}): SessionVerifyReport["entries"][number] | undefined {
  const normalizedToolName = params.toolName.trim().toLowerCase();
  if (normalizedToolName !== "exec" && normalizedToolName !== "bash") {
    return undefined;
  }

  const command = readCommand(params.args);
  if (!command) {
    return undefined;
  }

  const kind = detectVerifyKind(command);
  if (!kind) {
    return undefined;
  }

  const details = readExecToolDetails(params.result);
  if (!details || (details.status !== "completed" && details.status !== "failed")) {
    return undefined;
  }

  const exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
  const status =
    !params.isToolError && details.status === "completed" && (exitCode === null || exitCode === 0)
      ? "passed"
      : "failed";

  return {
    toolName: params.toolName,
    meta: params.meta,
    command,
    kind,
    status,
    exitCode,
    source: "tool-result",
  };
}

export function buildVerifyReport(params: {
  generatedAt: number;
  entries: SessionVerifyReport["entries"];
}): SessionVerifyReport {
  const entries = params.entries.map((entry) => ({ ...entry }));
  const checksRun = entries.length;
  const checksPassed = entries.filter((entry) => entry.status === "passed").length;
  const checksFailed = checksRun - checksPassed;
  if (checksRun === 0) {
    return {
      status: "skipped",
      strategy: "command-tool",
      generatedAt: params.generatedAt,
      checksRun: 0,
      checksPassed: 0,
      checksFailed: 0,
      reason: "no verification commands detected",
      entries: [],
    };
  }
  return {
    status: checksFailed > 0 ? "failed" : "passed",
    strategy: "command-tool",
    generatedAt: params.generatedAt,
    checksRun,
    checksPassed,
    checksFailed,
    entries,
  };
}
