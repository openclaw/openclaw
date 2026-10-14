import { createMemo, For, Show } from "solid-js";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import "../../styles/channels.css";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import "../../components/openclaw-mascot.ts";
import { channelSnapshotEntryIsActive, resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { renderChannelDetail as ChannelDetail } from "./view.detail.tsx";
import { renderChannelPairingPrompt, renderChannelPairingQueue } from "./view.pairing.tsx";
import { ChannelRefresh, resolveChannelDisplayState } from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";
import { ChannelWizard } from "./wizard-view.tsx";

const CHANNEL_CARD_STATES = {
  running: { kind: "ok", labelKey: "channels.hub.stateRunning" },
  configured: { kind: "muted", labelKey: "channels.hub.stateConfigured" },
  attention: { kind: "danger", labelKey: "channels.hub.stateAttention" },
} as const;
type ChannelCardState = keyof typeof CHANNEL_CARD_STATES;

const RECOMMENDED_CHANNEL_ORDER: string[] = [
  "whatsapp",
  "telegram",
  "discord",
  "googlechat",
  "slack",
  "signal",
  "imessage",
  "nostr",
];

export function ChannelsView(props: ChannelsProps) {
  const snapshot = createMemo(() => props.channels.channelsSnapshot);
  const channelOrder = createMemo(() => resolveChannelOrder(snapshot()));
  // Key both lists so status updates cannot retarget an in-flight channel click.
  const connected = createMemo(() =>
    channelOrder().filter((key) => channelSnapshotEntryIsActive(snapshot(), key)),
  );
  const available = createMemo(() =>
    channelOrder().filter((key) => !channelSnapshotEntryIsActive(snapshot(), key)),
  );
  const showingStaleSnapshot = createMemo(() =>
    Boolean(
      props.channels.channelsLoading &&
      props.channels.channelsSnapshot &&
      props.channels.channelsLastSuccess,
    ),
  );
  const partialWarnings = createMemo(
    () =>
      props.channels.channelsSnapshot?.warnings
        ?.filter((warning) => warning.trim())
        .slice(0, 3)
        .map((warning) => formatUiExternalText(warning))
        .join("; ") ?? "",
  );

  return (
    <>
      <SettingsPage>
        {showingStaleSnapshot() ? (
          <div class="callout info">{t("channels.refreshingStaleSnapshot")}</div>
        ) : undefined}
        {props.channels.channelsSnapshot?.partial ? (
          <div class="callout warn">
            {t("channels.hub.partialSnapshot")}
            {partialWarnings()}
          </div>
        ) : undefined}
        {props.channels.channelsError ? (
          <div class="callout danger">{props.channels.channelsError}</div>
        ) : undefined}
        {props.wizardHost.blockedByDirtyConfig && props.config.configFormDirty ? (
          <div class="callout warn">{t("channels.hub.saveBeforeSetup")}</div>
        ) : undefined}
        <SettingsSection
          title={t("channels.hub.connectedTitle")}
          count={connected().length > 0 ? connected().length : undefined}
          actions={
            <ChannelRefresh
              updatedAt={props.channels.channelsLastSuccess}
              disabled={props.channels.channelsLoading}
              onRefresh={() => props.onRefresh(true)}
            />
          }
        >
          {connected().length === 0 ? (
            <div class="channels-empty">
              {/* No configured transports is a true empty state, so Clawd rests here. */}
              <openclaw-mascot mood="sleepy" prop:size={80} />
              <SettingsEmpty message={t("channels.hub.noneConnected")} />
            </div>
          ) : (
            <For each={connected()}>{(key) => <ConnectedRow channelId={key} props={props} />}</For>
          )}
        </SettingsSection>
        <SettingsSection
          title={t("channels.hub.addTitle")}
          description={t("channels.hub.addSubtitle")}
        >
          {!props.canAdmin ? (
            <div class="callout info" role="note">
              {t("channels.hub.adminRequired")}
            </div>
          ) : (
            <>
              <For each={available()}>
                {(key) => <AvailableRow channelId={key} props={props} />}
              </For>
              {renderBrowseAllRow(props)}
            </>
          )}
        </SettingsSection>
        {renderChannelPairingQueue(props)}
      </SettingsPage>
      <Show when={props.selectedChannel} keyed>
        {(channel) => (
          <ChannelDetail
            channelId={channel}
            label={resolveChannelLabel(props, channel)}
            pluginIconUrl={props.presentation.pluginIconUrls[channel]}
            props={props}
            onClose={() => props.onCloseDetail()}
            onSetup={() => props.onStartSetup(channel)}
          />
        )}
      </Show>
      {props.canAdmin ? (
        <ChannelWizard
          wizard={props.wizardHost.state}
          channelLabel={(channelId) => resolveChannelLabel(props, channelId)}
          channelIconUrl={(channelId) => props.presentation.pluginIconUrls[channelId]}
          multiselectValues={props.wizardHost.multiselect}
          onToggleMultiselect={(value) => props.wizardHost.toggleMultiselect(value)}
          textValue={props.wizardHost.textValue}
          secretVisible={props.wizardHost.secretVisible}
          onTextInput={(value) => (props.wizardHost.textValue = value)}
          onToggleSecretVisibility={() => props.wizardHost.toggleSecretVisibility()}
          onAnswer={(value) => props.wizardHost.answer(value)}
          onClose={() => props.wizardHost.close()}
          whatsappQrDataUrl={props.channels.whatsappLoginQrDataUrl}
          whatsappMessage={props.channels.whatsappLoginMessage}
          whatsappConnected={props.channels.whatsappLoginConnected}
          whatsappBusy={props.channels.whatsappBusy}
          onWhatsAppStart={props.onWhatsAppStart}
          onWhatsAppWait={props.onWhatsAppWait}
        />
      ) : undefined}
      {renderChannelPairingPrompt(props)}
    </>
  );
}

export function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): string[] {
  const statusOrder = snapshot?.channelMeta?.length
    ? snapshot.channelMeta.map((entry) => entry.id)
    : (snapshot?.channelOrder ?? []);
  return [...new Set([...statusOrder, ...RECOMMENDED_CHANNEL_ORDER])];
}

