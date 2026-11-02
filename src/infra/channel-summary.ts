import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveInspectedChannelAccount,
  type ChannelAccountInspectionResult,
} from "../channels/account-inspection.js";
import { hasConfiguredUnavailableCredentialStatus } from "../channels/account-snapshot-fields.js";
import { buildChannelAccountNotes, formatChannelAllowFrom } from "../channels/account-summary.js";
import { formatChannelStatusState } from "../channels/plugins/status-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { formatTimeAgo } from "./format-time/format-relative.ts";

export async function buildChannelSummary(
  cfg: OpenClawConfig,
  options?: {
    colorize?: boolean;
    includeAllowFrom?: boolean;
    sourceConfig?: OpenClawConfig;
  },
): Promise<string[]> {
  const lines: string[] = [];
  const { colorize = false, includeAllowFrom = false } = options ?? {};
  const sourceConfig = options?.sourceConfig ?? cfg;

  const plugins = await (
    await import("../channels/plugins/read-only.js")
  ).listReadOnlyChannelPluginsForConfigAsync(cfg, {
    activationSourceConfig: sourceConfig,
    includeSetupFallbackPlugins: false,
  });
  for (const plugin of plugins) {
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId =
      plugin.config.defaultAccountId?.(cfg) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];
    const entries: (ChannelAccountInspectionResult & {
      accountId: string;
    })[] = [];

    for (const accountId of resolvedAccountIds) {
      const inspected = await resolveInspectedChannelAccount({
        plugin,
        cfg,
        sourceConfig,
        accountId,
      });
      entries.push({ accountId, ...inspected });
    }

    const configuredEntries = entries.filter((entry) => entry.configured);
    const anyEnabled = entries.some((entry) => entry.enabled);
    const configurationUnknown = entries.some(
      (entry) => entry.enabled && entry.configured === undefined,
    );
    const fallbackEntry =
      entries.find((entry) => entry.accountId === defaultAccountId) ?? entries[0];
    const summary =
      fallbackEntry?.kind === "resolved" && plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: fallbackEntry.account,
            cfg,
            defaultAccountId,
            snapshot: fallbackEntry.snapshot,
          })
        : fallbackEntry?.snapshot;

    const summaryRecord = asNullableRecord(summary);
    const statusState =
      summaryRecord && typeof summaryRecord.statusState === "string"
        ? summaryRecord.statusState
        : null;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    const configured =
      summaryRecord && typeof summaryRecord.configured === "boolean"
        ? summaryRecord.configured
        : configuredEntries.length > 0;

    const status = !anyEnabled
      ? "disabled"
      : configurationUnknown
        ? "configuration status unavailable"
        : statusState
          ? formatChannelStatusState(statusState)
          : linked !== null
            ? linked
              ? "linked"
              : "not linked"
            : configured
              ? "configured"
              : "not configured";

    const statusColor =
      status === "linked" || status === "configured"
        ? theme.success
        : status === "not linked" || status === "auth stabilizing"
          ? theme.error
          : theme.muted;
    const baseLabel = sanitizeForLog(plugin.meta.label ?? plugin.id).trim() || plugin.id;
    let line = `${baseLabel}: ${status}`;

    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    const self = summaryRecord?.self as { e164?: string | null } | undefined;
    if (self?.e164) {
      line += ` ${self.e164}`;
    }
    if (authAgeMs != null && authAgeMs >= 0) {
      line += ` auth ${formatTimeAgo(authAgeMs)}`;
    }

    lines.push(colorize ? statusColor(line) : line);

    for (const entry of configuredEntries) {
      const snapshot = entry.snapshot;
      const details = buildChannelAccountNotes(
        snapshot,
        entry.kind === "unavailable" || hasConfiguredUnavailableCredentialStatus(entry.account)
          ? "secret unavailable in this command path"
          : undefined,
      );
      if (includeAllowFrom && snapshot.allowFrom?.length) {
        const formatted = formatChannelAllowFrom({
          plugin,
          cfg,
          accountId: snapshot.accountId,
          allowFrom: snapshot.allowFrom,
        }).slice(0, 2);
        if (formatted.length > 0) {
          details.push(`allow:${formatted.join(",")}`);
        }
      }
      const accountId = entry.accountId || DEFAULT_ACCOUNT_ID;
      const name = entry.snapshot.name?.trim();
      const label = name ? `${accountId} (${name})` : accountId;
      lines.push(`  - ${label}${details.length ? ` (${details.join(", ")})` : ""}`);
    }
  }

  return lines;
}
