import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { ChannelStatus } from "../../api/types.ts";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import "../../components/modal-dialog.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { channelDocsUrl } from "./hub-meta.ts";
import { ChannelConfig } from "./view.config.tsx";
import { NostrCard } from "./view.nostr.tsx";
import { renderChannelPairingDetail } from "./view.pairing.tsx";
import {
  boolStatusKind,
  booleanChannelFact,
  ChannelAccount,
  ChannelActions,
  ChannelError,
  ChannelFacts,
  ChannelProbe,
  resolveChannelAccountCount,
  resolveChannelDisplayState,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";
import { WhatsAppCard } from "./view.whatsapp.tsx";

const STANDARD_CHANNEL_LOCALE_KEYS = {
  discord: "discord",
  googlechat: "googleChat",
  imessage: "imessage",
  signal: "signal",
  slack: "slack",
  telegram: "telegram",
} as const;

type StandardChannelKey = keyof typeof STANDARD_CHANNEL_LOCALE_KEYS;

function isStandardChannel(key: string): key is StandardChannelKey {
  return Object.hasOwn(STANDARD_CHANNEL_LOCALE_KEYS, key);
}

function ChannelStatusBody(params: {
  channelId: string;
  props: ChannelsProps;
  accountCount?: number;
}) {
  const standardKey = createMemo(() => {
    const key = params.channelId;
    return isStandardChannel(key) ? key : null;
  });
  const localeKey = createMemo(() => {
    const key = standardKey();
    return key ? STANDARD_CHANNEL_LOCALE_KEYS[key] : null;
  });
  const snapshot = createMemo(() => params.props.channels.channelsSnapshot);
  const status = createMemo(() => {
    const key = standardKey();
    // SAFETY: The bundled channel ID selects its schema-light channels.status summary contract.
    return (key ? snapshot()?.channels[key] : undefined) as ChannelStatus | null | undefined;
  });
  const displayState = createMemo(() => resolveChannelDisplayState(params.channelId, params.props));
  const configured = createMemo(() => displayState().configured);
  const accounts = createMemo(() =>
    resolveChannelAccounts(snapshot()?.channelAccounts, params.channelId),
  );
  const showAccounts = createMemo(() =>
    standardKey() === "telegram" ? accounts().length > 1 : !standardKey() && accounts().length > 0,
  );
  const extraRows = createMemo(() =>
    standardKey() === "googlechat"
      ? [
          {
            label: t("common.credential"),
            value: status()?.credentialSource ?? t("common.na"),
          },
          {
            label: t("common.audience"),
            value: status()?.audienceType
              ? `${status()?.audienceType}${status()?.audience ? ` · ${status()?.audience}` : ""}`
              : t("common.na"),
          },
        ]
      : standardKey() === "signal"
        ? [{ label: t("common.baseUrl"), value: status()?.baseUrl ?? t("common.na") }]
        : standardKey() === "telegram"
          ? [{ label: t("common.mode"), value: status()?.mode ?? t("common.na") }]
          : [],
  );
  const statusRows = createMemo(() => [
    booleanChannelFact("configured", configured()),
    booleanChannelFact(
      "running",
      !standardKey()
        ? displayState().running
        : standardKey() === "googlechat" && !status()
          ? null
          : (status()?.running ?? false),
    ),
    ...(standardKey()
      ? [
          ...extraRows(),
          ...(["lastStartAt", "lastProbeAt"] as const).map((field) => ({
            label: t(field === "lastStartAt" ? "common.lastStart" : "common.lastProbe"),
            value: status()?.[field]
              ? formatRelativeTimestamp(status()?.[field] ?? null)
              : t("common.na"),
          })),
        ]
      : [booleanChannelFact("connected", displayState().connected)]),
  ]);
  const lastError = createMemo(() =>
    readStringField(
      asNullableRecord(standardKey() ? status() : displayState().status),
      "lastError",
    ),
  );

  return (
    <SettingsSection
      title={
        localeKey()
          ? t(`channels.${localeKey()}.title`)
          : (readStringField(
              params.props.channels.channelsSnapshot?.channelLabels,
              params.channelId,
            ) ?? params.channelId)
      }
      description={
        localeKey() ? t(`channels.${localeKey()}.subtitle`) : t("channels.generic.subtitle")
      }
      count={params.accountCount !== undefined ? params.accountCount : undefined}
    >
      {showAccounts() ? (
        accounts().map((account) => {
          const username =
            standardKey() === "telegram"
              ? readStringField(asNullableRecord(asNullableRecord(account.probe)?.bot), "username")
              : undefined;
          return (
            <ChannelAccount
              title={username ? `@${username}` : account.name || account.accountId}
              accountId={account.accountId}
              facts={
                standardKey() === "telegram"
                  ? [
                      `${t("common.configured")}: ${account.configured ? t("common.yes") : t("common.no")}`,
                    ]
                  : undefined
              }
              status={{
                kind: boolStatusKind(
                  standardKey() === "telegram"
                    ? account.running
                    : (account.running ?? account.configured),
                ),
                label: account.running
                  ? t("common.running")
                  : !standardKey() && account.configured
                    ? t("common.configured")
                    : t("common.no"),
              }}
              lastInboundAt={account.lastInboundAt}
              lastError={account.lastError}
            />
          );
        })
      ) : (
        <ChannelFacts rows={statusRows()} />
      )}
      {lastError() ? <ChannelError message={lastError()} /> : undefined}
      {standardKey() ? (
        <Show when={status()?.probe}>{(probe) => <ChannelProbe probe={probe()} />}</Show>
      ) : undefined}
      <ChannelConfig channelId={params.channelId} props={params.props} />
      {standardKey() ? (
        <ChannelActions>
          <button
            class="btn"
            disabled={params.props.channels.channelsLoading}
            aria-busy={params.props.channels.channelsLoading ? "true" : "false"}
            onClick={() => params.props.onRefresh(true)}
          >
            {t(params.props.channels.channelsLoading ? "common.refreshing" : "common.probe")}
          </button>
        </ChannelActions>
      ) : undefined}
    </SettingsSection>
  );
}

export function renderChannelDetail(params: {
  channelId: string;
  label: string;
  pluginIconUrl?: string;
  props: ChannelsProps;
  onClose: () => void;
  onSetup: () => void;
}): JSX.Element {
  const statusIssues = createMemo(() =>
    params.props.channels.channelsSnapshot?.statusIssues?.filter(
      (issue) => issue.channel === params.channelId,
    ),
  );
  return (
    <openclaw-modal-dialog label={params.label} onModal-cancel={() => params.onClose()}>
      <div class="channels-detail">
        <div class="channels-detail__header">
          <LitContent
            render={() =>
              renderChannelIcon(params.channelId, params.label, "cover", {
                pluginIconUrl: params.pluginIconUrl,
              })
            }
          />
          <div class="channels-detail__header-actions">
            <a
              class="btn btn--sm"
              href={channelDocsUrl(params.channelId)}
              target="_blank"
              rel="noreferrer"
            >
              {t("common.docs")}
            </a>
            <button
              type="button"
              class="btn btn--sm"
              title={params.props.canAdmin ? "" : t("channels.hub.adminRequired")}
              disabled={!params.props.canAdmin}
              onClick={() => params.onSetup()}
            >
              {t("channels.hub.runSetup")}
            </button>
            <button
              type="button"
              class="btn channels-detail__close"
              aria-label={t("common.close")}
              onClick={() => params.onClose()}
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div class="channels-detail__body">
          {params.props.wizardHost.blockedByDirtyConfig && params.props.config.configFormDirty ? (
            <div class="callout warn">{t("channels.hub.saveBeforeSetup")}</div>
          ) : undefined}
          <For each={statusIssues()}>
            {(issue) => (
              <div class="callout warn" role="note">
                <strong>
                  {t("channels.hub.stateAttention")} · {formatUiExternalText(issue.accountId)}
                </strong>
                <div>{formatUiExternalText(issue.message)}</div>
                {issue.fix ? <div>{formatUiExternalText(issue.fix)}</div> : undefined}
              </div>
            )}
          </For>
          {renderChannelPairingDetail(params.channelId, params.props)}{" "}
          {params.channelId === "whatsapp" ? (
            <WhatsAppCard {...params.props} />
          ) : params.channelId === "nostr" ? (
            <NostrCard {...params.props} />
          ) : (
            <ChannelStatusBody
              channelId={params.channelId}
              props={params.props}
              accountCount={resolveChannelAccountCount(
                params.channelId,
                params.props.channels.channelsSnapshot?.channelAccounts,
              )}
            />
          )}
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}
