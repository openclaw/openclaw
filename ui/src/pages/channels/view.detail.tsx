import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { ChannelStatus } from "../../api/types.ts";
import { ChannelIcon } from "../../components/solid/channel-icon.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import "../../components/modal-dialog.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { channelDetailPresentations } from "./detail-presentation.ts";
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

function ChannelStatusBody(params: {
  channelId: string;
  props: ChannelsProps;
  accountCount?: number;
}) {
  const presentation = createMemo(() => channelDetailPresentations.get(params.channelId));
  const accountPresentation = createMemo(() => presentation()?.accounts);
  const snapshot = createMemo(() => params.props.channels.channelsSnapshot);
  const status = createMemo(() => {
    const profile = presentation();
    // SAFETY: The bundled channel ID selects its schema-light channels.status summary contract.
    return (profile ? snapshot()?.channels[params.channelId] : undefined) as
      | ChannelStatus
      | null
      | undefined;
  });
  const displayState = createMemo(() => resolveChannelDisplayState(params.channelId, params.props));
  const configured = createMemo(() => displayState().configured);
  const accounts = createMemo(() =>
    resolveChannelAccounts(snapshot()?.channelAccounts, params.channelId),
  );
  const showAccounts = createMemo(() => {
    const policy = accountPresentation();
    return presentation()
      ? Boolean(policy && accounts().length >= policy.minimumCount)
      : accounts().length > 0;
  });
  const extraRows = createMemo(() =>
    (presentation()?.extraFacts ?? []).map((fact) => {
      switch (fact) {
        case "credential":
          return {
            label: t("common.credential"),
            value: status()?.credentialSource ?? t("common.na"),
          };
        case "audience":
          return {
            label: t("common.audience"),
            value: status()?.audienceType
              ? `${status()?.audienceType}${status()?.audience ? ` · ${status()?.audience}` : ""}`
              : t("common.na"),
          };
        case "baseUrl":
          return { label: t("common.baseUrl"), value: status()?.baseUrl ?? t("common.na") };
        case "mode":
          return { label: t("common.mode"), value: status()?.mode ?? t("common.na") };
      }
      throw new Error("Unknown bundled channel detail fact");
    }),
  );
  const statusRows = createMemo(() => [
    booleanChannelFact("configured", configured()),
    booleanChannelFact(
      "running",
      !presentation()
        ? displayState().running
        : presentation()?.runningWhenStatusMissing === "unknown" && !status()
          ? null
          : (status()?.running ?? false),
    ),
    ...(presentation()
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
      asNullableRecord(presentation() ? status() : displayState().status),
      "lastError",
    ),
  );

  return (
    <SettingsSection
      title={
        presentation()
          ? t(presentation()!.titleKey)
          : (readStringField(
              params.props.channels.channelsSnapshot?.channelLabels,
              params.channelId,
            ) ?? params.channelId)
      }
      description={presentation() ? t(presentation()!.subtitleKey) : t("channels.generic.subtitle")}
      count={params.accountCount !== undefined ? params.accountCount : undefined}
    >
      {showAccounts() ? (
        <For each={accounts()} keyed={(account) => account.accountId}>
          {(account) => {
            const username = createMemo(() =>
              accountPresentation()?.titleSource === "botUsername"
                ? readStringField(
                    asNullableRecord(asNullableRecord(account().probe)?.bot),
                    "username",
                  )
                : undefined,
            );
            return (
              <ChannelAccount
                title={username() ? `@${username()}` : account().name || account().accountId}
                accountId={account().accountId}
                facts={
                  accountPresentation()?.showConfigured
                    ? [
                        `${t("common.configured")}: ${account().configured ? t("common.yes") : t("common.no")}`,
                      ]
                    : undefined
                }
                status={{
                  kind: boolStatusKind(
                    accountPresentation()?.status === "running"
                      ? account().running
                      : (account().running ?? account().configured),
                  ),
                  label: account().running
                    ? t("common.running")
                    : accountPresentation()?.status !== "running" && account().configured
                      ? t("common.configured")
                      : t("common.no"),
                }}
                lastInboundAt={account().lastInboundAt}
                lastError={account().lastError}
              />
            );
          }}
        </For>
      ) : (
        <ChannelFacts rows={statusRows()} />
      )}
      {lastError() ? <ChannelError message={lastError()} /> : undefined}
      {presentation() ? (
        <Show when={status()?.probe}>{(probe) => <ChannelProbe probe={probe()} />}</Show>
      ) : undefined}
      <ChannelConfig channelId={params.channelId} props={params.props} />
      {presentation() ? (
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
    <openclaw-modal-dialog
      label={params.label}
      style={{ "--openclaw-modal-width": "680px" }}
      onModal-cancel={() => params.onClose()}
    >
      <div class="channels-detail">
        <div class="channels-detail__header">
          <ChannelIcon
            channelId={params.channelId}
            label={params.label}
            variant="cover"
            pluginIconUrl={params.pluginIconUrl}
          />
          <div class="channels-detail__header-actions">
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
          {params.props.wizardHost.blockedByDirtyConfig() && params.props.config.configFormDirty ? (
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

        <openclaw-modal-actions class="channels-detail__footer">
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
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
