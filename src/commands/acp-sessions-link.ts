import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

/**
 * A resolved triple for one ACP session: the openclaw session-store key,
 * the ACP session id on the backend/copilot side, and the resolved copilot
 * state directory path.
 */
export type AcpSessionLinkRow = {
  /** OpenClaw session-store key, e.g. "agent:copilot:acp:<uuid>" */
  openclawKey: string;
  /** ACP/copilot-side session id stored in entry.acp.identity.acpxSessionId */
  acpSessionId: string | null;
  /** Resolved path to ~/.copilot/session-state/<acpSessionId>/ */
  copilotStatePath: string | null;
  /** Whether the copilot state directory exists on disk */
  copilotStateExists: boolean;
};

function resolveCopilotStateDir(acpSessionId: string, homedir: string): string {
  return path.join(homedir, ".copilot", "session-state", acpSessionId);
}

function resolveAcpSessionId(entry: SessionEntry): string | null {
  const id = entry.acp?.identity?.acpxSessionId;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  return null;
}

export function buildAcpSessionLinkRows(
  storeTargets: Array<{ storePath: string }>,
  homedir: string,
): AcpSessionLinkRow[] {
  const rows: AcpSessionLinkRow[] = [];

  for (const target of storeTargets) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(target.storePath);
    } catch {
      continue;
    }

    for (const [key, entry] of Object.entries(store)) {
      if (!entry?.acp) {
        continue;
      }
      const acpSessionId = resolveAcpSessionId(entry);
      let copilotStatePath: string | null = null;
      let copilotStateExists = false;

      if (acpSessionId) {
        copilotStatePath = resolveCopilotStateDir(acpSessionId, homedir);
        try {
          copilotStateExists = fs.existsSync(copilotStatePath);
        } catch {
          copilotStateExists = false;
        }
      }

      rows.push({
        openclawKey: key,
        acpSessionId,
        copilotStatePath,
        copilotStateExists,
      });
    }
  }

  return rows;
}

function formatLinkRow(row: AcpSessionLinkRow): string {
  const acpId = row.acpSessionId ?? "(none)";
  const statePath = row.copilotStatePath ?? "(n/a)";
  const stateFlag =
    row.acpSessionId === null
      ? "MISSING_ACP_ID"
      : row.copilotStateExists
        ? "ok"
        : "MISSING_STATE_DIR";
  // TSV: fields separated by tab; flag appended for machine parsing
  return `${row.openclawKey}\t${acpId}\t${statePath}\t${stateFlag}`;
}

export async function acpSessionsLinkCommand(
  opts: {
    json?: boolean;
    store?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const homedir = os.homedir();

  let targets: Array<{ storePath: string; agentId: string }>;

  if (opts.store) {
    targets = [
      {
        storePath: path.resolve(opts.store),
        agentId: opts.agent?.trim() || "unknown",
      },
    ];
  } else if (opts.agent?.trim()) {
    targets = resolveAgentSessionStoreTargetsSync(cfg, opts.agent.trim());
  } else {
    targets = resolveAllAgentSessionStoreTargetsSync(cfg, {});
  }

  const rows = buildAcpSessionLinkRows(targets, homedir);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      count: rows.length,
      sessions: rows,
    });
    return;
  }

  if (rows.length === 0) {
    runtime.log("No ACP sessions found.");
    return;
  }

  const HEADER = "openclaw-key\tacp-session-id\tcopilot-state-path\tstatus";
  runtime.log(HEADER);
  for (const row of rows) {
    runtime.log(formatLinkRow(row));
  }
}
