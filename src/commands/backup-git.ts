import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listAgentIds, resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { beginLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import { assertNotUpdateCapturePath } from "../infra/update-capture-paths.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { GitBackupIdentity } from "../snapshot/git-backup-codec.js";
import {
  createGitBackup,
  initializeGitBackupRepository,
  readGitBackupLog,
  restoreGitBackupRef,
  verifyGitBackupRef,
} from "../snapshot/git-backup.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../utils.js";
import {
  recordBackupOutcomeBestEffort,
  resolveBackupAgentRoot,
  resolveRequiredBackupPath,
} from "./backup-shared.js";

type BackupGitCreateOptions = {
  repository?: string;
  all?: boolean;
  global?: boolean;
  agents?: string[];
  push?: boolean;
  excludeSecrets?: boolean;
  json?: boolean;
};

type BackupGitScopeOptions = {
  global?: boolean;
  agent?: string;
  store?: string;
};

export const GIT_BACKUP_PUSH_CREDENTIAL_WARNING =
  "Warning: pushed backup history contains credential material; keep the Git remote private.";

async function resolveCreateDatabases(options: BackupGitCreateOptions) {
  const normalizedAgents = [
    ...new Set(
      (options.agents ?? []).map((agent) => {
        const trimmed = agent.trim();
        if (!trimmed) {
          throw new Error("--agent must not be blank");
        }
        return normalizeAgentId(trimmed);
      }),
    ),
  ];
  const explicit = options.global === true || normalizedAgents.length > 0;
  if (options.all && explicit) {
    throw new Error("Use --all by itself, or select --global and --agent scopes explicitly.");
  }
  if (!options.all && !explicit) {
    throw new Error("Choose at least one Git backup scope: --all, --global, or --agent <id>.");
  }
  const globalPath = options.all || options.global ? resolveOpenClawStateSqlitePath() : undefined;
  if (globalPath) {
    assertNotUpdateCapturePath(globalPath, resolveStateDir());
  }
  const config = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
  let agents: Array<{ agentId: string; databasePath: string }> = [];
  if (options.all || normalizedAgents.length > 0) {
    const agentIds = options.all
      ? listAgentIds(config).toSorted()
      : normalizedAgents.map((agent) => resolveConfiguredAgentId(config, agent));
    agents = await Promise.all(agentIds.map((agentId) => resolveBackupAgentRoot(config, agentId)));
  }
  const databases: Array<{
    path: string;
    identity: GitBackupIdentity;
  }> = [];
  if (globalPath) {
    databases.push({
      path: globalPath,
      identity: { role: "global" },
    });
  }
  // Config owns both the current roster and each agent root; durable registry
  // rows can retain stale paths after an agent moves or is removed.
  for (const { agentId, databasePath } of agents) {
    assertNotUpdateCapturePath(databasePath, resolveStateDir());
    databases.push({ path: databasePath, identity: { role: "agent", agentId } });
  }
  return databases;
}

function resolveOneIdentity(options: BackupGitScopeOptions): GitBackupIdentity {
  const agent = options.agent?.trim();
  const store = options.store?.trim();
  if (options.store !== undefined && !store) {
    throw new Error("--store must not be blank");
  }
  const scopes = Number(options.global === true) + Number(Boolean(agent)) + Number(Boolean(store));
  if (scopes > 1) {
    throw new Error(
      "Choose exactly one Git backup scope: --global, --agent <id>, or --store <id>.",
    );
  }
  if (scopes === 0) {
    throw new Error("Choose a Git backup scope: --global, --agent <id>, or --store <id>.");
  }
  if (store) {
    return { role: "generic", id: store };
  }
  return options.global === true
    ? { role: "global" }
    : { role: "agent", agentId: normalizeAgentId(agent) };
}

export async function backupGitInitCommand(
  runtime: RuntimeEnv,
  options: { repository?: string; remote?: string; json?: boolean },
): Promise<{ repositoryPath: string }> {
  const result = await initializeGitBackupRepository({
    repositoryPath: resolveRequiredBackupPath(options.repository, "--repository"),
    stateDir: resolveStateDir(),
    remote: options.remote,
  });
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(
      terminalText`Git backup repository ready: ${shortenHomePath(result.repositoryPath)}`,
    );
  }
  return result;
}

