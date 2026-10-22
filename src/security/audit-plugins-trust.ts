import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveChannelAccount } from "../channels/account-resolution.js";
import { listReadOnlyChannelPluginsForConfigAsync } from "../channels/plugins/read-only.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { resolveNativeSkillsEnabled } from "../config/commands.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import type { InstallRecordBase } from "../config/zod-schema.installs.js";
import { readHookInstalls } from "../hooks/installs.js";
import { readInstalledPackageVersion } from "../infra/package-update-utils.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-record-reader.js";
import {
  createPluginRegistryIdNormalizer,
  loadPluginRegistrySnapshot,
} from "../plugins/plugin-registry.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import { listInstalledPluginDirs } from "./installed-plugin-dirs.js";

function readChannelCommandSetting(
  cfg: OpenClawConfig,
  channelId: string,
  key: "native" | "nativeSkills",
): unknown {
  const channelCfg = cfg.channels?.[channelId as keyof NonNullable<OpenClawConfig["channels"]>];
  if (!channelCfg || typeof channelCfg !== "object" || Array.isArray(channelCfg)) {
    return undefined;
  }
  const commands = (channelCfg as { commands?: unknown }).commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return undefined;
  }
  return (commands as Record<string, unknown>)[key];
}

async function isChannelPluginConfigured(
  cfg: OpenClawConfig,
  plugin: ChannelPlugin,
): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  const candidates = accountIds.length > 0 ? accountIds : [undefined];
  for (const accountId of candidates) {
    const inspected =
      plugin.config.inspectAccount?.(cfg, accountId) ??
      (await inspectReadOnlyChannelAccount({
        channelId: plugin.id,
        cfg,
        accountId,
      }));
    const inspectedRecord =
      inspected && typeof inspected === "object" && !Array.isArray(inspected)
        ? (inspected as Record<string, unknown>)
        : null;
    let resolvedAccount: unknown = inspected;
    if (!resolvedAccount) {
      try {
        resolvedAccount = await resolveChannelAccount({ plugin, cfg, accountId });
      } catch {
        resolvedAccount = null;
      }
    }
    let enabled =
      typeof inspectedRecord?.enabled === "boolean"
        ? inspectedRecord.enabled
        : resolvedAccount != null;
    if (
      typeof inspectedRecord?.enabled !== "boolean" &&
      resolvedAccount != null &&
      plugin.config.isEnabled
    ) {
      try {
        enabled = plugin.config.isEnabled(resolvedAccount, cfg);
      } catch {
        enabled = false;
      }
    }
    let configured =
      typeof inspectedRecord?.configured === "boolean"
        ? inspectedRecord.configured
        : resolvedAccount != null;
    if (
      typeof inspectedRecord?.configured !== "boolean" &&
      resolvedAccount != null &&
      plugin.config.isConfigured
    ) {
      try {
        configured = await plugin.config.isConfigured(resolvedAccount, cfg);
      } catch {
        configured = false;
      }
    }
    if (enabled && configured) {
      return true;
    }
  }
  return false;
}

