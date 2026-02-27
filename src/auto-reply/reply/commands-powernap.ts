import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentEntries, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadSubagentRegistryFromDisk } from "../../agents/subagent-registry.store.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { isRestartEnabled } from "../../config/commands.js";
import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { snapshotSessionOrigin } from "../../config/sessions/metadata.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { archiveSessionTranscripts } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { CommandHandler } from "./commands-types.js";
import { setPowernapDraining } from "./powernap-drain.js";

type ResetSessionInfo = {
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  agentId: string;
};

export const handlePowernapCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/powernap") {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /powernap from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // --- Phase 1: Snapshot active subagents ---
  const activeSubagentRuns = snapshotActiveSubagents();

  // --- Phase 2: Activate drain — reject new inbound messages during reset ---
  setPowernapDraining(true);

  // --- Phase 3: Bulk session reset across all agents ---
  const cfg = loadConfig();
  const { resetCount, resetSessions } = await resetAllSessions(cfg);

  // --- Phase 4: Fire before_reset hooks (memory extraction) before archiving ---
  await fireBeforeResetHooks(resetSessions, params.workspaceDir);

  // --- Phase 5: Archive old transcripts (best-effort, after hooks read them) ---
  archiveResetTranscripts(resetSessions);

  // --- Phase 6: Pre-flight config validation before restart ---
  const configIssues = await validateConfigBeforeRestart();

  // --- Phase 7: Write restart sentinel so post-restart confirmation routes back ---
  const deliveryContext = {
    channel: params.ctx.OriginatingChannel || params.command.channel,
    to: params.ctx.OriginatingTo || params.command.from || params.command.to,
    accountId: params.ctx.AccountId,
  };
  const postNapMessage = buildPostNapMessage({ resetCount, activeSubagentRuns });
  await writeRestartSentinel({
    kind: "restart",
    status: "ok",
    ts: Date.now(),
    sessionKey: params.sessionKey,
    deliveryContext,
    message: postNapMessage,
  });

  // --- Phase 8: Schedule gateway restart (skip if config is invalid) ---
  let restartScheduled = false;
  let restartReason: string | undefined;
  if (configIssues) {
    restartReason = `config invalid: ${configIssues}`;
    setPowernapDraining(false);
  } else if (isRestartEnabled(cfg)) {
    scheduleGatewaySigusr1Restart({ delayMs: 3000, reason: "/powernap" });
    restartScheduled = true;
  } else {
    restartReason = "restart disabled in config";
    // No restart coming — clear drain flag so messages can flow again.
    setPowernapDraining(false);
  }

  return {
    shouldContinue: false,
    reply: {
      text: buildPowernapReply({ resetCount, activeSubagentRuns, restartScheduled, restartReason }),
    },
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the config file from disk and validate it before scheduling a restart.
 * Returns a human-readable error string if invalid, or null if OK.
 */
async function validateConfigBeforeRestart(): Promise<string | null> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid && snapshot.issues.length > 0) {
      return snapshot.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    }
    return null;
  } catch (err) {
    return `failed to read config: ${String(err)}`;
  }
}

