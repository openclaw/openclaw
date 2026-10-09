// Builds channel status rows and account details for `openclaw status --all`.
// This layer stays plugin-generic: channel-specific auth rules live in plugin config/status hooks.

import fs from "node:fs";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  resolveInspectedChannelAccount,
  type ChannelAccountInspectionResult,
} from "../../channels/account-inspection.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import { formatChannelAllowFrom } from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { formatChannelStatusState } from "../../channels/plugins/status-state.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import {
  getRuntimeChannelAccounts,
  hasRuntimeCredentialAvailable,
  markConfiguredUnavailableCredentialStatusesAvailable,
} from "../../channels/status/read-model.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatPhoneNumberForCli } from "../../infra/phone-number-presentation.js";
import { listExplicitConfiguredChannelIdsForConfig } from "../../plugins/channel-plugin-ids.js";
import { resolveMissingOfficialExternalChannelPluginRepairHints } from "../../plugins/official-external-plugin-repair-hints.js";
import { summarizeTokenConfig } from "./channels-token-summary.js";
import { formatTimeAgo } from "./format.js";

type ChannelRow = {
  id: ChannelId;
  label: string;
  enabled: boolean;
  state: "ok" | "setup" | "warn" | "off";
  detail: string;
};

type ChannelAccountRow = ChannelAccountInspectionResult & {
  accountId: string;
};

function existsSyncMaybe(p: string | undefined): boolean | null {
  const path = normalizeOptionalString(p) ?? "";
  if (!path) {
    return null;
  }
  try {
    return fs.existsSync(path);
  } catch {
    return null;
  }
}

const formatAccountLabel = (params: { accountId: string; name?: string }) => {
  const base = params.accountId || "default";
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
};

const buildAccountNotes = (params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  entry: ChannelAccountRow;
  liveCredentialAvailable?: boolean;
}) => {
  const { plugin, cfg, entry } = params;
  const notes: string[] = [];
  const snapshot = entry.snapshot;
  if (snapshot.enabled === false) {
    notes.push("disabled");
  }
  if (snapshot.dmPolicy) {
    notes.push(`dm:${snapshot.dmPolicy}`);
  }
  for (const [label, source] of [
    ["token", snapshot.tokenSource],
    ["bot", snapshot.botTokenSource],
    ["app", snapshot.appTokenSource],
    ["signing", snapshot.signingSecretSource],
  ]) {
    if (source && source !== "none") {
      notes.push(`${label}:${source}`);
    }
  }
  if (entry.kind === "unavailable") {
    notes.push("secret unavailable in this command path");
  } else if (params.liveCredentialAvailable) {
    notes.push("credential available in gateway runtime");
  } else if (hasConfiguredUnavailableCredentialStatus(entry.account)) {
    notes.push("secret unavailable in this command path");
  }
  if (snapshot.baseUrl) {
    notes.push(snapshot.baseUrl);
  }
  if (snapshot.port != null) {
    notes.push(`port:${snapshot.port}`);
  }
  if (snapshot.cliPath) {
    notes.push(`cli:${snapshot.cliPath}`);
  }
  if (snapshot.dbPath) {
    notes.push(`db:${snapshot.dbPath}`);
  }

  const unavailable =
    entry.kind === "unavailable" || hasConfiguredUnavailableCredentialStatus(entry.account);
  const allowFrom = unavailable
    ? snapshot.allowFrom
    : (plugin.config.resolveAllowFrom?.({ cfg, accountId: snapshot.accountId }) ??
      snapshot.allowFrom);
  if (allowFrom?.length) {
    // Cap allow-list output so large channel policies do not dominate the status table.
    const allowInternationalDigits =
      plugin.configSchema?.uiHints?.allowFrom?.presentation === "phone-number";
    const formatted = formatChannelAllowFrom({
      plugin,
      cfg,
      accountId: snapshot.accountId,
      allowFrom,
    })
      .slice(0, 3)
      .map((allowEntry) => formatPhoneNumberForCli(allowEntry, { allowInternationalDigits }));
    if (formatted.length > 0) {
      notes.push(`allow:${formatted.join(",")}`);
    }
  }

  return notes;
};

