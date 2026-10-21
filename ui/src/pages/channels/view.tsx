import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import "../../styles/channels.css";
import { ChannelIcon } from "../../components/solid/channel-icon.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import "../../components/openclaw-mascot.ts";
import { WizardBusyButton, WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  channelSnapshotEntryIsActive,
  resolveChannelAccounts,
  type ChannelRead,
  type ChannelsState,
} from "../../lib/channels/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../components/modal-dialog.ts";
import { channelDocsUrl } from "./hub-meta.ts";
import { renderChannelDetail as ChannelDetail } from "./view.detail.tsx";
import { renderChannelPairingPrompt, renderChannelPairingQueue } from "./view.pairing.tsx";
import { ChannelRefresh, resolveChannelDisplayState } from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";
import type { ChannelWizardState } from "./wizard-runner.ts";
registerEnglishCatalog(registerSettingsEnglish);

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

function ChannelStatusNotices(props: { channels: ChannelsState; error: string | null }) {
  const showingStaleSnapshot = () =>
    Boolean(
      props.channels.channelsLoading &&
      props.channels.channelsSnapshot &&
      props.channels.channelsLastSuccess,
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
      {showingStaleSnapshot() ? (
        <div class="callout info">{t("channels.refreshingStaleSnapshot")}</div>
      ) : undefined}
      {props.channels.channelsSnapshot?.partial ? (
        <div class="callout warn">
          {t("channels.hub.partialSnapshot")}
          {partialWarnings()}
        </div>
      ) : undefined}
      {props.error ? <div class="callout danger">{props.error}</div> : undefined}
    </>
  );
}

function ChannelStatusSettled(props: { channels: ChannelsState; receipt: ChannelRead }) {
  const ready = createMemo(async () => {
    const error = await props.receipt.completion;
    if (error !== null) {
      throw new Error(error);
    }
    return true;
  });
  return (
    <Show when={ready()}>
      <ChannelStatusNotices channels={props.channels} error={null} />
    </Show>
  );
}

