import fs from "node:fs";
import os from "node:os";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { resolveMaintenanceConfigFromInput } from "../config/sessions/store-maintenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

/**
 * Files in the per-agent sessions directory above which the orphan-transcript
 * scan in `doctor:state-integrity` becomes noticeably slow on real disks. Picked
 * to flag installs whose accumulated transcripts will keep the doctor on the
 * order of a few seconds inside the readdir+filter+realpath loop, even after
 * the rest of the doctor flow is healthy. Independent of `session.maintenance`
 * because orphan-transcript files outlive the session-store entries that
 * reference them.
 */
const SESSIONS_DIR_FILE_COUNT_FLOOR = 2_000;

export type SessionStoreSizeEvaluation = {
  warnings: string[];
};

/**
 * Read-only probe that warns when the configured-default agent's session store
 * has grown to a size that will make `doctor:state-integrity` and adjacent
 * contributions slow, or when `session.maintenance` is configured loosely
 * enough that the store will keep growing.
 *
 * Pure with respect to user-facing side effects: returns warnings; the
 * contribution wrapper is responsible for `note(...)` output.
 */
export function evaluateSessionStoreSize(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Override only used by tests to point the probe at a fixture state dir. */
  homedir?: () => string;
}): SessionStoreSizeEvaluation {
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir));
  const agentId = resolveDefaultAgentId(params.cfg);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, homedir);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId, env });
  const maintenance = resolveMaintenanceConfigFromInput(params.cfg.session?.maintenance);

  let storeEntryCount = 0;
  try {
    if (fs.existsSync(storePath)) {
      storeEntryCount = Object.keys(loadSessionStore(storePath)).length;
    }
  } catch {
    // Loader is defensive (returns {} on parse failure); if the read itself
    // throws (permissions, etc.) other doctor contributions will surface it.
    // Do not double-warn here.
    return { warnings };
  }

  let transcriptFileCount = 0;
  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && isPrimarySessionTranscriptFileName(entry.name)) {
        transcriptFileCount += 1;
      }
    }
  } catch {
    // Sessions dir missing or unreadable; skip the dir-size signal. State-
    // integrity will surface the underlying problem.
    transcriptFileCount = 0;
  }

  const exceedsMaxEntries = storeEntryCount >= maintenance.maxEntries;
  const exceedsDirFloor = transcriptFileCount >= SESSIONS_DIR_FILE_COUNT_FLOOR;
  if (!exceedsMaxEntries && !exceedsDirFloor) {
    return { warnings };
  }

  const cleanupCmd = formatCliCommand("openclaw sessions cleanup --enforce --fix-missing");
  const dryRunCmd = formatCliCommand("openclaw sessions cleanup --dry-run --fix-missing");
  const lines: string[] = [];

  if (exceedsMaxEntries) {
    lines.push(
      `- Agent "${agentId}" session store has ${storeEntryCount} entries (cap: session.maintenance.maxEntries=${maintenance.maxEntries}).`,
    );
  }
  if (exceedsDirFloor) {
    lines.push(`- ${shortenHomePath(sessionsDir)} holds ${transcriptFileCount} transcript files.`);
  }
  lines.push(
    "  Large stores slow down the doctor's session-integrity and orphan-transcript checks.",
    `  Preview cleanup: ${dryRunCmd}`,
    `  Apply: ${cleanupCmd}`,
  );

  if (maintenance.mode !== "enforce") {
    lines.push(
      `  Maintenance mode is "${maintenance.mode}", so the store will keep growing on its own.`,
      `  Switch on automatic pruning: ${formatCliCommand("openclaw config set session.maintenance.mode enforce")}`,
    );
  }

  warnings.push(lines.join("\n"));
  return { warnings };
}

/**
 * Doctor contribution: warn early about session-store and sessions-dir growth
 * that will make later doctor steps slow. Runs before plugin-registry and
 * state-integrity so the operator sees the cleanup hint before they sit
 * through the slow scans.
 */
export function noteSessionStoreSizeHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): void {
  const { warnings } = evaluateSessionStoreSize(params);
  if (warnings.length === 0) {
    return;
  }
  note(warnings.join("\n"), "Session store size");
}