function resolveLinkFields(summary: unknown): {
  statusState: string | null;
  linked: boolean | null;
  authAgeMs: number | null;
  selfE164: string | null;
} {
  // Plugin summaries are optional extension data; normalize only the fields the core table understands.
  const rec = asRecord(summary);
  const statusState = typeof rec.statusState === "string" ? rec.statusState : null;
  const linked = typeof rec.linked === "boolean" ? rec.linked : null;
  const authAgeMs = typeof rec.authAgeMs === "number" ? rec.authAgeMs : null;
  const self = asRecord(rec.self);
  const selfE164 = typeof self.e164 === "string" && self.e164.trim() ? self.e164.trim() : null;
  return { statusState, linked, authAgeMs, selfE164 };
}

function collectMissingPaths(accounts: ChannelAccountRow[]): string[] {
  const missing: string[] = [];
  for (const entry of accounts) {
    const accountRec = asRecord(entry.account);
    const snapshotRec = asRecord(entry.snapshot);
    for (const key of [
      "tokenFile",
      "botTokenFile",
      "appTokenFile",
      "cliPath",
      "dbPath",
      "authDir",
    ]) {
      // Account config and snapshots can each expose file-backed credential paths.
      const raw =
        (accountRec[key] as string | undefined) ?? (snapshotRec[key] as string | undefined);
      const ok = existsSyncMaybe(raw);
      if (ok === false) {
        missing.push(String(raw));
      }
    }
  }
  return missing;
}

function isLikelyDependencyTreeCorruption(message: string): boolean {
  return /(?:cannot find (?:module|package)|module_not_found|err_module_not_found|enoent|enotempty|missing package|failed to resolve)/iu.test(
    message,
  );
}

function formatLoadFailureDetail(message: string): string {
  const reason = isLikelyDependencyTreeCorruption(message)
    ? "dependency tree corrupted"
    : "registration failed";
  return `plugin load failed: ${reason}; run openclaw doctor --fix`;
}