function resolveChannelPlugin(props: ChannelsProps, key: string) {
  return props.presentation.pluginCatalog?.plugins.find((plugin) => plugin.id === key);
}

function resolveChannelLabel(props: ChannelsProps, key: string): string {
  const snapshot = props.channels.channelsSnapshot;
  const labels = snapshot?.channelLabels;
  return (
    resolveChannelPlugin(props, key)?.name ??
    snapshot?.channelMeta?.find((entry) => entry.id === key)?.label ??
    (labels && Object.hasOwn(labels, key) ? labels[key] : undefined) ??
    key
  );
}

function resolveChannelDetailLabel(props: ChannelsProps, key: string): string | null {
  const snapshot = props.channels.channelsSnapshot;
  const labels = snapshot?.channelDetailLabels;
  const detail =
    snapshot?.channelMeta?.find((entry) => entry.id === key)?.detailLabel ??
    (labels && Object.hasOwn(labels, key) ? labels[key] : null);
  return detail && detail !== resolveChannelLabel(props, key) ? detail : null;
}

function resolveRowState(key: string, props: ChannelsProps): ChannelCardState {
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" && displayState.status.lastError.trim()
      ? displayState.status.lastError
      : resolveChannelAccounts(props.channels.channelsSnapshot?.channelAccounts, key).find(
          (account) => account.lastError,
        )?.lastError;
  if (lastError) {
    return "attention";
  }
  if (displayState.running === true || displayState.connected === true) {
    return "running";
  }
  return "configured";
}

function rowStatus(state: ChannelCardState) {
  const { kind, labelKey } = CHANNEL_CARD_STATES[state];
  return <SettingsStatus kind={kind} label={t(labelKey)} />;
}

