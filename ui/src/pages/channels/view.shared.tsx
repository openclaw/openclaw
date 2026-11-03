import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { ChannelAccountSnapshot, ChannelStatus } from "../../api/types.ts";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { channelSnapshotEntryIsActive, resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ChannelsProps } from "./view.types.ts";

registerEnglishCatalog(registerSettingsEnglish);

type ChannelStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

type ChannelStatusRow = {
  label: string;
  value: JSX.Element;
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
    status,
  };
}

const CHANNEL_HEALTH = {
  running: { kind: "ok", labelKey: "channels.hub.stateRunning" },
  configured: { kind: "muted", labelKey: "channels.hub.stateConfigured" },
  attention: { kind: "danger", labelKey: "channels.hub.stateAttention" },
  notConfigured: { kind: "muted", labelKey: "channels.hub.stateNotConfigured" },
} as const;
type ChannelHealth = keyof typeof CHANNEL_HEALTH;

/** The last connection check, when this read asked for one. */
export function channelProbe(key: string, props: ChannelsProps) {
  // SAFETY: Channel plugins publish the probe summary under this schema-light status field.
  return resolveChannelDisplayState(key, props).status?.probe as ChannelStatus["probe"];
}

/** One answer to "does it work", shared by the channel's list row and its dialog. */
export function resolveChannelHealth(key: string, props: ChannelsProps): ChannelHealth {
  const snapshot = props.channels.channelsSnapshot;
  const display = resolveChannelDisplayState(key, props);
  const failed =
    snapshot?.statusIssues?.some((issue) => issue.channel === key) ||
    (typeof display.status?.lastError === "string" && display.status.lastError.trim()) ||
    resolveChannelAccounts(snapshot?.channelAccounts, key).some((account) => account.lastError) ||
    channelProbe(key, props)?.ok === false;
  if (failed) {
    return "attention";
  }
  if (display.running === true || display.connected === true) {
    return "running";
  }
  return channelSnapshotEntryIsActive(snapshot ?? null, key) ? "configured" : "notConfigured";
}

export function ChannelHealthStatus(params: { health: ChannelHealth }) {
  const state = () => CHANNEL_HEALTH[params.health];
  return <SettingsStatus kind={state().kind} label={t(state().labelKey)} />;
}

export function channelLastActivity(key: string, props: ChannelsProps): string | null {
  const lastInbound = resolveChannelAccounts(
    props.channels.channelsSnapshot?.channelAccounts,
    key,
  ).reduce((latest, account) => Math.max(latest, account.lastInboundAt ?? 0), 0);
  return lastInbound
    ? t("channels.hub.lastMessageAgo", { ago: formatRelativeTimestamp(lastInbound) })
    : null;
}

export function booleanChannelFact(
  field: "configured" | "linked" | "running" | "connected",
  value: boolean | null | undefined,
): ChannelStatusRow {
  return {
    label: t(`common.${field}`),
    value: t(value == null ? "common.na" : value ? "common.yes" : "common.no"),
    kind: boolStatusKind(value),
  };
}

/** Status kind for boolean facts: dot signals on, quiet dot signals off. */
export function boolStatusKind(value: boolean | null | undefined): ChannelStatusKind {
  return value === true ? "ok" : "muted";
}

export function ChannelFacts(params: { rows: readonly ChannelStatusRow[] }) {
  return (
    <dl class="settings-kv">
      <For each={params.rows}>
        {(row) => (
          <>
            <dt>{row.label}</dt>
            <dd>
              <Show when={row.kind} fallback={row.value}>
                {(kind) => <SettingsStatus kind={kind()} label={row.value} />}
              </Show>
            </dd>
          </>
        )}
      </For>
    </dl>
  );
}

export function ChannelRefresh(params: {
  updatedAt?: number | null;
  busy: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const updatedLabel = createMemo(() =>
    params.updatedAt
      ? t("channels.hub.updatedAgo", { ago: formatRelativeTimestamp(params.updatedAt) })
      : t("common.na"),
  );
  return (
    <RefreshButton
      class="channels-refresh"
      label={t("common.refresh")}
      tooltip={updatedLabel()}
      busy={params.busy}
      disabled={params.disabled}
      onClick={() => params.onRefresh()}
    />
  );
}

export function ChannelAccount(params: { title: JSX.Element; account: ChannelAccountSnapshot }) {
  const account = () => params.account;
  const health = (): ChannelHealth =>
    account().lastError
      ? "attention"
      : account().running
        ? "running"
        : account().configured
          ? "configured"
          : "notConfigured";
  const factLine = () =>
    [
      // A row titled by its id doesn't need the id again.
      params.title === account().accountId ? "" : account().accountId,
      account().lastInboundAt
        ? t("channels.hub.lastMessageAgo", {
            ago: formatRelativeTimestamp(account().lastInboundAt ?? null),
          })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">{params.title}</span>
        <span class="settings-row__desc">{factLine()}</span>
        {account().lastError ? (
          <span class="settings-row__desc">{formatUiExternalText(account().lastError)}</span>
        ) : undefined}
      </div>
      <div class="settings-row__control">
        <ChannelHealthStatus health={health()} />
      </div>
    </div>
  );
}