function ChannelStatusFeedback(props: { channels: ChannelsState }) {
  const retained = () => (
    <ChannelStatusNotices channels={props.channels} error={props.channels.channelsError} />
  );
  return (
    <Show when={props.channels.channelsRead} keyed fallback={retained()}>
      {(receipt) => (
        <Errored
          fallback={(error) => (
            <ChannelStatusNotices channels={props.channels} error={formatUiError(error())} />
          )}
        >
          <Loading fallback={retained()}>
            <ChannelStatusSettled channels={props.channels} receipt={receipt} />
          </Loading>
        </Errored>
      )}
    </Show>
  );
}

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

  return (
    <>
      <SettingsPage>
        <ChannelStatusFeedback channels={props.channels} />
        {props.wizardHost.blockedByDirtyConfig() && props.config.configFormDirty ? (
          <div class="callout warn">{t("channels.hub.saveBeforeSetup")}</div>
        ) : undefined}
        <SettingsSection
          title={t("channels.hub.connectedTitle")}
          count={connected().length > 0 ? connected().length : undefined}
          actions={
            <ChannelRefresh
              updatedAt={props.channels.channelsLastSuccess}
              disabled={!props.channels.connected || props.channels.channelsLoading}
              onRefresh={() => props.onRefresh(true)}
            />
          }
        >
          {connected().length === 0 && snapshot() ? (
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
          {!props.canAdmin && props.channels.connected ? (
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
      {props.canAdmin ? <ChannelWizard {...props} /> : undefined}
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
      <ChannelIcon
        channelId={params.channelId}
        label={label()}
        variant="tile"
        pluginIconUrl={params.props.presentation.pluginIconUrls[params.channelId]}
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
        <ChannelIcon
          channelId={params.channelId}
          label={label()}
          variant="tile"
          pluginIconUrl={params.props.presentation.pluginIconUrls[params.channelId]}
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
          disabled={!params.props.channels.connected}
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
      disabled={!props.channels.connected}
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

function renderCloseButton(props: ChannelsProps, labelKey: string, primary = false) {
  return (
    <button type="button" class={["btn", { primary }]} onClick={() => props.wizardHost.close()}>
      {t(labelKey)}
    </button>
  );
}

function WizardStepBody(props: {
  wizard: Extract<ChannelWizardState, { phase: "step" }>;
  controls: ChannelsProps;
}) {
  const informational = () => ["note", "progress", "action"].includes(props.wizard.step.type);
  const message = () => props.wizard.step.message?.trim() ?? "";
  const gatewayOwned = () => props.wizard.step.executor === "gateway";
  const outputClass = () => [
    gatewayOwned() ? "channels-wizard__message" : "channels-wizard__output",
    !gatewayOwned() &&
      (message().includes("{") || message().includes("  ")) &&
      "channels-wizard__output--code",
  ];
  return (
    <Show
      when={informational()}
      fallback={
        <WizardStepControls
          step={props.wizard.step}
          value={
            props.wizard.step.type === "multiselect"
              ? props.controls.wizardHost.draft.multiselect
              : props.wizard.step.type === "text"
                ? props.controls.wizardHost.draft.textValue
                : props.wizard.step.initialValue
          }
          busy={props.wizard.busy}
          inputId="channel-wizard-text-input"
          validationErrorId={
            props.wizard.validationError ? "channel-wizard-validation-error" : undefined
          }
          presentation="channels"
          channelSelect={props.wizard.channel === null}
          answerLabel={t("channels.setup.continue")}
          busyLabel={t("channels.setup.working")}
          sensitiveRevealed={props.controls.wizardHost.draft.secretVisible}
          onValueChange={
            props.wizard.step.type === "text"
              ? (value) =>
                  props.controls.wizardHost.setTextValue(typeof value === "string" ? value : "")
              : (value) => props.controls.wizardHost.toggleMultiselect(value)
          }
          onAnswer={(value) => props.controls.wizardHost.answer(value)}
          onToggleSensitiveVisibility={() => props.controls.wizardHost.toggleSecretVisibility()}
        />
      }
    >
      {props.wizard.step.title ? (
        <div class="channels-wizard__message">{props.wizard.step.title}</div>
      ) : undefined}
      {message() ? <div class={outputClass()}>{message()}</div> : undefined}
      <openclaw-modal-actions class="channels-wizard__footer">
        {gatewayOwned() ? renderCloseButton(props.controls, "common.cancel") : undefined}
        {gatewayOwned() || props.wizard.busy ? (
          <WizardBusyButton
            statusLabel={(gatewayOwned() && message()) || t("channels.setup.working")}
          />
        ) : (
          <button
            type="button"
            class="btn primary"
            onClick={() => props.controls.wizardHost.answer(null)}
          >
            {t("channels.setup.continue")}
          </button>
        )}
      </openclaw-modal-actions>
    </Show>
  );
}

function renderWhatsAppLinking(props: ChannelsProps) {
  const connected = () => props.channels.whatsappLoginConnected === true;
  return (
    <>
      <div class="channels-wizard__message" role="status">
        {connected() ? t("channels.setup.whatsappLinked") : t("channels.setup.whatsappScanTitle")}
      </div>
      {props.channels.whatsappLoginMessage ? (
        <div class="channels-wizard__note" role="status">
          {props.channels.whatsappLoginMessage}
        </div>
      ) : undefined}
      {connected() ? undefined : (
        <>
          <div class="channels-wizard__qr">
            {props.channels.whatsappLoginQrDataUrl ? (
              <img
                src={props.channels.whatsappLoginQrDataUrl}
                alt={t("channels.setup.whatsappQrAlt")}
              />
            ) : props.channels.whatsappBusy ? undefined : (
              <div class="channels-wizard__spinner">{t("channels.setup.whatsappQrHint")}</div>
            )}
          </div>
          <div class="channels-wizard__note">{t("channels.setup.whatsappScanHelp")}</div>
        </>
      )}
      <openclaw-modal-actions class="channels-wizard__footer">
        {connected() ? (
          renderCloseButton(props, "channels.setup.finish", true)
        ) : (
          <>
            {props.channels.whatsappBusy ? (
              <WizardBusyButton statusLabel={t("channels.setup.whatsappQrLoading")} />
            ) : (
              <>
                <button type="button" class="btn" onClick={() => props.onWhatsAppStart(true)}>
                  {props.channels.whatsappLoginQrDataUrl
                    ? t("channels.setup.regenerateQr")
                    : t("common.showQr")}
                </button>
                {props.channels.whatsappLoginQrDataUrl ? (
                  <button type="button" class="btn primary" onClick={() => props.onWhatsAppWait()}>
                    {t("common.waitForScan")}
                  </button>
                ) : undefined}
              </>
            )}
            {renderCloseButton(props, "channels.setup.linkLater")}
          </>
        )}
      </openclaw-modal-actions>
    </>
  );
}

function renderDoneBody(channels: readonly string[], props: ChannelsProps) {
  if (channels.includes("whatsapp")) {
    return renderWhatsAppLinking(props);
  }
  const changed = channels.length > 0;
  return (
    <>
      <div class="channels-wizard__message" role="status">
        {t(changed ? "channels.setup.doneTitle" : "channels.setup.doneNoChangesTitle")}
      </div>
      <div class="channels-wizard__note">
        {t(changed ? "channels.setup.doneBody" : "channels.setup.doneNoChangesBody")}
      </div>
      <openclaw-modal-actions class="channels-wizard__footer">
        {renderCloseButton(props, changed ? "channels.setup.finish" : "common.close", true)}
      </openclaw-modal-actions>
    </>
  );
}

function ChannelWizard(props: ChannelsProps): JSX.Element {
  const activeWizard = () => {
    const wizard = props.wizardHost.state();
    return wizard.phase === "idle" ? undefined : wizard;
  };
  return (
    <Show when={activeWizard()}>
      {(wizard) => <WizardDialog wizard={wizard()} controls={props} />}
    </Show>
  );
}

function WizardDialog(props: {
  wizard: Exclude<ChannelWizardState, { phase: "idle" }>;
  controls: ChannelsProps;
}) {
  const label = createMemo(() =>
    props.wizard.channel
      ? resolveChannelLabel(props.controls, props.wizard.channel)
      : t("channels.setup.genericTitle"),
  );
  const step = () => (props.wizard.phase === "step" ? props.wizard : undefined);
  const error = () => (props.wizard.phase === "error" ? props.wizard : undefined);
  const done = () => (props.wizard.phase === "done" ? props.wizard : undefined);
  return (
    <openclaw-modal-dialog
      label={t("channels.setup.dialogLabel", { channel: label() })}
      onModal-cancel={() => props.controls.wizardHost.close()}
    >
      <div class="channels-wizard">
        <div class="channels-wizard__header">
          <Show when={props.wizard.channel}>
            {(channel) => (
              <ChannelIcon
                channelId={channel()}
                label={label()}
                variant="tile"
                pluginIconUrl={props.controls.presentation.pluginIconUrls[channel()]}
              />
            )}
          </Show>
          <div class="channels-wizard__heading">
            <h2>{t("channels.setup.title", { channel: label() })}</h2>
            <div class="muted channels-wizard__subtitle">
              <span>{t("channels.setup.subtitle")}</span>{" "}
              {props.wizard.channel ? (
                <a
                  class="channels-wizard__link"
                  href={channelDocsUrl(props.wizard.channel)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("channels.setup.viewDocs")}
                </a>
              ) : undefined}
            </div>
          </div>
        </div>
        <div class="channels-wizard__body">
          <Show when={step()?.step.externalUrl}>
            {(url) => (
              <div class="channels-wizard__links">
                <a
                  class="channels-wizard__link"
                  href={url()}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("channels.setup.openLink")}
                </a>
              </div>
            )}
          </Show>
          <Show when={props.wizard.phase === "starting"}>
            <openclaw-modal-actions class="channels-wizard__footer">
              <WizardBusyButton statusLabel={t("channels.setup.starting")} />
            </openclaw-modal-actions>
          </Show>
          <Show when={error()}>
            {(failure) => (
              <>
                <div class="channels-wizard__error" role="alert">
                  {failure().message}
                </div>
                <openclaw-modal-actions class="channels-wizard__footer">
                  {renderCloseButton(props.controls, "common.close")}
                </openclaw-modal-actions>
              </>
            )}
          </Show>
          <Show when={done()}>
            {(completed) => <>{renderDoneBody(completed().channels, props.controls)}</>}
          </Show>
          <Show when={step()}>
            {(current) => (
              <>
                {current().validationError ? (
                  <div
                    id="channel-wizard-validation-error"
                    class="channels-wizard__error"
                    role="alert"
                  >
                    {current().validationError}
                  </div>
                ) : undefined}
                <WizardStepBody wizard={current()} controls={props.controls} />
              </>
            )}
          </Show>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}
