import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { getSessionEntry } from "../config/sessions/store.js";
import { hasSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
  type TrajectoryCommandExportSummary,
} from "../trajectory/command-export.js";

type ExportTrajectoryCommandOptions = {
  sessionKey?: string;
  output?: string;
  agent?: string;
  workspace?: string;
  json?: boolean;
  requestJsonBase64?: string;
};

type EncodedExportTrajectoryRequest = {
  sessionKey?: unknown;
  output?: unknown;
  agent?: unknown;
  workspace?: unknown;
};

const ENCODED_EXPORT_REQUEST_RE = /^[A-Za-z0-9_-]{1,65536}$/u;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function decodeExportTrajectoryRequest(encoded: string): Partial<ExportTrajectoryCommandOptions> {
  const trimmed = encoded.trim();
  if (!ENCODED_EXPORT_REQUEST_RE.test(trimmed)) {
    throw new Error("Encoded trajectory export request is invalid");
  }
  const decoded = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Encoded trajectory export request must be a JSON object");
  }
  const request = decoded as EncodedExportTrajectoryRequest;
  return {
    sessionKey: readOptionalString(request.sessionKey) ?? "",
    output: readOptionalString(request.output),
    agent: readOptionalString(request.agent),
    workspace: readOptionalString(request.workspace),
  };
}

function resolveExportTrajectoryOptions(
  opts: ExportTrajectoryCommandOptions,
): ExportTrajectoryCommandOptions {
  const encoded = opts.requestJsonBase64?.trim();
  if (!encoded) {
    return opts;
  }
  return {
    ...opts,
    ...decodeExportTrajectoryRequest(encoded),
  };
}

export async function exportTrajectoryCommand(
  opts: ExportTrajectoryCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let resolvedOpts: ExportTrajectoryCommandOptions;
  try {
    resolvedOpts = resolveExportTrajectoryOptions(opts);
  } catch (error) {
    runtime.error(`Failed to decode trajectory export request: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }
  const sessionKey = resolvedOpts.sessionKey?.trim();
  if (!sessionKey) {
    runtime.error(
      `--session-key is required. Run ${formatCliCommand("openclaw sessions")} to choose a session.`,
    );
    runtime.exit(1);
    return;
  }
  const targetAgentId = resolvedOpts.agent ?? resolveAgentIdFromSessionKey(sessionKey);
  const entry = getSessionEntry({ agentId: targetAgentId, sessionKey });
  if (!entry?.sessionId) {
    runtime.error(
      `Session not found: ${sessionKey}. Run ${formatCliCommand("openclaw sessions")} to see available sessions.`,
    );
    runtime.exit(1);
    return;
  }

  if (!hasSqliteSessionTranscriptEvents({ agentId: targetAgentId, sessionId: entry.sessionId })) {
    runtime.error(
      `Session transcript has not been migrated into SQLite. Run ${formatCliCommand("openclaw doctor --fix")} and try again.`,
    );
    runtime.exit(1);
    return;
  }

  let summary: TrajectoryCommandExportSummary;
  try {
    summary = await exportTrajectoryForCommand({
      agentId: targetAgentId,
      outputPath: resolvedOpts.output,
      sessionId: entry.sessionId,
      sessionKey,
      workspaceDir: path.resolve(resolvedOpts.workspace ?? process.cwd()),
    });
  } catch (error) {
    runtime.error(`Failed to export trajectory: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }

  if (resolvedOpts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  runtime.log(formatTrajectoryCommandExportSummary(summary));
}
