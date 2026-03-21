import { normalizeChatChannelId } from "../channels/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import { listRouteBindings } from "../config/bindings.js";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH, migrateLegacyConfig } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { parseToolsBySenderTypedKey } from "../config/types.tools.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../infra/exec-safe-bin-runtime-policy.js";
import {
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  normalizeTrustedSafeBinDirs,
} from "../infra/exec-safe-bin-trust.js";
import {
  autoPrepareLegacyMatrixCrypto,
  detectLegacyMatrixCrypto,
} from "../infra/matrix-legacy-crypto.js";
import {
  autoMigrateLegacyMatrixState,
  detectLegacyMatrixState,
} from "../infra/matrix-legacy-state.js";
import {
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
} from "../infra/matrix-migration-snapshot.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import {
  formatChannelAccountsDefaultPath,
  formatSetExplicitDefaultInstruction,
  formatSetExplicitDefaultToConfiguredInstruction,
} from "../routing/default-account-warnings.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
import {} from "../security/mutable-allowlist-detectors.js";
import { note } from "../terminal/note.js";
import {
  formatConfigPath,
  noteOpencodeProviderOverrides,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor/providers/discord.js";
import {
  maybeRepairTelegramAllowFromUsernames,
  scanTelegramAllowFromUsernameEntries,
} from "./doctor/providers/telegram.js";
import { hasAllowFromEntries } from "./doctor/shared/allowlist.js";
import { collectEmptyAllowlistPolicyWarningsForAccount } from "./doctor/shared/empty-allowlist-policy.js";
import { scanMutableAllowlistEntries } from "./doctor/shared/mutable-allowlist.js";
import { asObjectRecord } from "./doctor/shared/object.js";

function normalizeBindingChannelKey(raw?: string | null): string {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  return (raw ?? "").trim().toLowerCase();
}

type ChannelMissingDefaultAccountContext = {
  channelKey: string;
  channel: Record<string, unknown>;
  normalizedAccountIds: string[];
};

function collectChannelsMissingDefaultAccount(
  cfg: OpenClawConfig,
): ChannelMissingDefaultAccountContext[] {
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return [];
  }

  const contexts: ChannelMissingDefaultAccountContext[] = [];
  for (const [channelKey, rawChannel] of Object.entries(channels)) {
    const channel = asObjectRecord(rawChannel);
    if (!channel) {
      continue;
    }
    const accounts = asObjectRecord(channel.accounts);
    if (!accounts) {
      continue;
    }

    const normalizedAccountIds = Array.from(
      new Set(
        Object.keys(accounts)
          .map((accountId) => normalizeAccountId(accountId))
          .filter(Boolean),
      ),
    ).toSorted((a, b) => a.localeCompare(b));
    if (normalizedAccountIds.length === 0 || normalizedAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
      continue;
    }
    contexts.push({ channelKey, channel, normalizedAccountIds });
  }
  return contexts;
}

export function collectMissingDefaultAccountBindingWarnings(cfg: OpenClawConfig): string[] {
  const bindings = listRouteBindings(cfg);
  const warnings: string[] = [];

  for (const { channelKey, normalizedAccountIds } of collectChannelsMissingDefaultAccount(cfg)) {
    const accountIdSet = new Set(normalizedAccountIds);
    const channelPattern = normalizeBindingChannelKey(channelKey);

    let hasWildcardBinding = false;
    const coveredAccountIds = new Set<string>();
    for (const binding of bindings) {
      const bindingRecord = asObjectRecord(binding);
      if (!bindingRecord) {
        continue;
      }
      const match = asObjectRecord(bindingRecord.match);
      if (!match) {
        continue;
      }

      const matchChannel =
        typeof match.channel === "string" ? normalizeBindingChannelKey(match.channel) : "";
      if (!matchChannel || matchChannel !== channelPattern) {
        continue;
      }

      const rawAccountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
      if (!rawAccountId) {
        continue;
      }
      if (rawAccountId === "*") {
        hasWildcardBinding = true;
        continue;
      }
      const normalizedBindingAccountId = normalizeAccountId(rawAccountId);
      if (accountIdSet.has(normalizedBindingAccountId)) {
        coveredAccountIds.add(normalizedBindingAccountId);
      }
    }

    if (hasWildcardBinding) {
      continue;
    }

    const uncoveredAccountIds = normalizedAccountIds.filter(
      (accountId) => !coveredAccountIds.has(accountId),
    );
    if (uncoveredAccountIds.length === 0) {
      continue;
    }
    if (coveredAccountIds.size > 0) {
      warnings.push(
        `- channels.${channelKey}: accounts.default is missing and account bindings only cover a subset of configured accounts. Uncovered accounts: ${uncoveredAccountIds.join(", ")}. Add bindings[].match.accountId for uncovered accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`,
      );
      continue;
    }

    warnings.push(
      `- channels.${channelKey}: accounts.default is missing and no valid account-scoped binding exists for configured accounts (${normalizedAccountIds.join(", ")}). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`,
    );
  }

  return warnings;
}

export function collectMissingExplicitDefaultAccountWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  for (const { channelKey, channel, normalizedAccountIds } of collectChannelsMissingDefaultAccount(
    cfg,
  )) {
    if (normalizedAccountIds.length < 2) {
      continue;
    }

    const preferredDefault = normalizeOptionalAccountId(
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    );
    if (preferredDefault) {
      if (normalizedAccountIds.includes(preferredDefault)) {
        continue;
      }
      warnings.push(
        `- channels.${channelKey}: defaultAccount is set to "${preferredDefault}" but does not match configured accounts (${normalizedAccountIds.join(", ")}). ${formatSetExplicitDefaultToConfiguredInstruction({ channelKey })} to avoid fallback routing.`,
      );
      continue;
    }

    warnings.push(
      `- channels.${channelKey}: multiple accounts are configured but no explicit default is set. ${formatSetExplicitDefaultInstruction(channelKey)} to avoid fallback routing.`,
    );
  }

  return warnings;
}

function formatMatrixLegacyStatePreview(
  detection: Exclude<ReturnType<typeof detectLegacyMatrixState>, null | { warning: string }>,
): string {
  return [
    "- Matrix plugin upgraded in place.",
    `- Legacy sync store: ${detection.legacyStoragePath} -> ${detection.targetStoragePath}`,
    `- Legacy crypto store: ${detection.legacyCryptoPath} -> ${detection.targetCryptoPath}`,
    ...(detection.selectionNote ? [`- ${detection.selectionNote}`] : []),
    '- Run "openclaw doctor --fix" to migrate this Matrix state now.',
  ].join("\n");
}

function formatMatrixLegacyCryptoPreview(
  detection: ReturnType<typeof detectLegacyMatrixCrypto>,
): string[] {
  const notes: string[] = [];
  for (const warning of detection.warnings) {
    notes.push(`- ${warning}`);
  }
  for (const plan of detection.plans) {
    notes.push(
      [
        `- Matrix encrypted-state migration is pending for account "${plan.accountId}".`,
        `- Legacy crypto store: ${plan.legacyCryptoPath}`,
        `- New recovery key file: ${plan.recoveryKeyPath}`,
        `- Migration state file: ${plan.statePath}`,
        '- Run "openclaw doctor --fix" to extract any saved backup key now. Backed-up room keys will restore automatically on next gateway start.',
      ].join("\n"),
    );
  }
  return notes;
}

async function collectMatrixInstallPathWarnings(cfg: OpenClawConfig): Promise<string[]> {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue) {
    return [];
  }
  return formatPluginInstallPathIssue({
    issue,
    pluginLabel: "Matrix",
    defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
    repoInstallCommand: "openclaw plugins install ./extensions/matrix",
    formatCommand: formatCliCommand,
  }).map((entry) => `- ${entry}`);
}

/**
 * Scan all channel configs for dmPolicy="open" without allowFrom including "*".
 * This configuration is rejected by the schema validator but can easily occur when
 * users (or integrations) set dmPolicy to "open" without realising that an explicit
 * allowFrom wildcard is also required.
 */