/** Builds the `status --all` channel summary and per-account detail tables. */
export async function buildChannelsTable(
  cfg: OpenClawConfig,
  opts?: {
    showSecrets?: boolean;
    sourceConfig?: OpenClawConfig;
    includeSetupFallbackPlugins?: boolean;
    liveChannelStatus?: unknown;
  },
) {
  const showSecrets = opts?.showSecrets === true;
  const rows: ChannelRow[] = [];
  const details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }> = [];

  const sourceConfig = opts?.sourceConfig ?? cfg;
  const includeSetupFallbackPlugins = opts?.includeSetupFallbackPlugins ?? true;
  const readOnlyPlugins = resolveReadOnlyChannelPluginsForConfig(cfg, {
    activationSourceConfig: sourceConfig,
    includeSetupFallbackPlugins,
  });
  for (const plugin of readOnlyPlugins.plugins) {
    // Use the plugin's default account even when no accounts are configured so setup guidance is concrete.
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];

    const accounts: ChannelAccountRow[] = [];
    for (const accountId of resolvedAccountIds) {
      accounts.push({
        accountId,
        ...(await resolveInspectedChannelAccount({ plugin, cfg, sourceConfig, accountId })),
      });
    }
    const liveAccounts = getRuntimeChannelAccounts({
      payload: opts?.liveChannelStatus,
      channelId: plugin.id,
    });

    const anyEnabled = accounts.some((a) => a.enabled);
    const enabledAccounts = accounts.filter((a) => a.enabled);
    const configuredAccounts = enabledAccounts.filter((a) => a.configured);
    const configurationUnknown = enabledAccounts.some((a) => a.configured === undefined);
    const unavailableConfiguredAccounts = enabledAccounts.filter(
      (a) =>
        a.kind === "unavailable" ||
        (hasConfiguredUnavailableCredentialStatus(a.account) &&
          !hasRuntimeCredentialAvailable({ liveAccounts, accountId: a.accountId })),
    );
    const accountsForTokenSummary = accounts.map((entry) =>
      hasConfiguredUnavailableCredentialStatus(entry.account) &&
      hasRuntimeCredentialAvailable({ liveAccounts, accountId: entry.accountId })
        ? {
            ...entry,
            // A live account can establish availability when local resolution failed.
            account: markConfiguredUnavailableCredentialStatusesAvailable(entry.account),
          }
        : entry,
    );
    const defaultEntry = accounts.find((a) => a.accountId === defaultAccountId) ?? accounts[0];

    const summary =
      defaultEntry?.kind === "resolved" && plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: defaultEntry.account,
            cfg,
            defaultAccountId,
            snapshot: defaultEntry.snapshot,
          })
        : defaultEntry?.snapshot;

    const link = resolveLinkFields(summary);
    const missingPaths = collectMissingPaths(enabledAccounts);
    const tokenSummary = summarizeTokenConfig({
      accounts: accountsForTokenSummary,
      showSecrets,
    });

    const issues = plugin.status?.collectStatusIssues
      ? plugin.status.collectStatusIssues(accounts.map((a) => a.snapshot))
      : [];

    const label = plugin.meta.label ?? plugin.id;

    const status = ((): Pick<ChannelRow, "state" | "detail"> => {
      // Resolve shared precedence once; link details can still accompany unavailable credentials.
      if (!anyEnabled) {
        const detail = !defaultEntry
          ? "disabled"
          : defaultEntry.kind === "resolved"
            ? (plugin.config.disabledReason?.(defaultEntry.account, cfg) ?? "disabled")
            : (defaultEntry.snapshot.stateReason ?? "disabled");
        return { state: "off", detail };
      }
      if (missingPaths.length > 0) {
        return { state: "warn", detail: `missing file (${missingPaths[0]})` };
      }
      if (issues.length > 0) {
        return { state: "warn", detail: issues[0]?.message ?? "misconfigured" };
      }
      if (configurationUnknown) {
        return { state: "warn", detail: "configuration status unavailable" };
      }
      const state =
        unavailableConfiguredAccounts.length > 0 || link.statusState === "unstable"
          ? "warn"
          : link.linked === false
            ? "setup"
            : (tokenSummary.state ??
              (link.linked === true || configuredAccounts.length > 0 ? "ok" : "setup"));
      const detail = (() => {
        if (link.statusState || link.linked !== null) {
          if (link.statusState && link.statusState !== "linked") {
            return formatChannelStatusState(link.statusState);
          }
          const linked = link.statusState === "linked" || link.linked === true;
          const base = link.statusState
            ? formatChannelStatusState(link.statusState)
            : linked
              ? "linked"
              : "not linked";
          const extra: string[] = [];
          if (linked && link.selfE164) {
            extra.push(formatPhoneNumberForCli(link.selfE164));
          }
          if (linked && link.authAgeMs != null && link.authAgeMs >= 0) {
            extra.push(`auth ${formatTimeAgo(link.authAgeMs)}`);
          }
          if (accounts.length > 1 || plugin.meta.forceAccountBinding) {
            extra.push(`accounts ${accounts.length || 1}`);
          }
          return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
        }

        if (unavailableConfiguredAccounts.length > 0) {
          if (tokenSummary.detail?.includes("unavailable")) {
            return tokenSummary.detail;
          }
          return `configured credentials unavailable in this command path · accounts ${unavailableConfiguredAccounts.length}`;
        }

        if (tokenSummary.detail) {
          return tokenSummary.detail;
        }

        if (configuredAccounts.length > 0) {
          const head = "configured";
          if (accounts.length <= 1 && !plugin.meta.forceAccountBinding) {
            return head;
          }
          return `${head} · accounts ${configuredAccounts.length}/${enabledAccounts.length || 1}`;
        }

        const reason =
          defaultEntry?.kind === "resolved" && plugin.config.unconfiguredReason
            ? plugin.config.unconfiguredReason(defaultEntry.account, cfg)
            : defaultEntry?.snapshot.stateReason;
        return reason ?? "not configured";
      })();
      return { state, detail };
    })();

    rows.push({
      id: plugin.id,
      label,
      enabled: anyEnabled,
      ...status,
    });

    if (configuredAccounts.length > 0) {
      details.push({
        title: `${label} accounts`,
        columns: ["Account", "Status", "Notes"],
        rows: configuredAccounts.map((entry) => {
          const liveCredentialAvailable = hasRuntimeCredentialAvailable({
            liveAccounts,
            accountId: entry.accountId,
          });
          const notes = buildAccountNotes({
            plugin,
            cfg,
            entry,
            liveCredentialAvailable,
          });
          return {
            Account: formatAccountLabel({
              accountId: entry.accountId,
              name: entry.snapshot.name,
            }),
            Status:
              entry.enabled &&
              entry.kind !== "unavailable" &&
              (!hasConfiguredUnavailableCredentialStatus(entry.account) || liveCredentialAvailable)
                ? "OK"
                : "WARN",
            Notes: notes.join(" · "),
          };
        }),
      });
    }
  }

  const visibleChannelIds = new Set(rows.map((row) => row.id));
  const loadFailuresByChannel = new Map(
    readOnlyPlugins.loadFailures.map((failure) => [failure.channelId, failure] as const),
  );
  const missingConfiguredChannelIds = readOnlyPlugins.missingConfiguredChannelIds.toSorted(
    (left, right) => left.localeCompare(right),
  );
  for (const channelId of missingConfiguredChannelIds) {
    if (visibleChannelIds.has(channelId)) {
      continue;
    }
    const failure = loadFailuresByChannel.get(channelId);
    if (!failure) {
      continue;
    }
    rows.push({
      id: channelId,
      label: channelId,
      enabled: true,
      state: "warn",
      detail: formatLoadFailureDetail(failure.message),
    });
    visibleChannelIds.add(channelId);
  }

  const explicitConfiguredChannelIds = new Set([
    ...listExplicitConfiguredChannelIdsForConfig(sourceConfig),
    ...listExplicitConfiguredChannelIdsForConfig(cfg),
  ]);
  const missingCandidateChannelIds = [
    ...new Set([...readOnlyPlugins.missingConfiguredChannelIds, ...explicitConfiguredChannelIds]),
  ].toSorted((left, right) => left.localeCompare(right));
  const missingHintsByChannelId = new Map(
    resolveMissingOfficialExternalChannelPluginRepairHints({
      config: cfg,
      activationSourceConfig: sourceConfig,
      channelIds: missingCandidateChannelIds,
      manifestRecords: readOnlyPlugins.manifestRecords,
    }).map((hint) => [hint.channelId, hint]),
  );
  const addFastModeRow = (channelId: string) => {
    rows.push({
      id: channelId,
      label: sanitizeForLog(channelId).trim() || "configured-channel",
      enabled: true,
      state: "setup",
      detail: "configured; status unavailable in fast mode",
    });
    visibleChannelIds.add(channelId);
  };
  for (const channelId of missingCandidateChannelIds) {
    if (visibleChannelIds.has(channelId)) {
      continue;
    }
    const hint = missingHintsByChannelId.get(channelId);
    if (!hint) {
      if (!includeSetupFallbackPlugins && explicitConfiguredChannelIds.has(channelId)) {
        // Fast mode intentionally skips setup fallback plugins, but configured ids still deserve visibility.
        addFastModeRow(channelId);
      }
      continue;
    }
    rows.push({
      id: channelId,
      label: hint.label,
      enabled: true,
      state: "warn",
      detail: `plugin not installed - run ${hint.installCommand} or ${hint.doctorFixCommand}`,
    });
    visibleChannelIds.add(channelId);
  }

  if (!includeSetupFallbackPlugins) {
    for (const channelId of missingConfiguredChannelIds) {
      if (visibleChannelIds.has(channelId)) {
        continue;
      }
      addFastModeRow(channelId);
    }
  }

  return {
    rows,
    details,
  };
}