function lastActivityLine(key: string, props: ChannelsProps): string | null {
  const lastInbound = resolveChannelAccounts(
    props.channels.channelsSnapshot?.channelAccounts,
    key,
  ).reduce((latest, account) => Math.max(latest, account.lastInboundAt ?? 0), 0);
  if (!lastInbound) {
    return null;
  }
  return t("channels.hub.lastMessageAgo", { ago: formatRelativeTimestamp(lastInbound) });
}

function ConnectedRow(params: { channelId: string; props: ChannelsProps }) {
  const label = createMemo(() => resolveChannelLabel(params.props, params.channelId));
  const statusIssue = createMemo(() =>
    params.props.channels.channelsSnapshot?.statusIssues?.find(
      (issue) => issue.channel === params.channelId,
    ),
  );
  const description = createMemo(() =>
    statusIssue()
      ? formatUiExternalText(statusIssue()?.message)
      : (lastActivityLine(params.channelId, params.props) ??
        resolveChannelDetailLabel(params.props, params.channelId) ??
        t("channels.hub.openDetails")),
  );
  return (
    <button
      type="button"
      class="settings-row settings-row--nav channels-item"
      onClick={() => params.props.onShowDetail(params.channelId)}
    >
      <LitContent
        render={() =>
          renderChannelIcon(params.channelId, label(), "tile", {
            pluginIconUrl: params.props.presentation.pluginIconUrls[params.channelId],
          })
        }
      />
      <div class="settings-row__text">
        <span class="settings-row__title">{label()}</span>
        <span class="settings-row__desc">{description()}</span>
      </div>
      <div class="settings-row__control">
        {rowStatus(statusIssue() ? "attention" : resolveRowState(params.channelId, params.props))}
        <span class="settings-row__chevron">
          <Icon name="chevronRight" />
        </span>
      </div>
    </button>
  );
}

function AvailableRow(params: { channelId: string; props: ChannelsProps }) {
  const plugin = createMemo(() => resolveChannelPlugin(params.props, params.channelId));
  const label = createMemo(() => resolveChannelLabel(params.props, params.channelId));
  const description = createMemo(
    () =>
      plugin()?.description ??
      resolveChannelDetailLabel(params.props, params.channelId) ??
      t("channels.hub.guidedSetup"),
  );
  return (
    <div class="settings-row channels-item">
      <button
        type="button"
        class="channels-item__detail"
        title={t("channels.hub.openDetails")}
        onClick={() => params.props.onShowDetail(params.channelId)}
      >
        <LitContent
          render={() =>
            renderChannelIcon(params.channelId, label(), "tile", {
              pluginIconUrl: params.props.presentation.pluginIconUrls[params.channelId],
            })
          }
        />
        <span class="settings-row__text">
          <span class="settings-row__title">{label()}</span>
          <span class="settings-row__desc">{description()}</span>
        </span>
      </button>
      <div class="settings-row__control">
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => params.props.onStartSetup(params.channelId)}
        >
          {t("channels.hub.setUp")}
        </button>
      </div>
    </div>
  );
}

function renderBrowseAllRow(props: ChannelsProps) {
  return (
    <button
      type="button"
      class="settings-row settings-row--nav channels-item"
      onClick={() => props.onStartSetup(null)}
    >
      <span
        class="channels-tile channels-tile--fallback"
        style={{ "--channels-art-a": "#64748b", "--channels-art-b": "#1e293b" }}
        aria-hidden="true"
      >
        <span>+</span>
      </span>
      <div class="settings-row__text">
        <span class="settings-row__title">{t("channels.hub.browseAllTitle")}</span>
        <span class="settings-row__desc">{t("channels.hub.browseAllSubtitle")}</span>
      </div>
      <div class="settings-row__control">
        <span class="settings-row__chevron">
          <Icon name="chevronRight" />
        </span>
      </div>
    </button>
  );
}
