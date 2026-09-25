// Applies safe automatic fixes for supported security audit findings.
import fs from "node:fs/promises";
import path from "node:path";
import { modeBits } from "@openclaw/fs-safe/permissions";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { listAgentIds, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAuthProfileDatabaseFilePaths } from "../agents/auth-profiles/sqlite.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createConfigIO, replaceConfigFile } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExec } from "../process/exec.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../routing/session-key.js";
import { createIcaclsResetCommand, formatIcaclsResetCommand, type ExecFn } from "./windows-acl.js";

type SecurityFixAction = {
  path: string;
  ok: boolean;
  skipped?: string;
  error?: string;
} & ({ kind: "chmod"; mode: number } | { kind: "icacls"; command: string });

type SecurityFixResult = {
  ok: boolean;
  stateDir: string;
  configPath: string;
  configWritten: boolean;
  changes: string[];
  actions: SecurityFixAction[];
  errors: string[];
};

type SecurityPermissionTarget = {
  path: string;
  mode: number;
  require: "dir" | "file";
};

async function applyPermissionFix(
  target: SecurityPermissionTarget,
  options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exec: ExecFn },
): Promise<SecurityFixAction> {
  const action: SecurityFixAction =
    options.platform === "win32"
      ? {
          kind: "icacls",
          path: target.path,
          command: formatIcaclsResetCommand(target.path, {
            isDir: target.require === "dir",
            env: options.env,
          }),
          ok: false,
        }
      : { kind: "chmod", path: target.path, mode: target.mode, ok: false };
  try {
    const st = await fs.lstat(target.path);
    if (st.isSymbolicLink()) {
      return { ...action, skipped: "symlink" };
    }
    if (target.require === "dir" && !st.isDirectory()) {
      return { ...action, skipped: "not-a-directory" };
    }
    if (target.require === "file" && !st.isFile()) {
      return { ...action, skipped: "not-a-file" };
    }
    if (action.kind === "chmod") {
      if (modeBits(st.mode) === target.mode) {
        return { ...action, skipped: "already" };
      }
      await fs.chmod(target.path, target.mode);
    } else {
      const cmd = createIcaclsResetCommand(target.path, {
        isDir: st.isDirectory(),
        env: options.env,
      });
      if (!cmd) {
        return { ...action, skipped: "missing-user" };
      }
      await options.exec(cmd.command, cmd.args);
      action.command = cmd.display;
    }
    return { ...action, ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === "ENOENT"
      ? { ...action, skipped: "missing" }
      : { ...action, error: String(err) };
  }
}

function setGroupPolicyAllowlist(params: {
  cfg: OpenClawConfig;
  channel: string;
  changes: string[];
}): void {
  if (!params.cfg.channels) {
    return;
  }
  const section = params.cfg.channels[params.channel as keyof OpenClawConfig["channels"]] as
    | Record<string, unknown>
    | undefined;
  if (!section || typeof section !== "object") {
    return;
  }

  const topPolicy = section.groupPolicy;
  if (topPolicy === "open") {
    section.groupPolicy = "allowlist";
    params.changes.push(`channels.${params.channel}.groupPolicy=open -> allowlist`);
  }

  const accounts = section.accounts;
  if (!accounts || typeof accounts !== "object") {
    return;
  }
  for (const [accountId, accountValue] of Object.entries(accounts)) {
    if (!accountId) {
      continue;
    }
    if (!accountValue || typeof accountValue !== "object") {
      continue;
    }
    const account = accountValue as Record<string, unknown>;
    if (account.groupPolicy === "open") {
      account.groupPolicy = "allowlist";
      params.changes.push(
        `channels.${params.channel}.accounts.${accountId}.groupPolicy=open -> allowlist`,
      );
    }
  }
}

async function applySecurityFixConfigMutations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelPlugins?: ChannelPlugin[];
}): Promise<{
  cfg: OpenClawConfig;
  changes: string[];
}> {
  const channelFixes = await collectChannelSecurityConfigFixMutation({
    cfg: params.cfg,
    env: params.env,
    channelPlugins: params.channelPlugins,
  });
  const cfg = structuredClone(channelFixes.cfg ?? {});
  const changes: string[] = [];
  for (const channel of Object.keys(cfg.channels ?? {})) {
    setGroupPolicyAllowlist({ cfg, channel, changes });
  }
  return {
    cfg,
    changes: [...changes, ...channelFixes.changes],
  };
}

async function collectChannelSecurityConfigFixMutation(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelPlugins?: ChannelPlugin[];
}) {
  let nextCfg = params.cfg;
  const changes: string[] = [];
  const collectPlugins = async (): Promise<ChannelPlugin[]> => {
    if (params.channelPlugins) {
      return params.channelPlugins;
    }
    try {
      const pluginIds = Object.keys(params.cfg.channels ?? {}).filter(Boolean);
      if (pluginIds.length === 0) {
        return [];
      }
      const wanted = new Set(pluginIds);
      const { listBundledChannelPlugins } = await import("../channels/plugins/bundled.js");
      return listBundledChannelPlugins().filter((plugin) => wanted.has(plugin.id));
    } catch {
      return [];
    }
  };

  for (const plugin of await collectPlugins()) {
    const mutation = await plugin.security?.applyConfigFixes?.({
      cfg: nextCfg,
      env: params.env,
    });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
  }
  return { cfg: nextCfg, changes };
}

