/**
 * Asynchronous security audit collector functions.
 *
 * These functions perform I/O (filesystem, config reads) to detect security issues.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import type { SkillScanFinding } from "./skill-scanner.js";
import type { ExecFn } from "./windows-acl.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { isToolAllowedByPolicies } from "../agents/pi-tools.policy.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "../agents/sandbox.js";
import { loadWorkspaceSkillEntries } from "../agents/skills.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { resolveNativeSkillsEnabled } from "../config/commands.js";
import { createConfigIO } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveOAuthDir } from "../config/paths.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
} from "./audit-fs.js";
import { pickSandboxToolPolicy } from "./audit-tool-policy.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "./scan-paths.js";
import * as skillScanner from "./skill-scanner.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function expandTilde(p: string, env: NodeJS.ProcessEnv): string | null {
  if (!p.startsWith("~")) {
    return p;
  }
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
  if (!home) {
    return null;
  }
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(home, p.slice(2));
  }
  return null;
}

async function readPluginManifestExtensions(pluginPath: string): Promise<string[]> {
  const manifestPath = path.join(pluginPath, "package.json");
  const raw = await fs.readFile(manifestPath, "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw) as Partial<
    Record<typeof MANIFEST_KEY, { extensions?: unknown }>
  > | null;
  const extensions = parsed?.[MANIFEST_KEY]?.extensions;
  if (!Array.isArray(extensions)) {
    return [];
  }
  return extensions.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function listWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}

function formatCodeSafetyDetails(findings: SkillScanFinding[], rootDir: string): string {
  return findings
    .map((finding) => {
      const relPath = path.relative(rootDir, finding.file);
      const filePath =
        relPath && relPath !== "." && !relPath.startsWith("..")
          ? relPath
          : path.basename(finding.file);
      const normalizedPath = filePath.replaceAll("\\", "/");
      return `  - [${finding.ruleId}] ${finding.message} (${normalizedPath}:${finding.line})`;
    })
    .join("\n");
}

function resolveToolPolicies(params: {
  cfg: OpenClawConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
}): Array<SandboxToolPolicy | undefined> {
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  const policies: Array<SandboxToolPolicy | undefined> = [
    profilePolicy,
    pickSandboxToolPolicy(params.cfg.tools ?? undefined),
    pickSandboxToolPolicy(params.agentTools),
  ];
  if (params.sandboxMode === "all") {
    policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined));
  }
  return policies;
}

function normalizePluginIdSet(entries: string[]): Set<string> {
  return new Set(entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function resolveEnabledExtensionPluginIds(params: {
  cfg: OpenClawConfig;
  pluginDirs: string[];
}): string[] {
  const normalized = normalizePluginsConfig(params.cfg.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const allowSet = normalizePluginIdSet(normalized.allow);
  const denySet = normalizePluginIdSet(normalized.deny);
  const entryById = new Map<string, { enabled?: boolean }>();
  for (const [id, entry] of Object.entries(normalized.entries)) {
    entryById.set(id.trim().toLowerCase(), entry);
  }

  const enabled: string[] = [];
  for (const id of params.pluginDirs) {
    const normalizedId = id.trim().toLowerCase();
    if (!normalizedId) {
      continue;
    }
    if (denySet.has(normalizedId)) {
      continue;
    }
    if (allowSet.size > 0 && !allowSet.has(normalizedId)) {
      continue;
    }
    if (entryById.get(normalizedId)?.enabled === false) {
      continue;
    }
    enabled.push(normalizedId);
  }
  return enabled;
}

function collectAllowEntries(config?: { allow?: string[]; alsoAllow?: string[] }): string[] {
  const out: string[] = [];
  if (Array.isArray(config?.allow)) {
    out.push(...config.allow);
  }
  if (Array.isArray(config?.alsoAllow)) {
    out.push(...config.alsoAllow);
  }
  return out.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function hasExplicitPluginAllow(params: {
  allowEntries: string[];
  enabledPluginIds: Set<string>;
}): boolean {
  return params.allowEntries.some(
    (entry) => entry === "group:plugins" || params.enabledPluginIds.has(entry),
  );
}

function hasProviderPluginAllow(params: {
  byProvider?: Record<string, { allow?: string[]; alsoAllow?: string[]; deny?: string[] }>;
  enabledPluginIds: Set<string>;
}): boolean {
  if (!params.byProvider) {
    return false;
  }
  for (const policy of Object.values(params.byProvider)) {
    if (
      hasExplicitPluginAllow({
        allowEntries: collectAllowEntries(policy),
        enabledPluginIds: params.enabledPluginIds,
      })
    ) {
      return true;
    }
  }
  return false;
}

// --------------------------------------------------------------------------
// Exported collectors
// --------------------------------------------------------------------------

export async function collectPluginsTrustFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const extensionsDir = path.join(params.stateDir, "extensions");
  const st = await safeStat(extensionsDir);
  if (!st.ok || !st.isDir) {
    return findings;
  }

  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
  const pluginDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(Boolean);
  if (pluginDirs.length === 0) {
    return findings;
  }

  const allow = params.cfg.plugins?.allow;
  const allowConfigured = Array.isArray(allow) && allow.length > 0;
  if (!allowConfigured) {
    const hasString = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    const hasAccountStringKey = (account: unknown, key: string) =>
      Boolean(
        account &&
        typeof account === "object" &&
        hasString((account as Record<string, unknown>)[key]),
      );

    const discordConfigured =
      hasString(params.cfg.channels?.discord?.token) ||
      Boolean(
        params.cfg.channels?.discord?.accounts &&
        Object.values(params.cfg.channels.discord.accounts).some((a) =>
          hasAccountStringKey(a, "token"),
        ),
      ) ||
      hasString(process.env.DISCORD_BOT_TOKEN);

    const telegramConfigured =
      hasString(params.cfg.channels?.telegram?.botToken) ||
      hasString(params.cfg.channels?.telegram?.tokenFile) ||
      Boolean(
        params.cfg.channels?.telegram?.accounts &&
        Object.values(params.cfg.channels.telegram.accounts).some(
          (a) => hasAccountStringKey(a, "botToken") || hasAccountStringKey(a, "tokenFile"),
        ),
      ) ||
      hasString(process.env.TELEGRAM_BOT_TOKEN);

    const slackConfigured =
      hasString(params.cfg.channels?.slack?.botToken) ||
      hasString(params.cfg.channels?.slack?.appToken) ||
      Boolean(
        params.cfg.channels?.slack?.accounts &&
        Object.values(params.cfg.channels.slack.accounts).some(
          (a) => hasAccountStringKey(a, "botToken") || hasAccountStringKey(a, "appToken"),
        ),
      ) ||
      hasString(process.env.SLACK_BOT_TOKEN) ||
      hasString(process.env.SLACK_APP_TOKEN);

    const skillCommandsLikelyExposed =
      (discordConfigured &&
        resolveNativeSkillsEnabled({
          providerId: "discord",
          providerSetting: params.cfg.channels?.discord?.commands?.nativeSkills,
          globalSetting: params.cfg.commands?.nativeSkills,
        })) ||
      (telegramConfigured &&
        resolveNativeSkillsEnabled({
          providerId: "telegram",
          providerSetting: params.cfg.channels?.telegram?.commands?.nativeSkills,
          globalSetting: params.cfg.commands?.nativeSkills,
        })) ||
      (slackConfigured &&
        resolveNativeSkillsEnabled({
          providerId: "slack",
          providerSetting: params.cfg.channels?.slack?.commands?.nativeSkills,
          globalSetting: params.cfg.commands?.nativeSkills,
        }));

    findings.push({
      checkId: "plugins.extensions_no_allowlist",
      severity: skillCommandsLikelyExposed ? "critical" : "warn",
      title: "Extensions exist but plugins.allow is not set",
      detail:
        `Found ${pluginDirs.length} extension(s) under ${extensionsDir}. Without plugins.allow, any discovered plugin id may load (depending on config and plugin behavior).` +
        (skillCommandsLikelyExposed
          ? "\nNative skill commands are enabled on at least one configured chat surface; treat unpinned/unallowlisted extensions as high risk."
          : ""),
      remediation: "Set plugins.allow to an explicit list of plugin ids you trust.",
    });
  }

  const enabledExtensionPluginIds = resolveEnabledExtensionPluginIds({
    cfg: params.cfg,
    pluginDirs,
  });
  if (enabledExtensionPluginIds.length > 0) {
    const enabledPluginSet = new Set(enabledExtensionPluginIds);
    const contexts: Array<{
      label: string;
      agentId?: string;
      tools?: AgentToolsConfig;
    }> = [{ label: "default" }];
    for (const entry of params.cfg.agents?.list ?? []) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
        continue;
      }
      contexts.push({
        label: `agents.list.${entry.id}`,
        agentId: entry.id,
        tools: entry.tools,
      });
    }

    const permissiveContexts: string[] = [];
    for (const context of contexts) {
      const profile = context.tools?.profile ?? params.cfg.tools?.profile;
      const restrictiveProfile = Boolean(resolveToolProfilePolicy(profile));
      const sandboxMode = resolveSandboxConfigForAgent(params.cfg, context.agentId).mode;
      const policies = resolveToolPolicies({
        cfg: params.cfg,
        agentTools: context.tools,
        sandboxMode,
        agentId: context.agentId,
      });
      const broadPolicy = isToolAllowedByPolicies("__openclaw_plugin_probe__", policies);
      const explicitPluginAllow =
        !restrictiveProfile &&
        (hasExplicitPluginAllow({
          allowEntries: collectAllowEntries(params.cfg.tools),
          enabledPluginIds: enabledPluginSet,
        }) ||
          hasProviderPluginAllow({
            byProvider: params.cfg.tools?.byProvider,
            enabledPluginIds: enabledPluginSet,
          }) ||
          hasExplicitPluginAllow({
            allowEntries: collectAllowEntries(context.tools),
            enabledPluginIds: enabledPluginSet,
          }) ||
          hasProviderPluginAllow({
            byProvider: context.tools?.byProvider,
            enabledPluginIds: enabledPluginSet,
          }));

      if (broadPolicy || explicitPluginAllow) {
        permissiveContexts.push(context.label);
      }
    }

    if (permissiveContexts.length > 0) {
      findings.push({
        checkId: "plugins.tools_reachable_permissive_policy",
        severity: "warn",
        title: "Extension plugin tools may be reachable under permissive tool policy",
        detail:
          `Enabled extension plugins: ${enabledExtensionPluginIds.join(", ")}.\n` +
          `Permissive tool policy contexts:\n${permissiveContexts.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Use restrictive profiles (`minimal`/`coding`) or explicit tool allowlists that exclude plugin tools for agents handling untrusted input.",
      });
    }
  }

  return findings;
}

export async function collectIncludeFilePermFindings(params: {
  configSnapshot: ConfigFileSnapshot;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  if (!params.configSnapshot.exists) {
    return findings;
  }

  const configPath = params.configSnapshot.path;
  const includePaths = await collectIncludePathsRecursive({
    configPath,
    parsed: params.configSnapshot.parsed,
  });
  if (includePaths.length === 0) {
    return findings;
  }

  for (const p of includePaths) {
    // eslint-disable-next-line no-await-in-loop
    const perms = await inspectPathPermissions(p, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) {
      continue;
    }
    if (perms.worldWritable || perms.groupWritable) {
      findings.push({
        checkId: "fs.config_include.perms_writable",
        severity: "critical",
        title: "Config include file is writable by others",
        detail: `${formatPermissionDetail(p, perms)}; another user could influence your effective config.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (perms.worldReadable) {
      findings.push({
        checkId: "fs.config_include.perms_world_readable",
        severity: "critical",
        title: "Config include file is world-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (perms.groupReadable) {
      findings.push({
        checkId: "fs.config_include.perms_group_readable",
        severity: "warn",
        title: "Config include file is group-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    }
  }

  return findings;
}

export async function collectStateDeepFilesystemFindings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const oauthDir = resolveOAuthDir(params.env, params.stateDir);

  const oauthPerms = await inspectPathPermissions(oauthDir, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (oauthPerms.ok && oauthPerms.isDir) {
    if (oauthPerms.worldWritable || oauthPerms.groupWritable) {
      findings.push({
        checkId: "fs.credentials_dir.perms_writable",
        severity: "critical",
        title: "Credentials dir is writable by others",
        detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; another user could drop/modify credential files.`,
        remediation: formatPermissionRemediation({
          targetPath: oauthDir,
          perms: oauthPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (oauthPerms.groupReadable || oauthPerms.worldReadable) {
      findings.push({
        checkId: "fs.credentials_dir.perms_readable",
        severity: "warn",
        title: "Credentials dir is readable by others",
        detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; credentials and allowlists can be sensitive.`,
        remediation: formatPermissionRemediation({
          targetPath: oauthDir,
          perms: oauthPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    }
  }

  const agentIds = Array.isArray(params.cfg.agents?.list)
    ? params.cfg.agents?.list
        .map((a) => (a && typeof a === "object" && typeof a.id === "string" ? a.id.trim() : ""))
        .filter(Boolean)
    : [];
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const ids = Array.from(new Set([defaultAgentId, ...agentIds])).map((id) => normalizeAgentId(id));

  for (const agentId of ids) {
    const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    // eslint-disable-next-line no-await-in-loop
    const authPerms = await inspectPathPermissions(authPath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (authPerms.ok) {
      if (authPerms.worldWritable || authPerms.groupWritable) {
        findings.push({
          checkId: "fs.auth_profiles.perms_writable",
          severity: "critical",
          title: "auth-profiles.json is writable by others",
          detail: `${formatPermissionDetail(authPath, authPerms)}; another user could inject credentials.`,
          remediation: formatPermissionRemediation({
            targetPath: authPath,
            perms: authPerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      } else if (authPerms.worldReadable || authPerms.groupReadable) {
        findings.push({
          checkId: "fs.auth_profiles.perms_readable",
          severity: "warn",
          title: "auth-profiles.json is readable by others",
          detail: `${formatPermissionDetail(authPath, authPerms)}; auth-profiles.json contains API keys and OAuth tokens.`,
          remediation: formatPermissionRemediation({
            targetPath: authPath,
            perms: authPerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      }
    }

    const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
    // eslint-disable-next-line no-await-in-loop
    const storePerms = await inspectPathPermissions(storePath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (storePerms.ok) {
      if (storePerms.worldReadable || storePerms.groupReadable) {
        findings.push({
          checkId: "fs.sessions_store.perms_readable",
          severity: "warn",
          title: "sessions.json is readable by others",
          detail: `${formatPermissionDetail(storePath, storePerms)}; routing and transcript metadata can be sensitive.`,
          remediation: formatPermissionRemediation({
            targetPath: storePath,
            perms: storePerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      }
    }
  }

  const logFile =
    typeof params.cfg.logging?.file === "string" ? params.cfg.logging.file.trim() : "";
  if (logFile) {
    const expanded = logFile.startsWith("~") ? expandTilde(logFile, params.env) : logFile;
    if (expanded) {
      const logPath = path.resolve(expanded);
      const logPerms = await inspectPathPermissions(logPath, {
        env: params.env,
        platform: params.platform,
        exec: params.execIcacls,
      });
      if (logPerms.ok) {
        if (logPerms.worldReadable || logPerms.groupReadable) {
          findings.push({
            checkId: "fs.log_file.perms_readable",
            severity: "warn",
            title: "Log file is readable by others",
            detail: `${formatPermissionDetail(logPath, logPerms)}; logs can contain private messages and tool output.`,
            remediation: formatPermissionRemediation({
              targetPath: logPath,
              perms: logPerms,
              isDir: false,
              posixMode: 0o600,
              env: params.env,
            }),
          });
        }
      }
    }
  }

  return findings;
}

export async function readConfigSnapshotForAudit(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    env: params.env,
    configPath: params.configPath,
  }).readConfigFileSnapshot();
}

export async function collectPluginsCodeSafetyFindings(params: {
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const extensionsDir = path.join(params.stateDir, "extensions");
  const st = await safeStat(extensionsDir);
  if (!st.ok || !st.isDir) {
    return findings;
  }

  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err) => {
    findings.push({
      checkId: "plugins.code_safety.scan_failed",
      severity: "warn",
      title: "Plugin extensions directory scan failed",
      detail: `Static code scan could not list extensions directory: ${String(err)}`,
      remediation:
        "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`.",
    });
    return [];
  });
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const pluginName of pluginDirs) {
    const pluginPath = path.join(extensionsDir, pluginName);
    const extensionEntries = await readPluginManifestExtensions(pluginPath).catch(() => []);
    const forcedScanEntries: string[] = [];
    const escapedEntries: string[] = [];

    for (const entry of extensionEntries) {
      const resolvedEntry = path.resolve(pluginPath, entry);
      if (!isPathInside(pluginPath, resolvedEntry)) {
        escapedEntries.push(entry);
        continue;
      }
      if (extensionUsesSkippedScannerPath(entry)) {
        findings.push({
          checkId: "plugins.code_safety.entry_path",
          severity: "warn",
          title: `Plugin "${pluginName}" entry path is hidden or node_modules`,
          detail: `Extension entry "${entry}" points to a hidden or node_modules path. Deep code scan will cover this entry explicitly, but review this path choice carefully.`,
          remediation: "Prefer extension entrypoints under normal source paths like dist/ or src/.",
        });
      }
      forcedScanEntries.push(resolvedEntry);
    }

    if (escapedEntries.length > 0) {
      findings.push({
        checkId: "plugins.code_safety.entry_escape",
        severity: "critical",
        title: `Plugin "${pluginName}" has extension entry path traversal`,
        detail: `Found extension entries that escape the plugin directory:\n${escapedEntries.map((entry) => `  - ${entry}`).join("\n")}`,
        remediation:
          "Update the plugin manifest so all openclaw.extensions entries stay inside the plugin directory.",
      });
    }

    const summary = await skillScanner
      .scanDirectoryWithSummary(pluginPath, {
        includeFiles: forcedScanEntries,
      })
      .catch((err) => {
        findings.push({
          checkId: "plugins.code_safety.scan_failed",
          severity: "warn",
          title: `Plugin "${pluginName}" code scan failed`,
          detail: `Static code scan could not complete: ${String(err)}`,
          remediation:
            "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`.",
        });
        return null;
      });
    if (!summary) {
      continue;
    }

    if (summary.critical > 0) {
      const criticalFindings = summary.findings.filter((f) => f.severity === "critical");
      const details = formatCodeSafetyDetails(criticalFindings, pluginPath);

      findings.push({
        checkId: "plugins.code_safety",
        severity: "critical",
        title: `Plugin "${pluginName}" contains dangerous code patterns`,
        detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
        remediation:
          "Review the plugin source code carefully before use. If untrusted, remove the plugin from your OpenClaw extensions state directory.",
      });
    } else if (summary.warn > 0) {
      const warnFindings = summary.findings.filter((f) => f.severity === "warn");
      const details = formatCodeSafetyDetails(warnFindings, pluginPath);

      findings.push({
        checkId: "plugins.code_safety",
        severity: "warn",
        title: `Plugin "${pluginName}" contains suspicious code patterns`,
        detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
        remediation: `Review the flagged code to ensure it is intentional and safe.`,
      });
    }
  }

  return findings;
}

export async function collectInstalledSkillsCodeSafetyFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const pluginExtensionsDir = path.join(params.stateDir, "extensions");
  const scannedSkillDirs = new Set<string>();
  const workspaceDirs = listWorkspaceDirs(params.cfg);

  for (const workspaceDir of workspaceDirs) {
    const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
    for (const entry of entries) {
      if (entry.skill.source === "openclaw-bundled") {
        continue;
      }

      const skillDir = path.resolve(entry.skill.baseDir);
      if (isPathInside(pluginExtensionsDir, skillDir)) {
        // Plugin code is already covered by plugins.code_safety checks.
        continue;
      }
      if (scannedSkillDirs.has(skillDir)) {
        continue;
      }
      scannedSkillDirs.add(skillDir);

      const skillName = entry.skill.name;
      const summary = await skillScanner.scanDirectoryWithSummary(skillDir).catch((err) => {
        findings.push({
          checkId: "skills.code_safety.scan_failed",
          severity: "warn",
          title: `Skill "${skillName}" code scan failed`,
          detail: `Static code scan could not complete for ${skillDir}: ${String(err)}`,
          remediation:
            "Check file permissions and skill layout, then rerun `openclaw security audit --deep`.",
        });
        return null;
      });
      if (!summary) {
        continue;
      }

      if (summary.critical > 0) {
        const criticalFindings = summary.findings.filter(
          (finding) => finding.severity === "critical",
        );
        const details = formatCodeSafetyDetails(criticalFindings, skillDir);
        findings.push({
          checkId: "skills.code_safety",
          severity: "critical",
          title: `Skill "${skillName}" contains dangerous code patterns`,
          detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
          remediation: `Review the skill source code before use. If untrusted, remove "${skillDir}".`,
        });
      } else if (summary.warn > 0) {
        const warnFindings = summary.findings.filter((finding) => finding.severity === "warn");
        const details = formatCodeSafetyDetails(warnFindings, skillDir);
        findings.push({
          checkId: "skills.code_safety",
          severity: "warn",
          title: `Skill "${skillName}" contains suspicious code patterns`,
          detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
          remediation: "Review flagged lines to ensure the behavior is intentional and safe.",
        });
      }
    }
  }

  return findings;
}