export async function backupGitCreateCommand(runtime: RuntimeEnv, options: BackupGitCreateOptions) {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  const databases = await resolveCreateDatabases(options);
  if (options.push && !options.excludeSecrets) {
    runtime.error(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);
  }
  const releaseCustody = beginLifecycleWriteCustody("backup");
  let failure: unknown;
  try {
    const result = await withCommandProcessScope(async () =>
      createGitBackup({
        repositoryPath,
        stateDir: resolveStateDir(),
        databases,
        all: options.all,
        excludeSecrets: options.excludeSecrets,
        push: options.push,
      }),
    );
    // A completed local backup remains successful even when requested remote replication fails;
    // pushFailed records that durable degradation without discarding the recoverable local commit.
    await recordBackupOutcomeBestEffort(runtime, {
      kind: "git",
      archivePath: repositoryPath,
      status: "ok",
      target: result.commit,
      error:
        [...result.warnings, ...(result.pushWarning ? [result.pushWarning] : [])].join("\n") ||
        undefined,
      ...(result.pushWarning ? { pushFailed: true } : {}),
    });
    if (options.json) {
      writeRuntimeJson(runtime, result);
    } else if (result.noChanges) {
      runtime.log(terminalText`Git backup: no changes (${shortenHomePath(repositoryPath)})`);
    } else {
      runtime.log(terminalText`Git backup committed: ${result.commit}`);
    }
    if (result.pushWarning) {
      // Keep escaped line breaks outside URL query values during console redaction.
      const warning = result.pushWarning.split("\n").join(" \\n ");
      runtime.error(terminalText`Warning: Git backup committed, but push failed: ${warning}`);
    }
    for (const warning of result.warnings) {
      runtime.error(terminalText`Warning: ${warning}`);
    }
    return result;
  } catch (error) {
    failure = error;
    await recordBackupOutcomeBestEffort(runtime, {
      kind: "git",
      archivePath: repositoryPath,
      status: "failed",
      error: formatErrorMessage(error),
    });
    throw error;
  } finally {
    releaseCustody(failure);
  }
}

export async function backupGitLogCommand(
  runtime: RuntimeEnv,
  options: { repository?: string; limit?: number; json?: boolean },
) {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  const entries = await readGitBackupLog({ repositoryPath, limit: options.limit ?? 20 });
  if (options.json) {
    writeRuntimeJson(runtime, { repositoryPath, entries });
  } else if (entries.length === 0) {
    runtime.log(terminalText`No Git backup commits in ${shortenHomePath(repositoryPath)}.`);
  } else {
    runtime.log(
      entries
        .map((entry) => terminalText`${entry.commit}\t${entry.date}\t${entry.message}`)
        .join("\n"),
    );
  }
  return entries;
}

export async function backupGitVerifyCommand(
  runtime: RuntimeEnv,
  options: BackupGitScopeOptions & { repository?: string; ref?: string; json?: boolean },
) {
  const result = await verifyGitBackupRef({
    repositoryPath: resolveRequiredBackupPath(options.repository, "--repository"),
    identity: resolveOneIdentity(options),
    ref: options.ref,
  });
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    for (const table of result.tables) {
      runtime.log(
        terminalText`${table.ok ? "ok" : "failed"}\t${table.table}\t${table.rows}\t${table.sha256}`,
      );
    }
    runtime.log(terminalText`Git backup verified: ${result.commit}`);
  }
  return result;
}

export async function backupGitRestoreCommand(
  runtime: RuntimeEnv,
  options: BackupGitScopeOptions & {
    repository?: string;
    ref?: string;
    target?: string;
    json?: boolean;
  },
) {
  const result = await restoreGitBackupRef({
    repositoryPath: resolveRequiredBackupPath(options.repository, "--repository"),
    identity: resolveOneIdentity(options),
    ref: options.ref,
    targetPath: resolveRequiredBackupPath(options.target, "--target"),
  });
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(
      terminalText`Git backup restored: ${shortenHomePath(result.targetPath)} (${result.commit})`,
    );
    if (result.excludedTables.length > 0) {
      runtime.error(
        terminalText`Warning: this redacted backup omits tables: ${result.excludedTables.join(", ")}`,
      );
    }
    if (result.excludedConfigStateKeyPrefixes.length > 0) {
      runtime.error(
        terminalText`Warning: this redacted backup omits machine-state values under: ${result.excludedConfigStateKeyPrefixes.join(", ")}`,
      );
    }
  }
  return result;
}