function resolveEnabledExtensionPluginIds(params: {
  cfg: OpenClawConfig;
  pluginDirs: string[];
}): string[] {
  const normalized = normalizePluginsConfig(params.cfg.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const allowSet = new Set(normalized.allow);
  const denySet = new Set(normalized.deny);
  const entryById = new Map(Object.entries(normalized.entries));

  const enabled: string[] = [];
  for (const id of params.pluginDirs) {
    const normalizedId = normalizeOptionalLowercaseString(id);
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

function isPinnedRegistrySpec(spec: string): boolean {
  const value = spec.trim();
  if (!value) {
    return false;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at >= value.length - 1) {
    return false;
  }
  const version = value.slice(at + 1).trim();
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

async function collectNpmInstallFindings(
  installs: Array<[string, Omit<InstallRecordBase, "source">]>,
  stateDir: string,
  directory: "extensions" | "hooks",
): Promise<SecurityAuditFinding[]> {
  const unpinned = installs
    .filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec))
    .map(([id, record]) => `${id} (${record.spec})`);
  const missingIntegrity = installs
    .filter(([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "")
    .map(([id]) => id);
  const versionDrift: string[] = [];
  for (const [id, record] of installs) {
    const recordedVersion = record.resolvedVersion ?? record.version;
    if (!recordedVersion) {
      continue;
    }
    // Installed package.json is the local truth; registry metadata drift means
    // update/reinstall should refresh the recorded supply-chain evidence.
    const installPath = record.installPath ?? path.join(stateDir, directory, id);
    const installedVersion = await readInstalledPackageVersion(installPath);
    if (!installedVersion || installedVersion === recordedVersion) {
      continue;
    }
    versionDrift.push(`${id} (recorded ${recordedVersion}, installed ${installedVersion})`);
  }
  const plugins = directory === "extensions";
  const owner = plugins ? "plugins" : "hooks";
  const findings: SecurityAuditFinding[] = [];
  const report = (entries: string[], finding: Omit<SecurityAuditFinding, "severity">) => {
    if (entries.length > 0) {
      findings.push({
        ...finding,
        severity: "warn",
        detail: `${finding.detail}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`,
      });
    }
  };
  report(unpinned, {
    checkId: `${owner}.installs_unpinned_npm_specs`,
    title: plugins
      ? "Plugin index includes unpinned npm specs"
      : "Hook installs include unpinned npm specs",
    detail: `Unpinned ${plugins ? "plugin index" : "hook"} install records`,
    remediation: plugins
      ? "Pin install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability."
      : "Pin hook install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
  });
  report(missingIntegrity, {
    checkId: `${owner}.installs_missing_integrity`,
    title: plugins
      ? "Plugin index is missing integrity metadata"
      : "Hook installs are missing integrity metadata",
    detail: `${plugins ? "Plugin index" : "Hook install"} records missing integrity`,
    remediation: `Reinstall or update ${owner} to refresh install metadata with resolved integrity hashes.`,
  });
  report(versionDrift, {
    checkId: `${owner}.installs_version_drift`,
    title: plugins
      ? "Plugin index records drift from installed package versions"
      : "Hook install records drift from installed package versions",
    detail: `Detected ${plugins ? "plugin" : "hook"} install metadata drift`,
    remediation: `Run \`openclaw ${owner} update --all\` (or reinstall affected ${owner}) to refresh install metadata.`,
  });
  return findings;
}

/** Collect supply-chain and reachable-tool findings for installed plugins and hook packs. */
export async function collectPluginsTrustFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({
    stateDir: params.stateDir,
  });
  if (pluginDirs.length > 0) {
    const allow = params.cfg.plugins?.allow;
    const allowConfigured = Array.isArray(allow) && allow.length > 0;
    const pluginIndex = loadPluginRegistrySnapshot({
      config: params.cfg,
      stateDir: params.stateDir,
    });
    const normalizePluginId = createPluginRegistryIdNormalizer(pluginIndex);

    if (allowConfigured) {
      const installedPluginIds = new Set(pluginDirs.map((dir) => path.basename(dir).toLowerCase()));
      // Allowlist entries may use aliases/canonical ids. Normalize against the
      // current registry before treating an entry as phantom.
      const indexedPluginIds = new Set(
        pluginIndex.plugins.map((plugin) => plugin.pluginId.toLowerCase()),
      );
      const phantomEntries = allow.filter((entry) => {
        if (typeof entry !== "string" || entry === "group:plugins") {
          return false;
        }
        const lower = entry.toLowerCase();
        if (installedPluginIds.has(lower) || indexedPluginIds.has(lower)) {
          return false;
        }
        const canonicalId = normalizeOptionalLowercaseString(normalizePluginId(entry)) ?? "";
        return !canonicalId || !indexedPluginIds.has(canonicalId);
      });
      if (phantomEntries.length > 0) {
        findings.push({
          checkId: "plugins.allow_phantom_entries",
          severity: "warn",
          title: "plugins.allow contains entries with no matching installed plugin",
          detail:
            `The following plugins.allow entries do not correspond to any installed plugin: ${phantomEntries.join(", ")}.\n` +
            "Phantom entries could be exploited by registering a new plugin with an allowlisted ID.",
          remediation:
            "Remove unused entries from plugins.allow, or verify the expected plugins are installed.",
        });
      }
    }

    if (!allowConfigured) {
      const channelPlugins = await listReadOnlyChannelPluginsForConfigAsync(params.cfg, {
        stateDir: params.stateDir,
      });
      const skillCommandsLikelyExposed = (
        await Promise.all(
          channelPlugins.map(async (plugin) => {
            if (
              plugin.capabilities.nativeCommands !== true &&
              plugin.commands?.nativeSkillsAutoEnabled !== true
            ) {
              return false;
            }
            if (!(await isChannelPluginConfigured(params.cfg, plugin))) {
              return false;
            }
            return resolveNativeSkillsEnabled({
              providerId: plugin.id,
              providerSetting: readChannelCommandSetting(params.cfg, plugin.id, "nativeSkills") as
                | "auto"
                | boolean
                | undefined,
              globalSetting: params.cfg.commands?.nativeSkills,
              stateDir: params.stateDir,
              autoDefault: plugin.commands?.nativeSkillsAutoEnabled === true,
            });
          }),
        )
      ).some(Boolean);

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
      const [
        { resolveConfiguredToolPolicies },
        { resolveSandboxConfigForAgent },
        { isToolAllowedByPolicies },
        { buildPluginToolGroups, expandPolicyWithPluginGroups },
      ] = await Promise.all([
        import("../agents/agent-tools.policy.js"),
        import("../agents/sandbox/config.js"),
        import("../agents/tool-policy-match.js"),
        import("../agents/tool-policy.js"),
      ]);
      const declaredTools = new Map(
        pluginIndex.plugins.map((plugin) => [
          normalizePluginId(plugin.pluginId).toLowerCase(),
          plugin.contributions?.contracts.tools,
        ]),
      );
      const pluginGroups = buildPluginToolGroups({
        tools: enabledExtensionPluginIds.flatMap((id) => {
          const pluginId = normalizePluginId(id).toLowerCase();
          // Older installed indexes can lack tool contracts. Include their probes
          // in the groups so explicit plugin grants still reach the audit.
          return (declaredTools.get(pluginId) ?? [`__openclaw_plugin_probe_${pluginId}__`]).map(
            (name) => ({ name, pluginId }),
          );
        }),
        toolMeta: (tool) => ({ pluginId: tool.pluginId }),
      });
      const contexts: Array<{
        label: string;
        agentId?: string;
        tools?: AgentToolsConfig;
      }> = [{ label: "default" }];
      for (const entry of listAgentEntries(params.cfg)) {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
          continue;
        }
        contexts.push({
          label: `agents.entries.${entry.id}`,
          agentId: entry.id,
          tools: entry.tools,
        });
      }

      const permissiveContexts: string[] = [];
      for (const context of contexts) {
        const sandboxMode = resolveSandboxConfigForAgent(params.cfg, context.agentId).mode;
        const policies = resolveConfiguredToolPolicies({
          cfg: params.cfg,
          agentTools: context.tools,
          sandboxMode,
          agentId: context.agentId,
        }).map((policy) => expandPolicyWithPluginGroups(policy, pluginGroups));
        // Provider policies only narrow these base layers at runtime.
        if (pluginGroups.all.some((tool) => isToolAllowedByPolicies(tool, policies))) {
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
  }

  const pluginInstalls = await loadInstalledPluginIndexInstallRecords({
    stateDir: params.stateDir,
  });
  const npmPluginInstalls = Object.entries(pluginInstalls).filter(
    ([, record]) => record?.source === "npm",
  );
  findings.push(
    ...(await collectNpmInstallFindings(npmPluginInstalls, params.stateDir, "extensions")),
  );

  const hookInstalls = readHookInstalls({
    env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
  });
  const npmHookInstalls = Object.entries(hookInstalls).filter(
    ([, record]) => record?.source === "npm",
  );
  findings.push(...(await collectNpmInstallFindings(npmHookInstalls, params.stateDir, "hooks")));

  return findings;
}