function maybeRepairOpenPolicyAllowFrom(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  type OpenPolicyAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

  const resolveAllowFromMode = (channelName: string): OpenPolicyAllowFromMode => {
    if (channelName === "googlechat") {
      return "nestedOnly";
    }
    if (channelName === "discord" || channelName === "slack") {
      return "topOrNested";
    }
    return "topOnly";
  };

  const hasWildcard = (list?: Array<string | number>) =>
    list?.some((v) => String(v).trim() === "*") ?? false;

  const ensureWildcard = (
    account: Record<string, unknown>,
    prefix: string,
    mode: OpenPolicyAllowFromMode,
  ) => {
    const dmEntry = account.dm;
    const dm =
      dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
        ? (dmEntry as Record<string, unknown>)
        : undefined;
    const dmPolicy =
      (account.dmPolicy as string | undefined) ?? (dm?.policy as string | undefined) ?? undefined;

    if (dmPolicy !== "open") {
      return;
    }

    const topAllowFrom = account.allowFrom as Array<string | number> | undefined;
    const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;

    if (mode === "nestedOnly") {
      if (hasWildcard(nestedAllowFrom)) {
        return;
      }
      if (Array.isArray(nestedAllowFrom)) {
        nestedAllowFrom.push("*");
        changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
        return;
      }
      const nextDm = dm ?? {};
      nextDm.allowFrom = ["*"];
      account.dm = nextDm;
      changes.push(`- ${prefix}.dm.allowFrom: set to ["*"] (required by dmPolicy="open")`);
      return;
    }

    if (mode === "topOrNested") {
      if (hasWildcard(topAllowFrom) || hasWildcard(nestedAllowFrom)) {
        return;
      }

      if (Array.isArray(topAllowFrom)) {
        topAllowFrom.push("*");
        changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
      } else if (Array.isArray(nestedAllowFrom)) {
        nestedAllowFrom.push("*");
        changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
      } else {
        account.allowFrom = ["*"];
        changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
      }
      return;
    }

    if (hasWildcard(topAllowFrom)) {
      return;
    }
    if (Array.isArray(topAllowFrom)) {
      topAllowFrom.push("*");
      changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
    } else {
      account.allowFrom = ["*"];
      changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
    }
  };

  const nextChannels = next.channels as Record<string, Record<string, unknown>>;
  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }

    const allowFromMode = resolveAllowFromMode(channelName);

    // Check the top-level channel config
    ensureWildcard(channelConfig, `channels.${channelName}`, allowFromMode);

    // Check per-account configs (e.g. channels.discord.accounts.mybot)
    const accounts = channelConfig.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts && typeof accounts === "object") {
      for (const [accountName, accountConfig] of Object.entries(accounts)) {
        if (accountConfig && typeof accountConfig === "object") {
          ensureWildcard(
            accountConfig,
            `channels.${channelName}.accounts.${accountName}`,
            allowFromMode,
          );
        }
      }
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

async function maybeRepairAllowlistPolicyAllowFrom(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  type AllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

  const resolveAllowFromMode = (channelName: string): AllowFromMode => {
    if (channelName === "googlechat") {
      return "nestedOnly";
    }
    if (channelName === "discord" || channelName === "slack") {
      return "topOrNested";
    }
    return "topOnly";
  };

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const applyRecoveredAllowFrom = (params: {
    account: Record<string, unknown>;
    allowFrom: string[];
    mode: AllowFromMode;
    prefix: string;
  }) => {
    const count = params.allowFrom.length;
    const noun = count === 1 ? "entry" : "entries";

    if (params.mode === "nestedOnly") {
      const dmEntry = params.account.dm;
      const dm =
        dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
          ? (dmEntry as Record<string, unknown>)
          : {};
      dm.allowFrom = params.allowFrom;
      params.account.dm = dm;
      changes.push(
        `- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
      );
      return;
    }

    if (params.mode === "topOrNested") {
      const dmEntry = params.account.dm;
      const dm =
        dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
          ? (dmEntry as Record<string, unknown>)
          : undefined;
      const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;
      if (dm && !Array.isArray(params.account.allowFrom) && Array.isArray(nestedAllowFrom)) {
        dm.allowFrom = params.allowFrom;
        changes.push(
          `- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
        );
        return;
      }
    }

    params.account.allowFrom = params.allowFrom;
    changes.push(
      `- ${params.prefix}.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
    );
  };

  const recoverAllowFromForAccount = async (params: {
    channelName: string;
    account: Record<string, unknown>;
    accountId?: string;
    prefix: string;
  }) => {
    const dmEntry = params.account.dm;
    const dm =
      dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
        ? (dmEntry as Record<string, unknown>)
        : undefined;
    const dmPolicy =
      (params.account.dmPolicy as string | undefined) ?? (dm?.policy as string | undefined);
    if (dmPolicy !== "allowlist") {
      return;
    }

    const topAllowFrom = params.account.allowFrom as Array<string | number> | undefined;
    const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;
    if (hasAllowFromEntries(topAllowFrom) || hasAllowFromEntries(nestedAllowFrom)) {
      return;
    }

    const normalizedChannelId = (normalizeChatChannelId(params.channelName) ?? params.channelName)
      .trim()
      .toLowerCase();
    if (!normalizedChannelId) {
      return;
    }
    const normalizedAccountId = normalizeAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const fromStore = await readChannelAllowFromStore(
      normalizedChannelId,
      process.env,
      normalizedAccountId,
    ).catch(() => []);
    const recovered = Array.from(new Set(fromStore.map((entry) => String(entry).trim()))).filter(
      Boolean,
    );
    if (recovered.length === 0) {
      return;
    }

    applyRecoveredAllowFrom({
      account: params.account,
      allowFrom: recovered,
      mode: resolveAllowFromMode(params.channelName),
      prefix: params.prefix,
    });
  };

  const nextChannels = next.channels as Record<string, Record<string, unknown>>;
  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    await recoverAllowFromForAccount({
      channelName,
      account: channelConfig,
      prefix: `channels.${channelName}`,
    });

    const accounts = channelConfig.accounts as Record<string, Record<string, unknown>> | undefined;
    if (!accounts || typeof accounts !== "object") {
      continue;
    }
    for (const [accountId, accountConfig] of Object.entries(accounts)) {
      if (!accountConfig || typeof accountConfig !== "object") {
        continue;
      }
      await recoverAllowFromForAccount({
        channelName,
        account: accountConfig,
        accountId,
        prefix: `channels.${channelName}.accounts.${accountId}`,
      });
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

/**
 * Scan all channel configs for dmPolicy="allowlist" without any allowFrom entries.
 * This configuration blocks all DMs because no sender can match the empty
 * allowlist. Common after upgrades that remove external allowlist
 * file support.
 */
function detectEmptyAllowlistPolicy(cfg: OpenClawConfig): string[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const warnings: string[] = [];

  const checkAccount = (
    account: Record<string, unknown>,
    prefix: string,
    parent?: Record<string, unknown>,
    channelName?: string,
  ) => {
    warnings.push(
      ...collectEmptyAllowlistPolicyWarningsForAccount({
        account,
        channelName,
        doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
        parent,
        prefix,
      }),
    );
  };

  for (const [channelName, channelConfig] of Object.entries(
    channels as Record<string, Record<string, unknown>>,
  )) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    checkAccount(channelConfig, `channels.${channelName}`, undefined, channelName);

    const accounts = channelConfig.accounts;
    if (accounts && typeof accounts === "object") {
      for (const [accountId, account] of Object.entries(
        accounts as Record<string, Record<string, unknown>>,
      )) {
        if (!account || typeof account !== "object") {
          continue;
        }
        checkAccount(
          account,
          `channels.${channelName}.accounts.${accountId}`,
          channelConfig,
          channelName,
        );
      }
    }
  }

  return warnings;
}

type ExecSafeBinCoverageHit = {
  scopePath: string;
  bin: string;
  isInterpreter: boolean;
};

type ExecSafeBinScopeRef = {
  scopePath: string;
  safeBins: string[];
  exec: Record<string, unknown>;
  mergedProfiles: Record<string, unknown>;
  trustedSafeBinDirs: ReadonlySet<string>;
};

type ExecSafeBinTrustedDirHintHit = {
  scopePath: string;
  bin: string;
  resolvedPath: string;
};

function normalizeConfiguredSafeBins(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ).toSorted();
}

function normalizeConfiguredTrustedSafeBinDirs(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return normalizeTrustedSafeBinDirs(
    entries.filter((entry): entry is string => typeof entry === "string"),
  );
}

function collectExecSafeBinScopes(cfg: OpenClawConfig): ExecSafeBinScopeRef[] {
  const scopes: ExecSafeBinScopeRef[] = [];
  const globalExec = asObjectRecord(cfg.tools?.exec);
  const globalTrustedDirs = normalizeConfiguredTrustedSafeBinDirs(globalExec?.safeBinTrustedDirs);
  if (globalExec) {
    const safeBins = normalizeConfiguredSafeBins(globalExec.safeBins);
    if (safeBins.length > 0) {
      scopes.push({
        scopePath: "tools.exec",
        safeBins,
        exec: globalExec,
        mergedProfiles:
          resolveMergedSafeBinProfileFixtures({
            global: globalExec,
          }) ?? {},
        trustedSafeBinDirs: getTrustedSafeBinDirs({
          extraDirs: globalTrustedDirs,
        }),
      });
    }
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    const agentExec = asObjectRecord(agent.tools?.exec);
    if (!agentExec) {
      continue;
    }
    const safeBins = normalizeConfiguredSafeBins(agentExec.safeBins);
    if (safeBins.length === 0) {
      continue;
    }
    scopes.push({
      scopePath: `agents.list.${agent.id}.tools.exec`,
      safeBins,
      exec: agentExec,
      mergedProfiles:
        resolveMergedSafeBinProfileFixtures({
          global: globalExec,
          local: agentExec,
        }) ?? {},
      trustedSafeBinDirs: getTrustedSafeBinDirs({
        extraDirs: [
          ...globalTrustedDirs,
          ...normalizeConfiguredTrustedSafeBinDirs(agentExec.safeBinTrustedDirs),
        ],
      }),
    });
  }
  return scopes;
}

function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[] {
  const hits: ExecSafeBinCoverageHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    for (const bin of scope.safeBins) {
      if (scope.mergedProfiles[bin]) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        isInterpreter: interpreterBins.has(bin),
      });
    }
  }
  return hits;
}

function scanExecSafeBinTrustedDirHints(cfg: OpenClawConfig): ExecSafeBinTrustedDirHintHit[] {
  const hits: ExecSafeBinTrustedDirHintHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    for (const bin of scope.safeBins) {
      const resolution = resolveCommandResolutionFromArgv([bin]);
      if (!resolution?.resolvedPath) {
        continue;
      }
      if (
        isTrustedSafeBinPath({
          resolvedPath: resolution.resolvedPath,
          trustedDirs: scope.trustedSafeBinDirs,
        })
      ) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        resolvedPath: resolution.resolvedPath,
      });
    }
  }
  return hits;
}

function maybeRepairExecSafeBinProfiles(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const next = structuredClone(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];

  for (const scope of collectExecSafeBinScopes(next)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    const missingBins = scope.safeBins.filter((bin) => !scope.mergedProfiles[bin]);
    if (missingBins.length === 0) {
      continue;
    }
    const profileHolder =
      asObjectRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
    for (const bin of missingBins) {
      if (interpreterBins.has(bin)) {
        warnings.push(
          `- ${scope.scopePath}.safeBins includes interpreter/runtime '${bin}' without profile; remove it from safeBins or use explicit allowlist entries.`,
        );
        continue;
      }
      if (profileHolder[bin] !== undefined) {
        continue;
      }
      profileHolder[bin] = {};
      changes.push(
        `- ${scope.scopePath}.safeBinProfiles.${bin}: added scaffold profile {} (review and tighten flags/positionals).`,
      );
    }
  }

  if (changes.length === 0 && warnings.length === 0) {
    return { config: cfg, changes: [], warnings: [] };
  }
  return { config: next, changes, warnings };
}

type LegacyToolsBySenderKeyHit = {
  toolsBySenderPath: Array<string | number>;
  pathLabel: string;
  key: string;
  targetKey: string;
};

function collectLegacyToolsBySenderKeyHits(
  value: unknown,
  pathParts: Array<string | number>,
  hits: LegacyToolsBySenderKeyHit[],
) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectLegacyToolsBySenderKeyHits(entry, [...pathParts, index], hits);
    }
    return;
  }
  const record = asObjectRecord(value);
  if (!record) {
    return;
  }

  const toolsBySender = asObjectRecord(record.toolsBySender);
  if (toolsBySender) {
    const path = [...pathParts, "toolsBySender"];
    const pathLabel = formatConfigPath(path);
    for (const rawKey of Object.keys(toolsBySender)) {
      const trimmed = rawKey.trim();
      if (!trimmed || trimmed === "*" || parseToolsBySenderTypedKey(trimmed)) {
        continue;
      }
      hits.push({
        toolsBySenderPath: path,
        pathLabel,
        key: rawKey,
        targetKey: `id:${trimmed}`,
      });
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "toolsBySender") {
      continue;
    }
    collectLegacyToolsBySenderKeyHits(nested, [...pathParts, key], hits);
  }
}

function scanLegacyToolsBySenderKeys(cfg: OpenClawConfig): LegacyToolsBySenderKeyHit[] {
  const hits: LegacyToolsBySenderKeyHit[] = [];
  collectLegacyToolsBySenderKeyHits(cfg, [], hits);
  return hits;
}

function maybeRepairLegacyToolsBySenderKeys(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const next = structuredClone(cfg);
  const hits = scanLegacyToolsBySenderKeys(next);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const summary = new Map<string, { migrated: number; dropped: number; examples: string[] }>();
  let changed = false;

  for (const hit of hits) {
    const toolsBySender = asObjectRecord(resolveConfigPathTarget(next, hit.toolsBySenderPath));
    if (!toolsBySender || !(hit.key in toolsBySender)) {
      continue;
    }
    const row = summary.get(hit.pathLabel) ?? { migrated: 0, dropped: 0, examples: [] };

    if (toolsBySender[hit.targetKey] === undefined) {
      toolsBySender[hit.targetKey] = toolsBySender[hit.key];
      row.migrated++;
      if (row.examples.length < 3) {
        row.examples.push(`${hit.key} -> ${hit.targetKey}`);
      }
    } else {
      row.dropped++;
      if (row.examples.length < 3) {
        row.examples.push(`${hit.key} (kept existing ${hit.targetKey})`);
      }
    }
    delete toolsBySender[hit.key];
    summary.set(hit.pathLabel, row);
    changed = true;
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  for (const [pathLabel, row] of summary) {
    if (row.migrated > 0) {
      const suffix = row.examples.length > 0 ? ` (${row.examples.join(", ")})` : "";
      changes.push(
        `- ${pathLabel}: migrated ${row.migrated} legacy key${row.migrated === 1 ? "" : "s"} to typed id: entries${suffix}.`,
      );
    }
    if (row.dropped > 0) {
      changes.push(
        `- ${pathLabel}: removed ${row.dropped} legacy key${row.dropped === 1 ? "" : "s"} where typed id: entries already existed.`,
      );
    }
  }

  return { config: next, changes };
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const preflight = await runDoctorConfigPreflight();
  let snapshot = preflight.snapshot;
  const baseCfg = preflight.baseConfig;
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let shouldWriteConfig = false;
  const fixHints: string[] = [];

  if (snapshot.legacyIssues.length > 0) {
    note(
      formatConfigIssueLines(snapshot.legacyIssues, "-").join("\n"),
      "Compatibility config keys detected",
    );
    const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
    if (changes.length > 0) {
      note(changes.join("\n"), "Doctor changes");
    }
    if (migrated) {
      candidate = migrated;
      pendingChanges = pendingChanges || changes.length > 0;
    }
    if (shouldRepair) {
      // Compatibility migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      if (migrated) {
        cfg = migrated;
      }
    } else {
      fixHints.push(
        `Run "${formatCliCommand("openclaw doctor --fix")}" to apply compatibility migrations.`,
      );
    }
  }

  const normalized = normalizeCompatibilityConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    candidate = normalized.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = normalized.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    candidate = autoEnable.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = autoEnable.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const matrixLegacyState = detectLegacyMatrixState({
    cfg: candidate,
    env: process.env,
  });
  const matrixLegacyCrypto = detectLegacyMatrixCrypto({
    cfg: candidate,
    env: process.env,
  });
  const pendingMatrixMigration = hasPendingMatrixMigration({
    cfg: candidate,
    env: process.env,
  });
  const actionableMatrixMigration = hasActionableMatrixMigration({
    cfg: candidate,
    env: process.env,
  });
  if (shouldRepair) {
    let matrixSnapshotReady = true;
    if (actionableMatrixMigration) {
      try {
        const snapshot = await maybeCreateMatrixMigrationSnapshot({
          trigger: "doctor-fix",
          env: process.env,
        });
        note(
          `Matrix migration snapshot ${snapshot.created ? "created" : "reused"} before applying Matrix upgrades.\n- ${snapshot.archivePath}`,
          "Doctor changes",
        );
      } catch (err) {
        matrixSnapshotReady = false;
        note(
          `- Failed creating a Matrix migration snapshot before repair: ${String(err)}`,
          "Doctor warnings",
        );
        note(
          '- Skipping Matrix migration changes for now. Resolve the snapshot failure, then rerun "openclaw doctor --fix".',
          "Doctor warnings",
        );
      }
    } else if (pendingMatrixMigration) {
      note(
        "- Matrix migration warnings are present, but no on-disk Matrix mutation is actionable yet. No pre-migration snapshot was needed.",
        "Doctor warnings",
      );
    }
    if (matrixSnapshotReady) {
      const matrixStateRepair = await autoMigrateLegacyMatrixState({
        cfg: candidate,
        env: process.env,
      });
      if (matrixStateRepair.changes.length > 0) {
        note(
          [
            "Matrix plugin upgraded in place.",
            ...matrixStateRepair.changes.map((entry) => `- ${entry}`),
            "- No user action required.",
          ].join("\n"),
          "Doctor changes",
        );
      }
      if (matrixStateRepair.warnings.length > 0) {
        note(matrixStateRepair.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
      }
      const matrixCryptoRepair = await autoPrepareLegacyMatrixCrypto({
        cfg: candidate,
        env: process.env,
      });
      if (matrixCryptoRepair.changes.length > 0) {
        note(
          [
            "Matrix encrypted-state migration prepared.",
            ...matrixCryptoRepair.changes.map((entry) => `- ${entry}`),
          ].join("\n"),
          "Doctor changes",
        );
      }
      if (matrixCryptoRepair.warnings.length > 0) {
        note(
          matrixCryptoRepair.warnings.map((entry) => `- ${entry}`).join("\n"),
          "Doctor warnings",
        );
      }
    }
  } else if (matrixLegacyState) {
    if ("warning" in matrixLegacyState) {
      note(`- ${matrixLegacyState.warning}`, "Doctor warnings");
    } else {
      note(formatMatrixLegacyStatePreview(matrixLegacyState), "Doctor warnings");
    }
  }
  if (
    !shouldRepair &&
    (matrixLegacyCrypto.warnings.length > 0 || matrixLegacyCrypto.plans.length > 0)
  ) {
    for (const preview of formatMatrixLegacyCryptoPreview(matrixLegacyCrypto)) {
      note(preview, "Doctor warnings");
    }
  }

  const matrixInstallWarnings = await collectMatrixInstallPathWarnings(candidate);
  if (matrixInstallWarnings.length > 0) {
    note(matrixInstallWarnings.join("\n"), "Doctor warnings");
  }

  const missingDefaultAccountBindingWarnings =
    collectMissingDefaultAccountBindingWarnings(candidate);
  if (missingDefaultAccountBindingWarnings.length > 0) {
    note(missingDefaultAccountBindingWarnings.join("\n"), "Doctor warnings");
  }
  const missingExplicitDefaultWarnings = collectMissingExplicitDefaultAccountWarnings(candidate);
  if (missingExplicitDefaultWarnings.length > 0) {
    note(missingExplicitDefaultWarnings.join("\n"), "Doctor warnings");
  }

  if (shouldRepair) {
    const repair = await maybeRepairTelegramAllowFromUsernames(candidate);
    if (repair.changes.length > 0) {
      note(repair.changes.join("\n"), "Doctor changes");
      candidate = repair.config;
      pendingChanges = true;
      cfg = repair.config;
    }

    const discordRepair = maybeRepairDiscordNumericIds(candidate);
    if (discordRepair.changes.length > 0) {
      note(discordRepair.changes.join("\n"), "Doctor changes");
      candidate = discordRepair.config;
      pendingChanges = true;
      cfg = discordRepair.config;
    }

    const allowFromRepair = maybeRepairOpenPolicyAllowFrom(candidate);
    if (allowFromRepair.changes.length > 0) {
      note(allowFromRepair.changes.join("\n"), "Doctor changes");
      candidate = allowFromRepair.config;
      pendingChanges = true;
      cfg = allowFromRepair.config;
    }

    const allowlistRepair = await maybeRepairAllowlistPolicyAllowFrom(candidate);
    if (allowlistRepair.changes.length > 0) {
      note(allowlistRepair.changes.join("\n"), "Doctor changes");
      candidate = allowlistRepair.config;
      pendingChanges = true;
      cfg = allowlistRepair.config;
    }

    const emptyAllowlistWarnings = detectEmptyAllowlistPolicy(candidate);
    if (emptyAllowlistWarnings.length > 0) {
      note(emptyAllowlistWarnings.join("\n"), "Doctor warnings");
    }

    const toolsBySenderRepair = maybeRepairLegacyToolsBySenderKeys(candidate);
    if (toolsBySenderRepair.changes.length > 0) {
      note(toolsBySenderRepair.changes.join("\n"), "Doctor changes");
      candidate = toolsBySenderRepair.config;
      pendingChanges = true;
      cfg = toolsBySenderRepair.config;
    }

    const safeBinProfileRepair = maybeRepairExecSafeBinProfiles(candidate);
    if (safeBinProfileRepair.changes.length > 0) {
      note(safeBinProfileRepair.changes.join("\n"), "Doctor changes");
      candidate = safeBinProfileRepair.config;
      pendingChanges = true;
      cfg = safeBinProfileRepair.config;
    }
    if (safeBinProfileRepair.warnings.length > 0) {
      note(safeBinProfileRepair.warnings.join("\n"), "Doctor warnings");
    }
  } else {
    const hits = scanTelegramAllowFromUsernameEntries(candidate);
    if (hits.length > 0) {
      note(
        [
          `- Telegram allowFrom contains ${hits.length} non-numeric entries (e.g. ${hits[0]?.entry ?? "@"}); Telegram authorization requires numeric sender IDs.`,
          `- Run "${formatCliCommand("openclaw doctor --fix")}" to auto-resolve @username entries to numeric IDs (requires a Telegram bot token).`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const discordHits = scanDiscordNumericIdEntries(candidate);
    if (discordHits.length > 0) {
      note(
        [
          `- Discord allowlists contain ${discordHits.length} numeric entries (e.g. ${discordHits[0]?.path}=${discordHits[0]?.entry}).`,
          `- Discord IDs must be strings; run "${formatCliCommand("openclaw doctor --fix")}" to convert numeric IDs to quoted strings.`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const allowFromScan = maybeRepairOpenPolicyAllowFrom(candidate);
    if (allowFromScan.changes.length > 0) {
      note(
        [
          ...allowFromScan.changes,
          `- Run "${formatCliCommand("openclaw doctor --fix")}" to add missing allowFrom wildcards.`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const emptyAllowlistWarnings = detectEmptyAllowlistPolicy(candidate);
    if (emptyAllowlistWarnings.length > 0) {
      note(emptyAllowlistWarnings.join("\n"), "Doctor warnings");
    }

    const toolsBySenderHits = scanLegacyToolsBySenderKeys(candidate);
    if (toolsBySenderHits.length > 0) {
      const sample = toolsBySenderHits[0];
      const sampleLabel = sample ? `${sample.pathLabel}.${sample.key}` : "toolsBySender";
      note(
        [
          `- Found ${toolsBySenderHits.length} legacy untyped toolsBySender key${toolsBySenderHits.length === 1 ? "" : "s"} (for example ${sampleLabel}).`,
          "- Untyped sender keys are deprecated; use explicit prefixes (id:, e164:, username:, name:).",
          `- Run "${formatCliCommand("openclaw doctor --fix")}" to migrate legacy keys to typed id: entries.`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const safeBinCoverage = scanExecSafeBinCoverage(candidate);
    if (safeBinCoverage.length > 0) {
      const interpreterHits = safeBinCoverage.filter((hit) => hit.isInterpreter);
      const customHits = safeBinCoverage.filter((hit) => !hit.isInterpreter);
      const lines: string[] = [];
      if (interpreterHits.length > 0) {
        for (const hit of interpreterHits.slice(0, 5)) {
          lines.push(
            `- ${hit.scopePath}.safeBins includes interpreter/runtime '${hit.bin}' without profile.`,
          );
        }
        if (interpreterHits.length > 5) {
          lines.push(
            `- ${interpreterHits.length - 5} more interpreter/runtime safeBins entries are missing profiles.`,
          );
        }
      }
      if (customHits.length > 0) {
        for (const hit of customHits.slice(0, 5)) {
          lines.push(
            `- ${hit.scopePath}.safeBins entry '${hit.bin}' is missing safeBinProfiles.${hit.bin}.`,
          );
        }
        if (customHits.length > 5) {
          lines.push(
            `- ${customHits.length - 5} more custom safeBins entries are missing profiles.`,
          );
        }
      }
      lines.push(
        `- Run "${formatCliCommand("openclaw doctor --fix")}" to scaffold missing custom safeBinProfiles entries.`,
      );
      note(lines.join("\n"), "Doctor warnings");
    }

    const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(candidate);
    if (safeBinTrustedDirHints.length > 0) {
      const lines = safeBinTrustedDirHints
        .slice(0, 5)
        .map(
          (hit) =>
            `- ${hit.scopePath}.safeBins entry '${hit.bin}' resolves to '${hit.resolvedPath}' outside trusted safe-bin dirs.`,
        );
      if (safeBinTrustedDirHints.length > 5) {
        lines.push(
          `- ${safeBinTrustedDirHints.length - 5} more safeBins entries resolve outside trusted safe-bin dirs.`,
        );
      }
      lines.push(
        "- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).",
      );
      note(lines.join("\n"), "Doctor warnings");
    }
  }

  const mutableAllowlistHits = scanMutableAllowlistEntries(candidate);
  if (mutableAllowlistHits.length > 0) {
    const channels = Array.from(new Set(mutableAllowlistHits.map((hit) => hit.channel))).toSorted();
    const exampleLines = mutableAllowlistHits
      .slice(0, 8)
      .map((hit) => `- ${hit.path}: ${hit.entry}`)
      .join("\n");
    const remaining =
      mutableAllowlistHits.length > 8
        ? `- +${mutableAllowlistHits.length - 8} more mutable allowlist entries.`
        : null;
    const flagPaths = Array.from(new Set(mutableAllowlistHits.map((hit) => hit.dangerousFlagPath)));
    const flagHint =
      flagPaths.length === 1
        ? flagPaths[0]
        : `${flagPaths[0]} (and ${flagPaths.length - 1} other scope flags)`;
    note(
      [
        `- Found ${mutableAllowlistHits.length} mutable allowlist ${mutableAllowlistHits.length === 1 ? "entry" : "entries"} across ${channels.join(", ")} while name matching is disabled by default.`,
        exampleLines,
        ...(remaining ? [remaining] : []),
        `- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
        "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
      ].join("\n"),
      "Doctor warnings",
    );
  }

  const unknown = stripUnknownConfigKeys(candidate);
  if (unknown.removed.length > 0) {
    const lines = unknown.removed.map((path) => `- ${path}`).join("\n");
    candidate = unknown.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = unknown.config;
      note(lines, "Doctor changes");
    } else {
      note(lines, "Unknown config keys");
      fixHints.push('Run "openclaw doctor --fix" to remove these keys.');
    }
  }

  if (!shouldRepair && pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      cfg = candidate;
      shouldWriteConfig = true;
    } else if (fixHints.length > 0) {
      note(fixHints.join("\n"), "Doctor");
    }
  }

  if (shouldRepair && pendingChanges) {
    shouldWriteConfig = true;
  }

  noteOpencodeProviderOverrides(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
  };
}
