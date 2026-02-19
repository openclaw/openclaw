import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIO } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { runExec } from "../process/exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createIcaclsResetCommand, formatIcaclsResetCommand, type ExecFn } from "./windows-acl.js";

export type SecurityFixChmodAction = {
  kind: "chmod";
  path: string;
  mode: number;
  ok: boolean;
  skipped?: string;
  error?: string;
};

export type SecurityFixIcaclsAction = {
  kind: "icacls";
  path: string;
  command: string;
  ok: boolean;
  skipped?: string;
  error?: string;
};

export type SecurityFixAction = SecurityFixChmodAction | SecurityFixIcaclsAction;

export type SecurityFixResult = {
  ok: boolean;
  stateDir: string;
  configPath: string;
  configWritten: boolean;
  changes: string[];
  actions: SecurityFixAction[];
  errors: string[];
};

async function safeChmod(params: {
  path: string;
  mode: number;
  require: "dir" | "file";
}): Promise<SecurityFixChmodAction> {
  try {
    const st = await fs.lstat(params.path);
    if (st.isSymbolicLink()) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "symlink",
      };
    }
    if (params.require === "dir" && !st.isDirectory()) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "not-a-directory",
      };
    }
    if (params.require === "file" && !st.isFile()) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "not-a-file",
      };
    }
    const current = st.mode & 0o777;
    if (current === params.mode) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "already",
      };
    }
    await fs.chmod(params.path, params.mode);
    return { kind: "chmod", path: params.path, mode: params.mode, ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "missing",
      };
    }
    return {
      kind: "chmod",
      path: params.path,
      mode: params.mode,
      ok: false,
      error: String(err),
    };
  }
}

async function safeAclReset(params: {
  path: string;
  require: "dir" | "file";
  env: NodeJS.ProcessEnv;
  exec?: ExecFn;
}): Promise<SecurityFixIcaclsAction> {
  const display = formatIcaclsResetCommand(params.path, {
    isDir: params.require === "dir",
    env: params.env,
  });
  try {
    const st = await fs.lstat(params.path);
    if (st.isSymbolicLink()) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "symlink",
      };
    }
    if (params.require === "dir" && !st.isDirectory()) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "not-a-directory",
      };
    }
    if (params.require === "file" && !st.isFile()) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "not-a-file",
      };
    }
    const cmd = createIcaclsResetCommand(params.path, {
      isDir: st.isDirectory(),
      env: params.env,
    });
    if (!cmd) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "missing-user",
      };
    }
    const exec = params.exec ?? runExec;
    await exec(cmd.command, cmd.args);
    return { kind: "icacls", path: params.path, command: cmd.display, ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "missing",
      };
    }
    return {
      kind: "icacls",
      path: params.path,
      command: display,
      ok: false,
      error: String(err),
    };
  }
}

function setGroupPolicyAllowlist(params: {
  cfg: OpenClawConfig;
  channel: string;
  changes: string[];
  policyFlips: Set<string>;
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
    params.policyFlips.add(`channels.${params.channel}.`);
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
      params.policyFlips.add(`channels.${params.channel}.accounts.${accountId}.`);
    }
  }
}

function setWhatsAppGroupAllowFromFromStore(params: {
  cfg: OpenClawConfig;
  storeAllowFrom: string[];
  changes: string[];
  policyFlips: Set<string>;
}): void {
  const section = params.cfg.channels?.whatsapp as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object") {
    return;
  }
  if (params.storeAllowFrom.length === 0) {
    return;
  }

  const maybeApply = (prefix: string, obj: Record<string, unknown>) => {
    if (!params.policyFlips.has(prefix)) {
      return;
    }
    const allowFrom = Array.isArray(obj.allowFrom) ? obj.allowFrom : [];
    const groupAllowFrom = Array.isArray(obj.groupAllowFrom) ? obj.groupAllowFrom : [];
    if (allowFrom.length > 0) {
      return;
    }
    if (groupAllowFrom.length > 0) {
      return;
    }
    obj.groupAllowFrom = params.storeAllowFrom;
    params.changes.push(`${prefix}groupAllowFrom=pairing-store`);
  };

  maybeApply("channels.whatsapp.", section);

  const accounts = section.accounts;
  if (!accounts || typeof accounts !== "object") {
    return;
  }
  for (const [accountId, accountValue] of Object.entries(accounts)) {
    if (!accountValue || typeof accountValue !== "object") {
      continue;
    }
    const account = accountValue as Record<string, unknown>;
    maybeApply(`channels.whatsapp.accounts.${accountId}.`, account);
  }
}

function applyConfigFixes(params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv }): {
  cfg: OpenClawConfig;
  changes: string[];
  policyFlips: Set<string>;
} {
  const next = structuredClone(params.cfg ?? {});
  const changes: string[] = [];
  const policyFlips = new Set<string>();

  if (next.logging?.redactSensitive === "off") {
    next.logging = { ...next.logging, redactSensitive: "tools" };
    changes.push('logging.redactSensitive=off -> "tools"');
  }

  for (const channel of [
    "telegram",
    "whatsapp",
    "discord",
    "signal",
    "imessage",
    "slack",
    "msteams",
  ]) {
    setGroupPolicyAllowlist({ cfg: next, channel, changes, policyFlips });
  }

  return { cfg: next, changes, policyFlips };
}

