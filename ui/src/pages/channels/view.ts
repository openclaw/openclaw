// Channels hub: connected-channel cards, add-a-channel gallery, setup wizard,
// and a per-channel detail overlay with the full config form.
import { html, nothing } from "lit";
import "../../styles/channels.css";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  ChannelUiMetaEntry,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelArt } from "./hub-meta.ts";
import { renderChannelDetail } from "./view.detail.ts";
import { channelEnabled, resolveChannelDisplayState } from "./view.shared.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderChannelWizard } from "./wizard-view.ts";

type ChannelCardState = "running" | "configured" | "attention" | "setup";

export function renderChannels(props: ChannelsProps) {
  const channelOrder = resolveChannelOrder(props.snapshot);
  const connected = channelOrder.filter((key) => channelEnabled(key, props));
  const available = channelOrder.filter((key) => !channelEnabled(key, props));
  const showingStaleSnapshot = Boolean(props.loading && props.snapshot && props.lastSuccessAt);
  const partialWarnings = props.snapshot?.warnings?.filter((warning) => warning.trim()) ?? [];
  const data = buildChannelData(props);
  const selected = props.selectedChannel;

  return html`
    <div class="channels-hub">
      ${showingStaleSnapshot
        ? html`<div class="callout info">${t("channels.refreshingStaleSnapshot")}</div>`
        : nothing}
      ${props.snapshot?.partial
        ? html`
            <div class="callout warn">
              ${t("channels.hub.partialSnapshot")}
              ${partialWarnings.length > 0 ? partialWarnings.slice(0, 3).join("; ") : ""}
            </div>
          `
        : nothing}
      ${props.lastError ? html`<div class="callout danger">${props.lastError}</div>` : nothing}

      <section>
        <div class="channels-group__heading">
          <h2>${t("channels.hub.connectedTitle")}</h2>
          <span class="muted">
            ${props.lastSuccessAt
              ? t("channels.hub.updatedAgo", {
                  ago: formatRelativeTimestamp(props.lastSuccessAt),
                })
              : t("common.na")}
            <button
              type="button"
              class="btn btn--sm"
              style="margin-left: 10px;"
              ?disabled=${props.loading}
              @click=${() => props.onRefresh(true)}
            >
              ${t("common.refresh")}
            </button>
          </span>
        </div>
        ${connected.length === 0
          ? html`<div class="muted">${t("channels.hub.noneConnected")}</div>`
          : html`
              <div class="channels-grid">
                ${connected.map((key) => renderConnectedCard(key, props))}
              </div>
            `}
      </section>

      <section>
        <div class="channels-group__heading">
          <h2>${t("channels.hub.addTitle")}</h2>
          <span class="muted">${t("channels.hub.addSubtitle")}</span>
        </div>
        <div class="channels-grid">
          ${available.map((key) => renderAvailableCard(key, props))} ${renderBrowseAllCard(props)}
        </div>
      </section>

      <details class="channels-health">
        <summary>${t("channels.health.title")}</summary>
        <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : t("channels.health.noSnapshotYet")}
        </pre>
      </details>
    </div>

    ${selected
      ? renderChannelDetail({
          channelId: selected,
          label: resolveChannelLabel(props.snapshot, selected),
          props,
          data,
          onClose: () => props.onCloseDetail(),
          onSetup: () => props.onStartSetup(selected),
        })
      : nothing}
    ${renderChannelWizard({
      wizard: props.wizard,
      channelLabel: (channelId) => resolveChannelLabel(props.snapshot, channelId),
      multiselectValues: props.wizardMultiselect,
      onToggleMultiselect: props.onWizardToggleMultiselect,
      onAnswer: props.onWizardAnswer,
      onClose: props.onWizardClose,
      whatsappQrDataUrl: props.whatsappQrDataUrl,
      whatsappMessage: props.whatsappMessage,
      whatsappConnected: props.whatsappConnected,
      whatsappBusy: props.whatsappBusy,
      onWhatsAppStart: props.onWhatsAppStart,
      onWhatsAppWait: props.onWhatsAppWait,
    })}
  `;
}

