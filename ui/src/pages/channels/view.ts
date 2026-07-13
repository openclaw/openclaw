// Channels page renders its screen content.
import { html, nothing } from "lit";
import type {
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
  ChannelsStatusSnapshot,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../../api/types.ts";
import {
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import { renderDiscordCard } from "./view.discord.ts";
import { renderGoogleChatCard } from "./view.googlechat.ts";
import { renderIMessageCard } from "./view.imessage.ts";
import { renderNostrCard } from "./view.nostr.ts";
import {
  boolStatusKind,
  channelEnabled,
  formatNullableBoolean,
  renderChannelAccountRow,
  renderChannelErrorRow,
  renderChannelFacts,
  resolveChannelAccountCount,
  resolveChannelDisplayState,
} from "./view.shared.ts";
import { renderSignalCard } from "./view.signal.ts";
import { renderSlackCard } from "./view.slack.ts";
import { renderTelegramCard } from "./view.telegram.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderWhatsAppCard } from "./view.whatsapp.ts";

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined;
  const telegram = (channels?.telegram ?? undefined) as TelegramStatus | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const channelOrder = resolveChannelOrder(props.snapshot);
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, props),
      order: index,
    }))
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.order - b.order;
    });
  const showingStaleSnapshot = Boolean(props.loading && props.snapshot && props.lastSuccessAt);
  const partialWarnings = props.snapshot?.warnings?.filter((warning) => warning.trim()) ?? [];

  const healthRows = html`
    ${showingStaleSnapshot
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__desc">${t("channels.refreshingStaleSnapshot")}</span>
            </div>
          </div>
        `
      : nothing}
    ${props.snapshot?.partial
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title"
                >${renderSettingsStatus({
                  kind: "warn",
                  label: "Some channel checks did not finish before the UI budget.",
                })}</span
              >
              ${partialWarnings.length > 0
                ? html`<span class="settings-row__desc"
                    >${partialWarnings.slice(0, 3).join("; ")}</span
                  >`
                : nothing}
            </div>
          </div>
        `
      : nothing}
    ${props.lastError ? renderChannelErrorRow(props.lastError) : nothing}
    <div class="settings-row settings-row--stacked">
      <pre class="code-block">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : t("channels.health.noSnapshotYet")}
      </pre>
    </div>
  `;

  return renderSettingsPage(html`
    ${orderedChannels.map((channel) =>
      renderChannel(channel.key, props, {
        whatsapp,
        telegram,
        discord,
        googlechat,
        slack,
        signal,
        imessage,
        nostr,
        channelAccounts: props.snapshot?.channelAccounts ?? null,
      }),
    )}
    ${renderSettingsSection(
      {
        title: t("channels.health.title"),
        description: t("channels.health.subtitle"),
        actions: html`<span class="settings-row__value"
          >${props.lastSuccessAt
            ? formatRelativeTimestamp(props.lastSuccessAt)
            : t("common.na")}</span
        >`,
      },
      healthRows,
    )}
  `);
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

function renderChannel(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const accountCount = resolveChannelAccountCount(key, data.channelAccounts);
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCount,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCount,
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
        accountCount,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googleChat: data.googlechat,
        accountCount,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
        accountCount,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
        accountCount,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
        accountCount,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        accountCount,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(key, props, data.channelAccounts ?? {});
  }
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const label = resolveChannelLabel(props.snapshot, key);
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" ? displayState.status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCount = resolveChannelAccountCount(key, channelAccounts);

  return renderSettingsSection(
    {
      title: label,
      description: t("channels.generic.subtitle"),
      ...(accountCount !== undefined ? { count: accountCount } : {}),
    },
    html`
      ${accounts.length > 0
        ? accounts.map((account) => renderGenericAccount(account))
        : renderChannelFacts([
            {
              label: t("common.configured"),
              value: formatNullableBoolean(displayState.configured),
              kind: boolStatusKind(displayState.configured),
            },
            {
              label: t("common.running"),
              value: formatNullableBoolean(displayState.running),
              kind: boolStatusKind(displayState.running),
            },
            {
              label: t("common.connected"),
              value: formatNullableBoolean(displayState.connected),
              kind: boolStatusKind(displayState.connected),
            },
          ])}
      ${lastError ? renderChannelErrorRow(lastError) : nothing}
      ${renderChannelConfigSection({ channelId: key, props })}
    `,
  );
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

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): string {
  if (account.running) {
    return t("common.yes");
  }
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) {
    return t("common.active");
  }
  return t("common.no");
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): string {
  if (account.connected === true) {
    return t("common.yes");
  }
  if (account.connected === false) {
    return t("common.no");
  }
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) {
    return t("common.active");
  }
  return t("common.na");
}

function renderGenericAccount(account: ChannelAccountSnapshot) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);
  const effectivelyRunning = account.running || hasRecentActivity(account);

  return renderChannelAccountRow({
    title: account.name || account.accountId,
    accountId: account.accountId,
    facts: [
      `${t("common.running")}: ${runningStatus}`,
      `${t("common.configured")}: ${account.configured ? t("common.yes") : t("common.no")}`,
      `${t("common.connected")}: ${connectedStatus}`,
    ],
    status: {
      kind: boolStatusKind(effectivelyRunning),
      label: effectivelyRunning ? t("common.running") : t("common.no"),
    },
    lastInboundAt: account.lastInboundAt,
    lastError: account.lastError,
  });
}
