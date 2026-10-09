import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, ChannelStatus } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsRow, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { ChannelsProps } from "./view.types.ts";

type ChannelStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

type ChannelStatusRow = {
  label: string;
  value: unknown;
  /** Renders the value as a status dot + text instead of plain text. */
  kind?: ChannelStatusKind;
};

export function resolveChannelDisplayState(key: string, props: ChannelsProps) {
  const snapshot = props.channels.channelsSnapshot;
  const channels = snapshot?.channels;
  const status =
    channels && Object.hasOwn(channels, key)
      ? (asNullableRecord(channels[key]) ?? undefined)
      : undefined;
  const accounts = resolveChannelAccounts(snapshot?.channelAccounts, key);
  const defaultAccountIds = snapshot?.channelDefaultAccountId;
  const defaultAccountId =
    defaultAccountIds && Object.hasOwn(defaultAccountIds, key) ? defaultAccountIds[key] : undefined;
  const defaultAccount =
    (defaultAccountId
      ? accounts.find((account) => account.accountId === defaultAccountId)
      : undefined) ??
    accounts[0] ??
    null;
  const configured =
    typeof status?.configured === "boolean"
      ? status.configured
      : typeof defaultAccount?.configured === "boolean"
        ? defaultAccount.configured
        : null;
  const running = typeof status?.running === "boolean" ? status.running : null;
  const connected = typeof status?.connected === "boolean" ? status.connected : null;

  return {
    configured,
    running,
    connected,
    defaultAccount,
    status,
  };
}

export function formatNullableBoolean(value: boolean | null): string {
  return t(value == null ? "common.na" : value ? "common.yes" : "common.no");
}

/** Status kind for boolean facts: dot signals on, quiet dot signals off. */
export function boolStatusKind(value: boolean | null | undefined): ChannelStatusKind {
  return value === true ? "ok" : "muted";
}

export function renderChannelFacts(rows: readonly ChannelStatusRow[]) {
  return html`
    <dl class="settings-kv">
      ${rows.map(
        (row) => html`
          <dt>${row.label}</dt>
          <dd>
            ${
              row.kind !== undefined
                ? renderSettingsStatus({ kind: row.kind, label: row.value })
                : row.value
            }
          </dd>
        `,
      )}
    </dl>
  `;
}

export function renderChannelErrorRow(message: unknown) {
  return renderSettingsRow({
    title: renderSettingsStatus({ kind: "danger", label: t("channels.lastError") }),
    description: html`${formatUiError(message)}`,
  });
}

export function renderChannelProbeRow(probe: NonNullable<ChannelStatus["probe"]>) {
  const detail = formatUiExternalText(
    [probe.status ?? "", probe.error ?? ""].filter(Boolean).join(" "),
  );
  return renderSettingsRow({
    title: renderSettingsStatus({
      kind: probe.ok ? "ok" : "danger",
      label: probe.ok ? t("common.probeOk") : t("common.probeFailed"),
    }),
    description: detail,
  });
}

export function renderChannelActionRow(actions: unknown) {
  return html`
    <div class="settings-row settings-row--actions">
      <div class="settings-row__control">${actions}</div>
    </div>
  `;
}

export function renderChannelRefreshAction(params: {
  updatedAt?: number | null;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const updatedLabel = params.updatedAt
    ? t("channels.hub.updatedAgo", { ago: formatRelativeTimestamp(params.updatedAt) })
    : t("common.na");
  return html`<openclaw-tooltip .content=${updatedLabel}>
    <button
      type="button"
      class="btn btn--xs btn--icon"
      aria-label=${t("common.refresh")}
      ?disabled=${params.disabled}
      @click=${params.onRefresh}
    >
      ${icons.refresh}
    </button>
  </openclaw-tooltip>`;
}

export function renderChannelAccountRow(params: {
  title: unknown;
  accountId: string;
  facts?: readonly string[];
  status: { kind: ChannelStatusKind; label: unknown };
  lastInboundAt?: number | null;
  lastError?: string | null;
}) {
  const factLine = [params.accountId, ...(params.facts ?? [])].join(" · ");
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${params.title}</span>
        <span class="settings-row__desc">${factLine}</span>
        ${
          params.lastError
            ? html`<span class="settings-row__desc"
                >${formatUiExternalText(params.lastError)}</span
              >`
            : nothing
        }
      </div>
      <div class="settings-row__control">
        ${renderSettingsStatus(params.status)}
        <span class="settings-row__value"
          >${
            params.lastInboundAt ? formatRelativeTimestamp(params.lastInboundAt) : t("common.na")
          }</span
        >
      </div>
    </div>
  `;
}

/** Multi-account channels surface the account count next to the heading. */
export function resolveChannelAccountCount(
  key: string,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number | undefined {
  const count = resolveChannelAccounts(channelAccounts, key).length;
  return count >= 2 ? count : undefined;
}