function buildChannelData(props: ChannelsProps): ChannelsChannelData {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  return {
    whatsapp: (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined,
    telegram: (channels?.telegram ?? undefined) as TelegramStatus | undefined,
    discord: (channels?.discord ?? null) as DiscordStatus | null,
    googlechat: (channels?.googlechat ?? null) as GoogleChatStatus | null,
    slack: (channels?.slack ?? null) as SlackStatus | null,
    signal: (channels?.signal ?? null) as SignalStatus | null,
    imessage: (channels?.imessage ?? null) as IMessageStatus | null,
    nostr: (channels?.nostr ?? null) as NostrStatus | null,
    channelAccounts: props.snapshot?.channelAccounts ?? null,
  };
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

function resolveChannelDetailLabel(
  snapshot: ChannelsStatusSnapshot | null,
  key: string,
): string | null {
  const meta = resolveChannelMetaMap(snapshot)[key];
  const detail = meta?.detailLabel ?? snapshot?.channelDetailLabels?.[key] ?? null;
  return detail && detail !== resolveChannelLabel(snapshot, key) ? detail : null;
}

function resolveCardState(key: ChannelKey, props: ChannelsProps): ChannelCardState {
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" && displayState.status.lastError.trim()
      ? displayState.status.lastError
      : (props.snapshot?.channelAccounts?.[key] ?? []).find((account) => account.lastError)
          ?.lastError;
  if (lastError) {
    return "attention";
  }
  if (displayState.running === true || displayState.connected === true) {
    return "running";
  }
  if (displayState.configured === true || displayState.hasAnyActiveAccount) {
    return "configured";
  }
  return "setup";
}

function cardStateLabel(state: ChannelCardState): string {
  switch (state) {
    case "running":
      return t("channels.hub.stateRunning");
    case "configured":
      return t("channels.hub.stateConfigured");
    case "attention":
      return t("channels.hub.stateAttention");
    case "setup":
      return t("channels.hub.stateSetup");
    default:
      return state satisfies never;
  }
}

function lastActivityLine(key: ChannelKey, props: ChannelsProps): string | null {
  const accounts: ChannelAccountSnapshot[] = props.snapshot?.channelAccounts?.[key] ?? [];
  const lastInbound = accounts
    .map((account) => account.lastInboundAt ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  if (!lastInbound) {
    return null;
  }
  return t("channels.hub.lastMessageAgo", { ago: formatRelativeTimestamp(lastInbound) });
}

function renderConnectedCard(key: ChannelKey, props: ChannelsProps) {
  const label = resolveChannelLabel(props.snapshot, key);
  const state = resolveCardState(key, props);
  const activity = lastActivityLine(key, props);
  const detailLabel = resolveChannelDetailLabel(props.snapshot, key);
  return html`
    <button type="button" class="channels-card" @click=${() => props.onShowDetail(key)}>
      ${renderChannelArt(key, label, "cover")}
      <span class="channels-card__body">
        <span class="channels-card__title">
          ${label}
          <span class="channels-state channels-state--${state}">${cardStateLabel(state)}</span>
        </span>
        <span class="channels-card__sub">
          ${activity ?? detailLabel ?? t("channels.hub.openDetails")}
        </span>
      </span>
    </button>
  `;
}

function renderAvailableCard(key: ChannelKey, props: ChannelsProps) {
  const label = resolveChannelLabel(props.snapshot, key);
  const detailLabel = resolveChannelDetailLabel(props.snapshot, key);
  return html`
    <button type="button" class="channels-card" @click=${() => props.onStartSetup(key)}>
      ${renderChannelArt(key, label, "cover")}
      <span class="channels-card__body">
        <span class="channels-card__title">
          ${label}
          <span class="channels-state channels-state--setup">${t("channels.hub.setUp")}</span>
        </span>
        <span class="channels-card__sub">${detailLabel ?? t("channels.hub.guidedSetup")}</span>
      </span>
    </button>
  `;
}

function renderBrowseAllCard(props: ChannelsProps) {
  return html`
    <button type="button" class="channels-card" @click=${() => props.onStartSetup(null)}>
      <span
        class="channels-cover channels-cover--fallback"
        style="--channels-art-a:#64748b;--channels-art-b:#1e293b"
        aria-hidden="true"
      >
        <span>+</span>
      </span>
      <span class="channels-card__body">
        <span class="channels-card__title">${t("channels.hub.browseAllTitle")}</span>
        <span class="channels-card__sub">${t("channels.hub.browseAllSubtitle")}</span>
      </span>
    </button>
  `;
}
