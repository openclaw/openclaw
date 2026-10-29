// This layer stays plugin-generic: channel-specific auth rules live in plugin config/status hooks.

import fs from "node:fs";
import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  resolveInspectedChannelAccount,
  type ChannelAccountInspectionResult,
} from "../../channels/account-inspection.js";
import { resolveChannelAllowFrom } from "../../channels/account-resolution.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import {
  buildChannelAccountNotes,
  formatChannelAllowFrom,
} from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { formatChannelStatusState } from "../../channels/plugins/status-state.js";
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

function summarizeSources(sources: Array<string | undefined>): string {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const key = source?.trim() || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}${count > 1 ? `×${count}` : ""}`)
      .join("+") || "unknown"
  );
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

    // Plugin summaries are optional extension data; normalize only the fields the core table understands.
    const linkRecord = asRecord(summary);
    const statusState = typeof linkRecord.statusState === "string" ? linkRecord.statusState : null;
    const summaryLinked = typeof linkRecord.linked === "boolean" ? linkRecord.linked : null;
    const authAgeMs = typeof linkRecord.authAgeMs === "number" ? linkRecord.authAgeMs : null;
    const self = asRecord(linkRecord.self);
    const selfE164 = typeof self.e164 === "string" && self.e164.trim() ? self.e164.trim() : null;
    const link = { statusState, linked: summaryLinked, authAgeMs, selfE164 };
    const missingPaths: string[] = [];
    for (const entry of enabledAccounts) {
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
        const raw = accountRec[key] ?? snapshotRec[key];
        const path = normalizeOptionalString(raw);
        if (!path) {
          continue;
        }
        try {
          if (!fs.existsSync(path)) {
            missingPaths.push(String(raw));
          }
        } catch {
          // An inspection failure does not establish that the path is missing.
        }
      }
    }
    const tokenSummary = ((): { state: "ok" | "setup" | "warn" | null; detail: string | null } => {
      const enabled = accountsForTokenSummary.filter((a) => a.enabled);
      if (enabled.length === 0) {
        return { state: null, detail: null };
      }

      const accountRecs = enabled.map((a) => asRecord(a.account));
      // Token field names are plugin-owned; infer credential mode from exposed fields.
      const hasBotTokenField = accountRecs.some((r) => "botToken" in r);
      const hasAppTokenField = accountRecs.some((r) => "appToken" in r);
      const hasSigningSecretField = accountRecs.some(
        (r) => "signingSecret" in r || "signingSecretSource" in r || "signingSecretStatus" in r,
      );
      const hasTokenField = accountRecs.some((r) => "token" in r);
      if (!hasBotTokenField && !hasAppTokenField && !hasSigningSecretField && !hasTokenField) {
        return { state: null, detail: null };
      }

      const httpMode =
        hasBotTokenField &&
        hasSigningSecretField &&
        accountRecs.every((rec) => typeof rec.mode === "string" && rec.mode.trim() === "http");
      const unavailable = enabled.filter((a) =>
        hasConfiguredUnavailableCredentialStatus(a.account),
      );
      const tokenHint = (account: unknown, key: string) => {
        const value = asRecord(account)[key];
        if (typeof value !== "string" || !value.trim()) {
          return "";
        }
        const token = value.trim();
        if (!showSecrets) {
          // Stable fingerprints let operators compare tokens without leaking them.
          return `sha256:${sha256HexPrefixCore(token, 8)} · len ${token.length}`;
        }
        return token.length <= 10
          ? `${token} · len ${token.length}`
          : `${sliceUtf16Safe(token, 0, 4)}…${sliceUtf16Safe(token, -4)} · len ${token.length}`;
      };
      const paired = httpMode || (hasBotTokenField && hasAppTokenField);
      const tokenKey = hasBotTokenField ? "botToken" : "token";
      const secondaryKey = httpMode ? "signingSecret" : "appToken";
      const secondaryLabel = httpMode ? "signing" : "app";
      const label = paired
        ? httpMode
          ? "credentials"
          : "tokens"
        : hasBotTokenField
          ? "bot token"
          : "token";
      const need = paired ? ` (need bot+${secondaryLabel})` : "";
      const hasCredential = (rec: Record<string, unknown>, key: string) =>
        Boolean(normalizeOptionalString(rec[key])) ||
        (httpMode && rec[`${key}Status`] === "available");
      const ready = enabled.filter((a) => {
        const rec = asRecord(a.account);
        return hasCredential(rec, tokenKey) && (!paired || hasCredential(rec, secondaryKey));
      });
      const partial = paired
        ? enabled.filter((a) => {
            const rec = asRecord(a.account);
            return hasCredential(rec, tokenKey) !== hasCredential(rec, secondaryKey);
          }).length
        : 0;

      // HTTP reports unavailable credentials first; socket mode prioritizes incomplete pairs.
      if (unavailable.length > 0 && (httpMode || partial === 0)) {
        return {
          state: "warn",
          detail: `configured ${httpMode ? "http credentials" : label} unavailable in this command path · accounts ${unavailable.length}`,
        };
      }
      if (partial > 0) {
        return { state: "warn", detail: `partial ${label}${need} · accounts ${partial}` };
      }
      if (ready.length === 0) {
        return { state: "setup", detail: `no ${label}${need}` };
      }

      if (paired) {
        const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
        const secondarySources = summarizeSources(
          ready.map(
            (a) => a.snapshot[httpMode ? "signingSecretSource" : "appTokenSource"] ?? "none",
          ),
        );
        const botHint = tokenHint(ready[0]?.account, "botToken");
        const secondaryHint = tokenHint(ready[0]?.account, secondaryKey);
        const hint =
          botHint || secondaryHint
            ? ` (bot ${botHint || "?"}, ${secondaryLabel} ${secondaryHint || "?"})`
            : "";
        return {
          state: "ok",
          detail: `${label} ok (bot ${botSources}, ${secondaryLabel} ${secondarySources})${hint} · accounts ${ready.length}/${enabled.length}`,
        };
      }

      const source = hasBotTokenField
        ? "config"
        : summarizeSources(ready.map((a) => a.snapshot.tokenSource));
      const hint = tokenHint(ready[0]?.account, tokenKey);
      return {
        state: "ok",
        detail: `${label} ${source}${hint ? ` (${hint})` : ""} · accounts ${ready.length}/${enabled.length}`,
      };
    })();

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
        rows: await Promise.all(
          configuredAccounts.map(async (entry) => {
            const liveCredentialAvailable = hasRuntimeCredentialAvailable({
              liveAccounts,
              accountId: entry.accountId,
            });
            const snapshot = entry.snapshot;
            const unavailable =
              entry.kind === "unavailable" ||
              hasConfiguredUnavailableCredentialStatus(entry.account);
            const notes = buildChannelAccountNotes(
              snapshot,
              entry.kind === "unavailable"
                ? "secret unavailable in this command path"
                : liveCredentialAvailable
                  ? "credential available in gateway runtime"
                  : unavailable
                    ? "secret unavailable in this command path"
                    : undefined,
            );
            const allowFrom = unavailable
              ? snapshot.allowFrom
              : ((await resolveChannelAllowFrom({ plugin, cfg, accountId: snapshot.accountId })) ??
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
                .map((allowEntry) =>
                  formatPhoneNumberForCli(allowEntry, { allowInternationalDigits }),
                );
              if (formatted.length > 0) {
                notes.push(`allow:${formatted.join(",")}`);
              }
            }
            return {
              Account: entry.snapshot.name?.trim()
                ? `${entry.accountId || "default"} (${entry.snapshot.name.trim()})`
                : entry.accountId || "default",
              Status:
                entry.enabled &&
                entry.kind !== "unavailable" &&
                (!hasConfiguredUnavailableCredentialStatus(entry.account) ||
                  liveCredentialAvailable)
                  ? "OK"
                  : "WARN",
              Notes: notes.join(" · "),
            };
          }),
        ),
      });
    }
  }

  const visibleChannelIds = new Set(rows.map((row) => row.id));
  const addFallbackRow = (
    id: ChannelId,
    state: ChannelRow["state"],
    detail: string,
    label = id,
  ) => {
    rows.push({ id, label, enabled: true, state, detail });
    visibleChannelIds.add(id);
  };
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
    const reason =
      /(?:cannot find (?:module|package)|module_not_found|err_module_not_found|enoent|enotempty|missing package|failed to resolve)/iu.test(
        failure.message,
      )
        ? "dependency tree corrupted"
        : "registration failed";
    addFallbackRow(channelId, "warn", `plugin load failed: ${reason}; run openclaw doctor --fix`);
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
    addFallbackRow(
      channelId,
      "setup",
      "configured; status unavailable in fast mode",
      sanitizeForLog(channelId).trim() || "configured-channel",
    );
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
    addFallbackRow(
      channelId,
      "warn",
      `plugin not installed - run ${hint.installCommand} or ${hint.doctorFixCommand}`,
      hint.label,
    );
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
