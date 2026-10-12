/** Doctor checks and repairs for state dir durability, sessions, transcripts, and credentials. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import { isSharedAuthStoreOwner } from "../agents/agent-delete-safety.js";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import {
  listAgentIds,
  resolveDefaultAgentDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import {
  clearWedgedSubagentRecoveryAbort,
  formatSubagentRecoveryWedgedReason,
  isSubagentRecoveryWedgedEntry,
} from "../agents/subagents/registry/subagent-recovery-state.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptsDirForAgent,
  resolveSessionStorePathCore,
} from "../config/sessions/paths.js";
import {
  applySessionEntryReplacements,
  loadExactSessionEntryReadOnly,
  scanDoctorSessionEntriesStrict,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { preserveDeferredPluginSessionSource } from "../infra/deferred-plugin-session-sources.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { existsDir, migrationFileExists as existsFile } from "../infra/state-migrations.fs.js";
import {
  loadLegacySessionStore,
  updateLegacySessionStore,
} from "../infra/state-migrations.legacy-session-store.js";
import { listConfiguredChannelIdsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { shortenHomePath } from "../utils.js";
import { repairHeartbeatPoisonedMainSession } from "./doctor-heartbeat-main-session-repair.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";
import {
  inspectMainSessionRecoveryEntry,
  noteMainSessionRecoveryIntegrity,
  type MainSessionRecoveryIntegrityCandidate,
} from "./doctor-main-session-recovery.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  createPluginSessionStateDoctorScanner,
  runPluginSessionStateDoctorRepairs,
} from "./doctor-session-state-providers.js";
import { countLabel, type OrphanAgentDir } from "./doctor-state-integrity-format.js";
import {
  detectLinuxSdBackedStateDir,
  detectLinuxVolatileStateDir,
  detectMacCloudSyncedStateDir,
  detectWindowsCloudSyncedStateDir,
  formatLinuxSdBackedStateDirWarning,
  formatLinuxVolatileStateDirWarning,
  formatWindowsCloudSyncedStateDirWarning,
} from "./doctor-state-storage-platform.js";
import { collectRetainedUnconfiguredAgentDatabaseWarnings } from "./doctor-unconfigured-agent-databases.js";
import { iterateDoctorSessionKeyBatches } from "./doctor/shared/session-entry-rewrite.js";

const STATE_INTEGRITY_CHECK_ID = "core/doctor/state-integrity";

type DoctorPrompterLike = Pick<DoctorPrompter, "confirmRuntimeRepair"> & {
  note?: typeof note;
};

type RuntimeDirLabel = "Sessions dir" | "Session store dir" | "OAuth dir";

function resolveSessionRuntimeDirectories(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): Map<string, RuntimeDirLabel> {
  const directories = new Map<string, RuntimeDirLabel>();
  const agentId = tryResolveDefaultAgentId(cfg);
  if (agentId) {
    directories.set(resolveSessionTranscriptsDirForAgent(agentId, env, homedir), "Sessions dir");
    directories.set(
      path.dirname(resolveSessionStorePathCore(cfg.session?.store, { agentId, env })),
      "Session store dir",
    );
  }
  return directories;
}

export type StateIntegrityHealthIssue = { path: string } & (
  | {
      kind: "mac-cloud-state-dir";
      storage: string;
    }
  | {
      kind: "windows-cloud-state-dir";
      storage: string;
    }
  | {
      kind: "linux-sd-state-dir";
      mountPoint: string;
      fsType: string;
      source: string;
    }
  | {
      kind: "linux-volatile-state-dir";
      mountPoint: string;
      fsType: string;
    }
  | {
      kind: "missing-state-dir";
    }
  | {
      kind: "state-dir-not-writable";
      hint?: string;
    }
  | {
      kind: "state-dir-too-open";
      mode: number;
    }
  | {
      kind: "config-file-too-open";
      mode: number;
    }
  | {
      kind: "missing-runtime-dir";
      label: "OAuth dir";
    }
  | {
      kind: "runtime-dir-not-writable";
      label: RuntimeDirLabel;
      hint?: string;
    }
);

function tryResolveNativeRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function areComparablePathsEqual(leftPath: string, rightPath: string): boolean {
  const leftRealPath = tryResolveNativeRealPath(leftPath);
  const rightRealPath = tryResolveNativeRealPath(rightPath);
  return leftRealPath !== null && leftRealPath === rightRealPath;
}

function isReachableConfiguredAgentDir(params: {
  agentsRoot: string;
  dirName: string;
  agentId: string;
}): boolean {
  if (params.dirName === params.agentId) {
    return true;
  }
  const rawDir = path.join(params.agentsRoot, params.dirName, "agent");
  const normalizedDir = path.join(params.agentsRoot, params.agentId, "agent");
  return areComparablePathsEqual(rawDir, normalizedDir);
}

function listOrphanAgentDirs(cfg: OpenClawConfig, stateDir: string): OrphanAgentDir[] {
  const configuredIds = new Set(listAgentIds(cfg));
  const sharedAuthOwnership = resolveSharedAuthStoreOwnership();
  const sharedAuthDbPath = resolveSharedAuthStorePath();
  const defaultAgentId = tryResolveDefaultAgentId(cfg);

  const agentsRoot = path.join(stateDir, "agents");
  const liveDefaultAgentDir = defaultAgentId ? resolveDefaultAgentDir(cfg) : undefined;
  try {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    return entries
      .flatMap((entry) => {
        if (!entry.isDirectory()) {
          return [];
        }
        const dirName = entry.name;
        const agentId = normalizeAgentId(dirName);
        const nestedAgentDir = path.join(agentsRoot, dirName, "agent");
        // Reserved system ids own state but cannot appear in the configured roster.
        if (
          !existsDir(nestedAgentDir) ||
          isReservedSystemAgentId(agentId) ||
          isSharedAuthStoreOwner({
            ownership: sharedAuthOwnership,
            agentAuthDbPath: resolveAuthProfileDatabasePath(nestedAgentDir),
            sharedAuthDbPath,
          }) ||
          (liveDefaultAgentDir && areComparablePathsEqual(nestedAgentDir, liveDefaultAgentDir)) ||
          (configuredIds.has(agentId) &&
            isReachableConfiguredAgentDir({ agentsRoot, dirName, agentId }))
        ) {
          return [];
        }
        return [{ dirName, agentId }];
      })
      .toSorted(
        (left, right) =>
          left.agentId.localeCompare(right.agentId) || left.dirName.localeCompare(right.dirName),
      );
  } catch {
    return [];
  }
}

function canWriteDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function dirPermissionHint(dir: string): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  try {
    const stat = fs.statSync(dir);
    if (uid !== null && stat.uid !== uid) {
      return `Owner mismatch (uid ${stat.uid}). Run: sudo chown -R $USER "${dir}"`;
    }
    if (gid !== null && stat.gid !== gid) {
      return `Group mismatch (gid ${stat.gid}). If access fails, run: sudo chown -R $USER "${dir}"`;
    }
  } catch {
    return null;
  }
  return null;
}

function readGroupOrWorldAccessibleMode(targetPath: string): number | null {
  const linkStat = fs.lstatSync(targetPath);
  const isSymlink = linkStat.isSymbolicLink();
  // Symlink permissions describe the link, not the target. Immutable stores cannot be repaired.
  const stat = isSymlink ? fs.statSync(targetPath) : linkStat;
  const resolvedPath = isSymlink ? fs.realpathSync(targetPath) : targetPath;
  return !resolvedPath.startsWith("/nix/store/") && (stat.mode & 0o077) !== 0 ? stat.mode : null;
}

function countJsonlLines(filePath: string): number {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return 0;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let count = 0;
    let endsWithNewline = true;
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) {
        break;
      }
      endsWithNewline = chunk[bytesRead - 1] === 0x0a;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] === 0x0a) {
          count += 1;
        }
      }
    }
    if (!endsWithNewline) {
      count += 1;
    }
    return count;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function isPairingPolicy(value: unknown): boolean {
  return normalizeOptionalLowercaseString(value) === "pairing";
}

function hasPairingPolicy(value: unknown): boolean {
  const record = asNullableObjectRecord(value);
  if (!record) {
    return false;
  }
  return (
    isPairingPolicy(record.dmPolicy) ||
    isPairingPolicy(asNullableObjectRecord(record.dm)?.policy) ||
    Object.values(asNullableObjectRecord(record.accounts) ?? {}).some(hasPairingPolicy)
  );
}

function shouldRequireOAuthDir(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_OAUTH_DIR?.trim()) {
    return true;
  }
  const channels = asNullableObjectRecord(cfg.channels);
  if (!channels) {
    return false;
  }
  const withPersistedAuth = new Set(
    listConfiguredChannelIdsForReadOnlyScope({
      config: cfg,
      env,
    }),
  );
  const withoutPersistedAuth = new Set(
    listConfiguredChannelIdsForReadOnlyScope({
      config: cfg,
      env,
      includePersistedAuthState: false,
    }),
  );
  if ([...withPersistedAuth].some((channelId) => !withoutPersistedAuth.has(channelId))) {
    return true;
  }
  // Pairing allowlists are persisted under credentials/<channel>-allowFrom.json, so a
  // channel id with no effective plugin owner can never pair and must not require the dir.
  for (const [channelId, channelCfg] of Object.entries(channels)) {
    const scopedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!scopedChannelId || !withPersistedAuth.has(scopedChannelId)) {
      continue;
    }
    if (hasPairingPolicy(channelCfg)) {
      return true;
    }
  }
  return false;
}

export function detectStateIntegrityHealthIssues(
  cfg: OpenClawConfig,
  params?: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): StateIntegrityHealthIssue[] {
  const issues: StateIntegrityHealthIssue[] = [];
  const appendDetectedIssue = (issue: StateIntegrityHealthIssue | null) => {
    if (issue) {
      issues.push(issue);
    }
  };
  const env = params?.env ?? process.env;
  const homedir = () => resolveRequiredHomeDir(env, params?.homedir ?? os.homedir);
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const dirCandidates = resolveSessionRuntimeDirectories(cfg, env, homedir);
  const requireOAuthDir = shouldRequireOAuthDir(cfg, env);

  const macCloud = detectMacCloudSyncedStateDir(stateDir);
  appendDetectedIssue(macCloud && { kind: "mac-cloud-state-dir", ...macCloud });

  const windowsCloud = detectWindowsCloudSyncedStateDir(stateDir, env);
  appendDetectedIssue(windowsCloud && { kind: "windows-cloud-state-dir", ...windowsCloud });

  const linuxSd = detectLinuxSdBackedStateDir(stateDir);
  appendDetectedIssue(linuxSd && { kind: "linux-sd-state-dir", ...linuxSd });

  const linuxVolatile = detectLinuxVolatileStateDir(stateDir);
  appendDetectedIssue(linuxVolatile && { kind: "linux-volatile-state-dir", ...linuxVolatile });

  const stateDirExists = existsDir(stateDir);
  if (!stateDirExists) {
    issues.push({ kind: "missing-state-dir", path: stateDir });
  }

  if (stateDirExists && !canWriteDir(stateDir)) {
    const hint = dirPermissionHint(stateDir);
    issues.push({
      kind: "state-dir-not-writable",
      path: stateDir,
      ...(hint ? { hint } : {}),
    });
  }

  if (stateDirExists && process.platform !== "win32") {
    try {
      const mode = readGroupOrWorldAccessibleMode(stateDir);
      if (mode !== null) {
        issues.push({ kind: "state-dir-too-open", path: stateDir, mode });
      }
    } catch {
      // Legacy noteStateIntegrity reports stat failures. Structured findings
      // are limited to actionable state that can be inspected safely.
    }
  }

  if (params?.configPath && existsFile(params.configPath) && process.platform !== "win32") {
    try {
      const mode = readGroupOrWorldAccessibleMode(params.configPath);
      if (mode !== null) {
        issues.push({ kind: "config-file-too-open", path: params.configPath, mode });
      }
    } catch {
      // See state-dir stat handling above.
    }
  }

  if (stateDirExists) {
    if (requireOAuthDir) {
      dirCandidates.set(oauthDir, "OAuth dir");
    }
    for (const [dir, label] of dirCandidates) {
      if (!existsDir(dir)) {
        if (label === "OAuth dir") {
          issues.push({ kind: "missing-runtime-dir", label, path: dir });
          continue;
        }
        // Transcript-archive writers create session dirs lazily (session-accessor.sqlite-archive.ts),
        // and readers tolerate ENOENT, so absence is healthy on fresh profiles.
        continue;
      }
      if (!canWriteDir(dir)) {
        const hint = dirPermissionHint(dir);
        issues.push({
          kind: "runtime-dir-not-writable",
          label,
          path: dir,
          ...(hint ? { hint } : {}),
        });
      }
    }
  }

  return issues;
}

export function stateIntegrityIssueToHealthFinding(
  issue: StateIntegrityHealthIssue,
): HealthFinding {
  const finding = (
    message: string,
    fixHint: string,
    severity: HealthFinding["severity"] = "warning",
    target?: string,
  ): HealthFinding => ({
    checkId: STATE_INTEGRITY_CHECK_ID,
    severity,
    message,
    path: issue.path,
    ...(target !== undefined ? { target } : {}),
    fixHint,
  });
  switch (issue.kind) {
    case "mac-cloud-state-dir":
      return finding(
        `State directory is under macOS cloud-synced storage (${issue.storage}), which can cause slow I/O and sync races.`,
        "Move OPENCLAW_STATE_DIR to local non-synced storage such as ~/.openclaw.",
      );
    case "windows-cloud-state-dir":
      return finding(
        `State directory is under Windows cloud-synced storage (${issue.storage}), which can cause slow I/O, sync races, and Files On-Demand dehydration.`,
        "Move OPENCLAW_STATE_DIR to local non-synced storage such as %USERPROFILE%\\.openclaw.",
      );
    case "linux-sd-state-dir":
      return finding(
        `State directory appears to be on SD/eMMC storage (${issue.source}, ${issue.fsType}), which can hurt startup and durability.`,
        "Move OPENCLAW_STATE_DIR to SSD/NVMe-backed storage.",
        "warning",
        issue.mountPoint,
      );
    case "linux-volatile-state-dir":
      return finding(
        `State directory is on volatile ${issue.fsType} storage and may disappear on reboot.`,
        "Move OPENCLAW_STATE_DIR to persistent local storage.",
        "warning",
        issue.mountPoint,
      );
    case "missing-state-dir":
      return finding(
        "State directory is missing. Sessions, credentials, logs, and config are stored there.",
        "Run `openclaw doctor --fix` to create the state directory.",
        "error",
      );
    case "state-dir-not-writable":
      return finding(
        issue.hint
          ? `State directory is not writable. ${issue.hint}`
          : "State directory is not writable.",
        "Run `openclaw doctor --fix` to repair state directory permissions.",
        "error",
      );
    case "state-dir-too-open":
      return finding(
        "State directory permissions are too open. Recommend chmod 700.",
        "Run `openclaw doctor --fix` to tighten state directory permissions.",
      );
    case "config-file-too-open":
      return finding(
        "Config file is group/world readable. Recommend chmod 600.",
        "Run `openclaw doctor --fix` to tighten config file permissions.",
      );
    case "missing-runtime-dir":
      return finding(
        `${issue.label} is missing.`,
        "Run `openclaw doctor --fix` to create missing runtime state directories.",
        "error",
      );
    case "runtime-dir-not-writable":
      return finding(
        issue.hint
          ? `${issue.label} is not writable. ${issue.hint}`
          : `${issue.label} is not writable.`,
        "Run `openclaw doctor --fix` to repair runtime state directory permissions.",
        "error",
      );
  }
  return assertNeverStateIntegrityIssue(issue);
}

export function stateIntegrityIssueToRepairEffect(
  issue: StateIntegrityHealthIssue,
): HealthRepairEffect {
  const effect = (
    action: string,
    dryRunSafe = false,
    kind: HealthRepairEffect["kind"] = "state",
  ): HealthRepairEffect => ({ kind, action, target: issue.path, dryRunSafe });
  switch (issue.kind) {
    case "mac-cloud-state-dir":
    case "windows-cloud-state-dir":
    case "linux-sd-state-dir":
    case "linux-volatile-state-dir":
      return effect("would-recommend-moving-state-dir", true);
    case "missing-state-dir":
      return effect("would-create-state-dir");
    case "state-dir-not-writable":
    case "state-dir-too-open":
      return effect("would-repair-state-dir-permissions");
    case "config-file-too-open":
      return effect("would-tighten-config-file-permissions", false, "file");
    case "missing-runtime-dir":
      return effect("would-create-runtime-state-dir");
    case "runtime-dir-not-writable":
      return effect("would-repair-runtime-state-dir-permissions");
  }
  return assertNeverStateIntegrityIssue(issue);
}

function assertNeverStateIntegrityIssue(issue: never): never {
  throw new Error(
    `Unhandled state integrity issue kind: ${String((issue as { kind?: unknown }).kind)}`,
  );
}

/** Emits state integrity warnings and applies selected runtime repairs. */
export async function noteStateIntegrity(
  cfg: OpenClawConfig,
  prompter: DoctorPrompterLike,
  configPath?: string,
  options?: { stateDirExistedAtStart?: boolean },
) {
  const warnings: string[] = [];
  const changes: string[] = [];
  const noteFn = prompter.note ?? note;
  const env = process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, homedir);
  const defaultStateDir = path.join(homedir(), ".openclaw");
  const oauthDir = resolveOAuthDir(env, stateDir);
  const dirCandidates = resolveSessionRuntimeDirectories(cfg, env, homedir);
  const displayStateDir = shortenHomePath(stateDir);
  const displayOauthDir = shortenHomePath(oauthDir);
  const displayConfigPath = configPath ? shortenHomePath(configPath) : undefined;
  const requireOAuthDir = shouldRequireOAuthDir(cfg, env);
  const cloudSyncedStateDir = detectMacCloudSyncedStateDir(stateDir);
  const windowsCloudSyncedStateDir = detectWindowsCloudSyncedStateDir(stateDir);
  const linuxSdBackedStateDir = detectLinuxSdBackedStateDir(stateDir);
  const linuxVolatileStateDir = detectLinuxVolatileStateDir(stateDir);
  const repairWritableDirectory = async (
    dir: string,
    displayDir: string,
    label?: RuntimeDirLabel,
  ) => {
    if (canWriteDir(dir)) {
      return;
    }
    warnings.push(`- ${label ?? "State directory"} not writable (${displayDir}).`);
    const hint = dirPermissionHint(dir);
    if (hint) {
      warnings.push(`  ${hint}`);
    }
    if (
      await prompter.confirmRuntimeRepair({
        message: `Repair permissions on ${label ?? displayDir}?`,
        initialValue: true,
      })
    ) {
      try {
        fs.chmodSync(dir, (fs.statSync(dir).mode & 0o777) | 0o700);
        changes.push(`- Repaired permissions on ${label ? `${label}: ` : ""}${displayDir}`);
      } catch (err) {
        warnings.push(`- Failed to repair ${displayDir}: ${String(err)}`);
      }
    }
  };
  const tightenPermissions = async (
    targetPath: string,
    displayPath: string,
    mode: number,
    warning: string,
    failureLabel: string,
  ) => {
    const octalMode = mode.toString(8);
    try {
      if (readGroupOrWorldAccessibleMode(targetPath) === null) {
        return;
      }
      warnings.push(warning);
      if (
        await prompter.confirmRuntimeRepair({
          message: `Tighten permissions on ${displayPath} to ${octalMode}?`,
          initialValue: true,
        })
      ) {
        fs.chmodSync(targetPath, mode);
        changes.push(`- Tightened permissions on ${displayPath} to ${octalMode}`);
      }
    } catch (err) {
      warnings.push(`- Failed to read ${failureLabel}: ${String(err)}`);
    }
  };

  if (cloudSyncedStateDir) {
    warnings.push(
      [
        `- State directory is under macOS cloud-synced storage (${displayStateDir}; ${cloudSyncedStateDir.storage}).`,
        "- This can cause slow I/O and sync/lock races for sessions and credentials.",
        "- Prefer a local non-synced state dir (for example: ~/.openclaw).",
        `  Set locally: OPENCLAW_STATE_DIR=~/.openclaw ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
    );
  }
  if (windowsCloudSyncedStateDir) {
    warnings.push(
      formatWindowsCloudSyncedStateDirWarning(displayStateDir, windowsCloudSyncedStateDir),
    );
  }
  if (linuxSdBackedStateDir) {
    warnings.push(formatLinuxSdBackedStateDirWarning(displayStateDir, linuxSdBackedStateDir));
  }
  if (linuxVolatileStateDir) {
    warnings.push(formatLinuxVolatileStateDirWarning(displayStateDir, linuxVolatileStateDir));
  }

  let stateDirExists = existsDir(stateDir);
  if (stateDirExists && options?.stateDirExistedAtStart === false) {
    warnings.push(
      `- State directory was missing at doctor start and was initialized during startup checks (${displayStateDir}).`,
    );
  }
  if (!stateDirExists) {
    warnings.push(
      `- CRITICAL: state directory missing (${displayStateDir}). Sessions, credentials, logs, and config are stored there.`,
    );
    if (cfg.gateway?.mode === "remote") {
      warnings.push(
        "- Gateway is in remote mode; run doctor on the remote host where the gateway runs.",
      );
    }
    const create = await prompter.confirmRuntimeRepair({
      message: `Create ${displayStateDir} now?`,
      initialValue: false,
    });
    if (create) {
      const created = ensureDir(stateDir);
      if (created.ok) {
        changes.push(`- Created ${displayStateDir}`);
        stateDirExists = true;
      } else {
        warnings.push(`- Failed to create ${displayStateDir}: ${created.error}`);
      }
    }
  }

  if (stateDirExists) {
    await repairWritableDirectory(stateDir, displayStateDir);
  }
  if (stateDirExists && process.platform !== "win32") {
    await tightenPermissions(
      stateDir,
      displayStateDir,
      0o700,
      `- State directory permissions are too open (${displayStateDir}). Recommend chmod 700.`,
      `${displayStateDir} permissions`,
    );
  }

  if (configPath && existsFile(configPath) && process.platform !== "win32") {
    await tightenPermissions(
      configPath,
      displayConfigPath ?? configPath,
      0o600,
      `- Config file is group/world readable (${displayConfigPath ?? configPath}). Recommend chmod 600.`,
      `config permissions (${displayConfigPath ?? configPath})`,
    );
  }

  if (stateDirExists) {
    if (requireOAuthDir) {
      dirCandidates.set(oauthDir, "OAuth dir");
    } else if (!existsDir(oauthDir)) {
      warnings.push(
        `- OAuth dir not present (${displayOauthDir}). Skipping create because no WhatsApp/pairing channel config is active.`,
      );
    }
    for (const [dir, label] of dirCandidates) {
      const displayDir = shortenHomePath(dir);
      if (!existsDir(dir)) {
        if (label !== "OAuth dir") {
          continue;
        }
        warnings.push(`- CRITICAL: ${label} missing (${displayDir}).`);
        const create = await prompter.confirmRuntimeRepair({
          message: `Create ${label} at ${displayDir}?`,
          initialValue: true,
        });
        if (create) {
          const created = ensureDir(dir);
          if (created.ok) {
            changes.push(`- Created ${label}: ${displayDir}`);
          } else {
            warnings.push(`- Failed to create ${displayDir}: ${created.error}`);
          }
        }
        continue;
      }
      await repairWritableDirectory(dir, displayDir, label);
    }
  }

  // Compare only the effective home's default; other accounts do not share this history.
  if (path.resolve(stateDir) !== path.resolve(defaultStateDir) && existsDir(defaultStateDir)) {
    warnings.push(
      [
        "- Multiple state directories detected. This can split session history.",
        `  - ${shortenHomePath(defaultStateDir)}`,
        `  Active state dir: ${displayStateDir}`,
      ].join("\n"),
    );
  }

  const orphanAgentDirs = listOrphanAgentDirs(cfg, stateDir);
  if (orphanAgentDirs.length > 0) {
    const labels = orphanAgentDirs
      .slice(0, 3)
      .map(({ dirName, agentId }) =>
        dirName === agentId ? agentId : `${dirName} (id ${agentId})`,
      );
    const remaining = orphanAgentDirs.length - labels.length;
    const authoredAgentRosterPath =
      readAgentRosterProperty(cfg)?.kind === "list" ? "agents.list" : "agents.entries";
    warnings.push(
      [
        `- Found ${countLabel(orphanAgentDirs.length, "agent directory", "agent directories")} on disk without a matching ${authoredAgentRosterPath} entry.`,
        "  These agents can still have sessions/auth state on disk, but config-driven routing, identity, and model selection will ignore them.",
        `  Examples: ${labels.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`,
        `  Restore the missing ${authoredAgentRosterPath} entries or remove stale dirs after confirming they are no longer needed: ${shortenHomePath(path.join(stateDir, "agents"))}`,
      ].join("\n"),
    );
  }
  if (stateDirExists) {
    warnings.push(...collectRetainedUnconfiguredAgentDatabaseWarnings({ cfg, env }));
  }

  const compatibilityAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const pending = readDeferredPluginMigrations({ env });
  const isRetained = createRetainedAgentDatabaseMatcher(env, () =>
    resolveConfiguredAgentDatabaseTargets(cfg, { env }),
  );
  const sessionTargets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env }).toSorted(
    (left, right) =>
      left.agentId === compatibilityAgentId ? -1 : right.agentId === compatibilityAgentId ? 1 : 0,
  );

  const inspectAgentSessionIntegrity = async (
    target: SessionStoreTarget,
    inspectLegacyStore: boolean,
  ) => {
    const { agentId, storePath } = target;
    const absoluteStorePath = path.resolve(storePath);

    const sqliteStorePath = resolveSqliteTargetFromSessionStorePath(absoluteStorePath, {
      agentId,
      defaultAgentId: compatibilityAgentId,
      env,
    }).path;
    if (isRetained(sqliteStorePath, agentId)) {
      return;
    }
    const legacyStore =
      inspectLegacyStore &&
      existsFile(absoluteStorePath) &&
      !preserveDeferredPluginSessionSource({ cfg, env, target, pending })
        ? loadLegacySessionStore(absoluteStorePath)
        : {};
    const legacyEntries = Object.entries(legacyStore).filter(
      (candidate): candidate is [string, SessionEntry] =>
        candidate[1] != null && typeof candidate[1] === "object",
    );
    const legacySessionKeys = new Set(legacyEntries.map(([sessionKey]) => sessionKey));
    const sqliteSessionKeys = new Set<string>();
    const isSessionKeyOccupied = (sessionKey: string) =>
      sqliteSessionKeys.has(sessionKey) || legacySessionKeys.has(sessionKey);
    const mainKey = resolveCanonicalMainSessionKey({
      agentId,
      mainKey: cfg.session?.mainKey,
      sessionScope: cfg.session?.scope,
    });
    const mainRecoveryWedged: MainSessionRecoveryIntegrityCandidate[] = [];
    const wedgedSubagentSessions: Array<{ key: string; reason: string }> = [];
    const sqlitePluginStateScanner = createPluginSessionStateDoctorScanner({ agentId, cfg, env });
    const legacyPluginStateScanner = createPluginSessionStateDoctorScanner({ agentId, cfg, env });
    let mainEntry: SessionEntry | undefined;
    const inspectMergedEntry = (sessionKey: string, entry: SessionEntry) => {
      if (sessionKey === mainKey) {
        mainEntry = entry;
      }
      if (isSubagentRecoveryWedgedEntry(entry)) {
        wedgedSubagentSessions.push({
          key: sessionKey,
          reason: formatSubagentRecoveryWedgedReason(entry),
        });
      }
    };
    const sqliteEntryCount = scanDoctorSessionEntriesStrict(
      { agentId, storePath: sqliteStorePath },
      ({ entry, sessionKey }) => {
        sqliteSessionKeys.add(sessionKey);
        sqlitePluginStateScanner.scanEntry(sessionKey, entry);
        inspectMergedEntry(sessionKey, entry);
        const recovery = inspectMainSessionRecoveryEntry(sessionKey, entry);
        if (recovery) {
          mainRecoveryWedged.push(recovery);
        }
      },
    );
    for (const [sessionKey, entry] of legacyEntries) {
      if (sqliteSessionKeys.has(sessionKey)) {
        continue;
      }
      legacyPluginStateScanner.scanEntry(sessionKey, entry);
      inspectMergedEntry(sessionKey, entry);
    }
    const sessionPathOpts = resolveSessionFilePathOptions({ agentId, storePath });
    await noteMainSessionRecoveryIntegrity({
      storePath: sqliteStorePath,
      wedged: mainRecoveryWedged,
      warnings,
      changes,
      confirmRepair: (params) => prompter.confirmRuntimeRepair(params),
    });
    // Session SQLite migration owns legacy transcript validation and archival.
    // Repeating it here turns healthy pending imports into integrity warnings.
    if (sqliteEntryCount > 0 || legacyEntries.length > 0) {
      if (wedgedSubagentSessions.length > 0) {
        const wedgedCount = countLabel(wedgedSubagentSessions.length, "wedged subagent session");
        warnings.push(
          [
            `- Found ${wedgedCount} with automatic restart recovery tombstoned.`,
            "  OpenClaw will not auto-resume these child sessions on restart; use Doctor to repair stale native subagent recovery state.",
            `  Examples: ${wedgedSubagentSessions
              .slice(0, 3)
              .map(({ key }) => key)
              .join(", ")}`,
            `  Fix: ${formatCliCommand("openclaw doctor --fix")}`,
          ].join("\n"),
        );
        const repairWedged = await prompter.confirmRuntimeRepair({
          message: `Clear stale aborted recovery flags for ${wedgedCount}?`,
          initialValue: true,
        });
        if (repairWedged) {
          let repaired = 0;
          const repairedAt = Date.now();
          const sqliteKeys = wedgedSubagentSessions
            .map(({ key }) => key)
            .filter((key) => sqliteSessionKeys.has(key));
          for (const sessionKeys of iterateDoctorSessionKeyBatches(sqliteKeys)) {
            repaired += await applySessionEntryReplacements<number>({
              agentId,
              sessionKeys,
              storePath: sqliteStorePath,
              update: (currentEntries) => {
                const replacements = currentEntries.filter(({ entry }) =>
                  clearWedgedSubagentRecoveryAbort(entry, repairedAt),
                );
                return { replacements, result: replacements.length };
              },
            });
          }
          const legacyKeys = wedgedSubagentSessions
            .map(({ key }) => key)
            .filter((key) => !sqliteSessionKeys.has(key));
          if (legacyKeys.length > 0 && existsFile(absoluteStorePath)) {
            await updateLegacySessionStore(absoluteStorePath, (currentStore) => {
              for (const key of legacyKeys) {
                const current = currentStore[key];
                if (current && clearWedgedSubagentRecoveryAbort(current, repairedAt)) {
                  repaired += 1;
                  currentStore[key] = current;
                }
              }
            });
          }
          if (repaired > 0) {
            changes.push(
              `- Cleared aborted restart-recovery flags for ${countLabel(
                repaired,
                "wedged subagent session",
              )}.`,
            );
          }
        }

        const wedgedReasons = wedgedSubagentSessions.map(({ reason }) => reason);
        const visibleWedgedReasons = uniqueStrings(wedgedReasons).slice(0, 2);
        if (visibleWedgedReasons.length > 0) {
          warnings.push(visibleWedgedReasons.map((reason) => `  Reason: ${reason}`).join("\n"));
        }
      }

      await runPluginSessionStateDoctorRepairs({
        scan: sqlitePluginStateScanner.result(),
        store: { kind: "sqlite", agentId, path: sqliteStorePath },
        prompter,
        warnings,
        changes,
      });
      await runPluginSessionStateDoctorRepairs({
        scan: legacyPluginStateScanner.result(),
        store: { kind: "legacy", path: absoluteStorePath },
        prompter,
        warnings,
        changes,
      });
      if (sqliteSessionKeys.has(mainKey)) {
        mainEntry = loadExactSessionEntryReadOnly({
          agentId,
          sessionKey: mainKey,
          storePath: sqliteStorePath,
        })?.entry;
      }

      const heartbeatMainMoved = await repairHeartbeatPoisonedMainSession({
        mainKey,
        mainEntry,
        isSessionKeyOccupied,
        store: sqliteSessionKeys.has(mainKey)
          ? { kind: "sqlite", agentId, path: sqliteStorePath }
          : { kind: "legacy", path: absoluteStorePath },
        stateDir,
        sessionPathOpts,
        prompter,
        warnings,
        changes,
      });

      // SQLite-owned transcripts live in the agent DB after import.
      // Do not require the archived legacy JSONL for those sessions.
      if (!heartbeatMainMoved && mainEntry?.sessionId && !sqliteSessionKeys.has(mainKey)) {
        const transcriptPath = resolveSessionFilePathCore(
          mainEntry.sessionId,
          mainEntry,
          sessionPathOpts,
        );
        if (!existsFile(transcriptPath)) {
          warnings.push(
            `- Main session transcript missing (${shortenHomePath(transcriptPath)}). History will appear to reset.`,
          );
        } else {
          const lineCount = countJsonlLines(transcriptPath);
          if (lineCount <= 1) {
            warnings.push(
              `- Main session transcript has only ${lineCount} line. Session history may not be appending.`,
            );
          }
        }
      }
    }
  };

  // A fixed store can map to several agent-owned SQLite targets but only one legacy JSON file.
  // Scan that file once under the compatibility owner so full-store work is not repeated.
  const inspectedLegacyStores = new Set<string>();
  for (const target of sessionTargets) {
    if (
      isRetained(target.storePath, target.agentId) ||
      readAgentDatabaseAdmissionRefusal(target.agentId, { env })
    ) {
      continue;
    }
    const legacyStorePath = path.resolve(target.storePath);
    const inspectLegacyStore =
      !legacyStorePath.endsWith(".sqlite") && !inspectedLegacyStores.has(legacyStorePath);
    await inspectAgentSessionIntegrity(target, inspectLegacyStore);
    inspectedLegacyStores.add(legacyStorePath);
  }
  for (const warning of await describeHeartbeatSessionTargetIssues(cfg)) {
    warnings.push(warning);
  }

  if (warnings.length > 0) {
    noteFn(warnings.join("\n"), "State integrity");
  }
  if (changes.length > 0) {
    noteFn(changes.join("\n"), "Doctor changes");
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
