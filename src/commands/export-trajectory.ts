import fs from "node:fs";
import path from "node:path";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
} from "../trajectory/command-export.js";

export type ExportTrajectoryCommandOptions = {
  sessionKey: string;
  output?: string;
  store?: string;
  agent?: string;
  workspace?: string;
  json?: boolean;
};

export async function exportTrajectoryCommand(
  opts: ExportTrajectoryCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    runtime.error("--session-key is required");
    runtime.exit(1);
    return;
  }
  const targetAgentId = opts.agent ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath = opts.store
    ? path.resolve(opts.store)
    : resolveDefaultSessionStorePath(targetAgentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    runtime.error(`Session not found: ${sessionKey}`);
    runtime.exit(1);
    return;
  }

  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(
      entry.sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }),
    );
  } catch (error) {
    runtime.error(`Failed to resolve session file: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }
  if (!fs.existsSync(sessionFile)) {
    runtime.error("Session file not found.");
    runtime.exit(1);
    return;
  }

  let summary: ReturnType<typeof exportTrajectoryForCommand>;
  try {
    summary = exportTrajectoryForCommand({
      outputPath: opts.output,
      sessionFile,
      sessionId: entry.sessionId,
      sessionKey,
      workspaceDir: path.resolve(opts.workspace ?? process.cwd()),
    });
  } catch (error) {
    runtime.error(`Failed to export trajectory: ${formatErrorMessage(error)}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  runtime.log(formatTrajectoryCommandExportSummary(summary));
}