async function collectSecurityPermissionTargets(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  configPath: string;
  cfg: OpenClawConfig;
  includePaths?: readonly string[];
}): Promise<SecurityPermissionTarget[]> {
  const targets: SecurityPermissionTarget[] = [
    { path: params.stateDir, mode: 0o700, require: "dir" },
    { path: params.configPath, mode: 0o600, require: "file" },
    ...(params.includePaths ?? []).map((targetPath) => ({
      path: targetPath,
      mode: 0o600,
      require: "file" as const,
    })),
  ];
  const credsDir = resolveOAuthDir(params.env, params.stateDir);
  targets.push({ path: credsDir, mode: 0o700, require: "dir" });
  const collectFiles = async (directory: string, suffix: string) => {
    const { entries } = await walkDirectory(directory, {
      maxDepth: 1,
      symlinks: "skip",
      include: (entry) => entry.kind === "file" && entry.name.endsWith(suffix),
    }).catch(() => ({ entries: [] }));
    for (const entry of entries) {
      targets.push({ path: path.join(directory, entry.name), mode: 0o600, require: "file" });
    }
  };
  await collectFiles(credsDir, ".json");

  const ids = new Set([LEGACY_IMPLICIT_AGENT_ID]);
  const defaultAgentId = tryResolveDefaultAgentId(params.cfg);
  if (defaultAgentId) {
    ids.add(defaultAgentId);
  }
  for (const id of listAgentIds(params.cfg)) {
    ids.add(id);
  }

  for (const normalizedAgentId of ids) {
    const agentRoot = path.join(params.stateDir, "agents", normalizedAgentId);
    const agentDir = path.join(agentRoot, "agent");
    const sessionsDir = path.join(agentRoot, "sessions");

    targets.push({ path: agentRoot, mode: 0o700, require: "dir" });
    targets.push({ path: agentDir, mode: 0o700, require: "dir" });

    for (const databasePath of resolveAuthProfileDatabaseFilePaths(agentDir)) {
      targets.push({ path: databasePath, mode: 0o600, require: "file" });
    }
    const authPath = path.join(agentDir, "auth-profiles.json");
    targets.push({ path: authPath, mode: 0o600, require: "file" });

    targets.push({ path: sessionsDir, mode: 0o700, require: "dir" });

    const storePath = path.join(sessionsDir, "sessions.json");
    targets.push({ path: storePath, mode: 0o600, require: "file" });

    await collectFiles(sessionsDir, ".jsonl");
  }
  return targets;
}

export async function fixSecurityFootguns(opts?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  channelPlugins?: ChannelPlugin[];
}): Promise<SecurityFixResult> {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const exec = opts?.exec ?? runExec;
  const stateDir = opts?.stateDir ?? resolveStateDir(env);
  const configPath = opts?.configPath ?? resolveConfigPath(env, stateDir);
  const actions: SecurityFixAction[] = [];
  const errors: string[] = [];

  const io = createConfigIO({ env, configPath });
  const { snapshot: snap, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snap.valid) {
    errors.push(...snap.issues.map((i) => `${i.path}: ${i.message}`));
  }

  let configWritten = false;
  let changes: string[] = [];
  if (snap.valid) {
    const fixed = await applySecurityFixConfigMutations({
      cfg: snap.config,
      env,
      channelPlugins: opts?.channelPlugins,
    });
    changes = fixed.changes;

    if (changes.length > 0) {
      try {
        await replaceConfigFile({
          nextConfig: fixed.cfg,
          snapshot: snap,
          writeOptions,
          io,
          afterWrite: { mode: "auto" },
        });
        configWritten = true;
      } catch (err) {
        errors.push(`replaceConfigFile failed: ${String(err)}`);
      }
    }
  }

  let includePaths: string[] = [];
  if (snap.exists) {
    includePaths = await collectIncludePathsRecursive({
      configPath: snap.path,
      parsed: snap.parsed,
      env,
    }).catch(() => []);
  }

  const permissionTargets = await collectSecurityPermissionTargets({
    env,
    stateDir,
    configPath,
    cfg: snap.config ?? {},
    includePaths,
  }).catch((err: unknown) => {
    errors.push(`collectSecurityPermissionTargets failed: ${String(err)}`);
    return [] as SecurityPermissionTarget[];
  });
  for (const target of permissionTargets) {
    actions.push(await applyPermissionFix(target, { env, platform, exec }));
  }

  return {
    ok: errors.length === 0,
    stateDir,
    configPath,
    configWritten,
    changes,
    actions,
    errors,
  };
}