async function chmodCredentialsAndAgentState(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  cfg: OpenClawConfig;
  actions: SecurityFixAction[];
  applyPerms: (params: {
    path: string;
    mode: number;
    require: "dir" | "file";
  }) => Promise<SecurityFixAction>;
}): Promise<void> {
  const credsDir = resolveOAuthDir(params.env, params.stateDir);
  params.actions.push(await safeChmod({ path: credsDir, mode: 0o700, require: "dir" }));

  const credsEntries = await fs.readdir(credsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of credsEntries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".json")) {
      continue;
    }
    const p = path.join(credsDir, entry.name);
    // eslint-disable-next-line no-await-in-loop
    params.actions.push(await safeChmod({ path: p, mode: 0o600, require: "file" }));
  }

  const ids = new Set<string>();
  ids.add(resolveDefaultAgentId(params.cfg));
  const list = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents?.list : [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id.trim() : "";
    if (id) {
      ids.add(id);
    }
  }

  for (const agentId of ids) {
    const normalizedAgentId = normalizeAgentId(agentId);
    const agentRoot = path.join(params.stateDir, "agents", normalizedAgentId);
    const agentDir = path.join(agentRoot, "agent");
    const sessionsDir = path.join(agentRoot, "sessions");

    // eslint-disable-next-line no-await-in-loop
    params.actions.push(await safeChmod({ path: agentRoot, mode: 0o700, require: "dir" }));
    // eslint-disable-next-line no-await-in-loop
    params.actions.push(await params.applyPerms({ path: agentDir, mode: 0o700, require: "dir" }));

    const authPath = path.join(agentDir, "auth-profiles.json");
    // eslint-disable-next-line no-await-in-loop
    params.actions.push(await params.applyPerms({ path: authPath, mode: 0o600, require: "file" }));

    // eslint-disable-next-line no-await-in-loop
    params.actions.push(
      await params.applyPerms({ path: sessionsDir, mode: 0o700, require: "dir" }),
    );

    const storePath = path.join(sessionsDir, "sessions.json");
    // eslint-disable-next-line no-await-in-loop
    params.actions.push(await params.applyPerms({ path: storePath, mode: 0o600, require: "file" }));

    // Fix permissions on session transcript files (*.jsonl)
    // eslint-disable-next-line no-await-in-loop
    const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionEntries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      const p = path.join(sessionsDir, entry.name);
      // eslint-disable-next-line no-await-in-loop
      params.actions.push(await params.applyPerms({ path: p, mode: 0o600, require: "file" }));
    }
  }
}

export async function fixSecurityFootguns(opts?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
}): Promise<SecurityFixResult> {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const exec = opts?.exec ?? runExec;
  const isWindows = platform === "win32";
  const stateDir = opts?.stateDir ?? resolveStateDir(env);
  const configPath = opts?.configPath ?? resolveConfigPath(env, stateDir);
  const actions: SecurityFixAction[] = [];
  const errors: string[] = [];

  const io = createConfigIO({ env, configPath });
  const snap = await io.readConfigFileSnapshot();
  if (!snap.valid) {
    errors.push(...snap.issues.map((i) => `${i.path}: ${i.message}`));
  }

  let configWritten = false;
  let changes: string[] = [];
  if (snap.valid) {
    const fixed = applyConfigFixes({ cfg: snap.config, env });
    changes = fixed.changes;

    const whatsappStoreAllowFrom = await readChannelAllowFromStore("whatsapp", env).catch(() => []);
    if (whatsappStoreAllowFrom.length > 0) {
      setWhatsAppGroupAllowFromFromStore({
        cfg: fixed.cfg,
        storeAllowFrom: whatsappStoreAllowFrom,
        changes,
        policyFlips: fixed.policyFlips,
      });
    }

    if (changes.length > 0) {
      try {
        await io.writeConfigFile(fixed.cfg);
        configWritten = true;
      } catch (err) {
        errors.push(`writeConfigFile failed: ${String(err)}`);
      }
    }
  }

  const applyPerms = (params: { path: string; mode: number; require: "dir" | "file" }) =>
    isWindows
      ? safeAclReset({ path: params.path, require: params.require, env, exec })
      : safeChmod({ path: params.path, mode: params.mode, require: params.require });

  actions.push(await applyPerms({ path: stateDir, mode: 0o700, require: "dir" }));
  actions.push(await applyPerms({ path: configPath, mode: 0o600, require: "file" }));

  if (snap.exists) {
    const includePaths = await collectIncludePathsRecursive({
      configPath: snap.path,
      parsed: snap.parsed,
    }).catch(() => []);
    for (const p of includePaths) {
      // eslint-disable-next-line no-await-in-loop
      actions.push(await applyPerms({ path: p, mode: 0o600, require: "file" }));
    }
  }

  await chmodCredentialsAndAgentState({
    env,
    stateDir,
    cfg: snap.config ?? {},
    actions,
    applyPerms,
  }).catch((err) => {
    errors.push(`chmodCredentialsAndAgentState failed: ${String(err)}`);
  });

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