function snapshotActiveSubagents(): SubagentRunRecord[] {
  let diskRuns: Map<string, SubagentRunRecord>;
  try {
    diskRuns = loadSubagentRegistryFromDisk();
  } catch {
    logVerbose("/powernap: failed to load subagent registry from disk, skipping snapshot");
    return [];
  }

  const active: SubagentRunRecord[] = [];
  for (const entry of diskRuns.values()) {
    if (typeof entry.endedAt !== "number") {
      active.push(entry);
    }
  }

  // Write snapshot even if empty (for audit trail)
  try {
    const stateDir = resolveStateDir();
    const snapshotDir = path.join(stateDir, "powernap");
    mkdirSync(snapshotDir, { recursive: true });

    const payload = {
      ts: Date.now(),
      reason: "powernap",
      activeRuns: active.map((run) => ({
        runId: run.runId,
        label: run.label,
        task: run.task,
        model: run.model,
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        spawnMode: run.spawnMode,
      })),
    };
    writeFileSync(
      path.join(snapshotDir, `snapshot-${Date.now()}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf-8",
    );
  } catch (err) {
    logVerbose(`/powernap: failed to write subagent snapshot: ${String(err)}`);
  }

  return active;
}

type ResetAllResult = {
  resetCount: number;
  resetSessions: ResetSessionInfo[];
};

async function resetAllSessions(cfg: ReturnType<typeof loadConfig>): Promise<ResetAllResult> {
  const agentIds = new Set<string>();
  agentIds.add(normalizeAgentId(resolveDefaultAgentId(cfg)));
  for (const agent of listAgentEntries(cfg)) {
    if (agent.id) {
      agentIds.add(normalizeAgentId(agent.id));
    }
  }

  let resetCount = 0;
  const resetSessions: ResetSessionInfo[] = [];
  const now = Date.now();

  for (const agentId of agentIds) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const sessionKeys = Object.keys(store);
    if (sessionKeys.length === 0) {
      continue;
    }

    await updateSessionStore(storePath, (mutableStore) => {
      for (const key of Object.keys(mutableStore)) {
        // Preserve cron sessions
        if (key.includes(":cron:")) {
          continue;
        }

        const entry = mutableStore[key];
        if (!entry) {
          continue;
        }

        resetSessions.push({
          sessionKey: key,
          sessionId: entry.sessionId,
          sessionFile: entry.sessionFile,
          agentId,
        });

        const nextEntry: SessionEntry = {
          sessionId: randomUUID(),
          updatedAt: now,
          systemSent: false,
          abortedLastRun: false,
          // Preserve user-set preferences
          thinkingLevel: entry.thinkingLevel,
          verboseLevel: entry.verboseLevel,
          reasoningLevel: entry.reasoningLevel,
          responseUsage: entry.responseUsage,
          model: entry.model,
          contextTokens: entry.contextTokens,
          sendPolicy: entry.sendPolicy,
          label: entry.label,
          origin: snapshotSessionOrigin(entry),
          lastChannel: entry.lastChannel,
          lastTo: entry.lastTo,
          skillsSnapshot: entry.skillsSnapshot,
          // Reset token counts
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          totalTokensFresh: true,
        };
        mutableStore[key] = nextEntry;
        resetCount++;
      }
    });
  }

  return { resetCount, resetSessions };
}

/**
 * Fire before_reset plugin hooks for each reset session so that plugins
 * (e.g. session-memory) can extract data before transcripts are archived.
 * Hooks run in parallel; we await them with a timeout so the gateway restart
 * doesn't kill them mid-flight.
 */
async function fireBeforeResetHooks(
  sessions: ResetSessionInfo[],
  workspaceDir?: string,
): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset") || sessions.length === 0) {
    return;
  }

  const HOOK_TIMEOUT_MS = 10_000;
  const hookPromises = sessions.map(async (info) => {
    try {
      const messages: unknown[] = [];
      if (info.sessionFile) {
        try {
          const content = await fs.readFile(info.sessionFile, "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) {
              continue;
            }
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "message" && parsed.message) {
                messages.push(parsed.message);
              }
            } catch {
              // skip malformed JSONL lines
            }
          }
        } catch {
          // Session file may not exist or be readable
        }
      }
      await hookRunner.runBeforeReset(
        { sessionFile: info.sessionFile, messages, reason: "powernap" },
        {
          agentId: info.agentId,
          sessionKey: info.sessionKey,
          sessionId: info.sessionId,
          workspaceDir,
        },
      );
    } catch (err: unknown) {
      logVerbose(`/powernap before_reset hook failed for ${info.sessionKey}: ${String(err)}`);
    }
  });

  // Await all hooks but cap the wait so powernap doesn't hang forever.
  await Promise.race([
    Promise.allSettled(hookPromises),
    new Promise((resolve) => setTimeout(resolve, HOOK_TIMEOUT_MS)),
  ]);
}

/**
 * Archive old transcripts after hooks have had a chance to read them.
 */
function archiveResetTranscripts(sessions: ResetSessionInfo[]): void {
  // Group by agentId to resolve store paths once per agent
  const byAgent = new Map<string, ResetSessionInfo[]>();
  for (const info of sessions) {
    const list = byAgent.get(info.agentId) ?? [];
    list.push(info);
    byAgent.set(info.agentId, list);
  }

  const cfg = loadConfig();
  for (const [agentId, infos] of byAgent) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    for (const info of infos) {
      try {
        archiveSessionTranscripts({
          sessionId: info.sessionId,
          storePath,
          sessionFile: info.sessionFile,
          agentId,
          reason: "reset",
        });
      } catch {
        // Archive failures are non-fatal
      }
    }
  }
}

/**
 * Build the post-restart message delivered via the restart sentinel.
 * Includes subagent task details so the user knows what was interrupted.
 */
function buildPostNapMessage(params: {
  resetCount: number;
  activeSubagentRuns: SubagentRunRecord[];
}): string {
  const lines: string[] = [];
  lines.push(
    `Power nap complete. Reset ${params.resetCount} session${params.resetCount === 1 ? "" : "s"}. Back online.`,
  );

  if (params.activeSubagentRuns.length > 0) {
    lines.push("");
    lines.push(`Interrupted subagents (${params.activeSubagentRuns.length}):`);
    for (const run of params.activeSubagentRuns.slice(0, 10)) {
      const label = run.label || run.runId.slice(0, 8);
      const taskPreview = run.task.length > 80 ? `${run.task.slice(0, 77)}...` : run.task;
      lines.push(`  - ${label}: ${taskPreview}`);
    }
    if (params.activeSubagentRuns.length > 10) {
      lines.push(`  + ${params.activeSubagentRuns.length - 10} more`);
    }
  }

  return lines.join("\n");
}

function buildPowernapReply(params: {
  resetCount: number;
  activeSubagentRuns: SubagentRunRecord[];
  restartScheduled: boolean;
  restartReason?: string;
}): string {
  const lines: string[] = [];
  lines.push("Power nap initiated.");
  lines.push(`Sessions reset: ${params.resetCount}`);

  if (params.activeSubagentRuns.length > 0) {
    lines.push(`Active subagents snapshotted: ${params.activeSubagentRuns.length}`);
    const shown = params.activeSubagentRuns.slice(0, 5);
    for (const run of shown) {
      const label = run.label || run.runId.slice(0, 8);
      const taskPreview = run.task.length > 60 ? `${run.task.slice(0, 57)}...` : run.task;
      lines.push(`  - ${label}: ${taskPreview}`);
    }
    if (params.activeSubagentRuns.length > 5) {
      lines.push(`  + ${params.activeSubagentRuns.length - 5} more`);
    }
  } else {
    lines.push("No active subagents.");
  }

  if (params.restartScheduled) {
    lines.push("Gateway restarting in 3s. Back shortly.");
  } else {
    lines.push(`Gateway restart skipped (${params.restartReason ?? "unknown"}).`);
  }

  return lines.join("\n");
}
