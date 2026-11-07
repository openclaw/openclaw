import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { ChannelIcon } from "../../components/solid/channel-icon.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { channelSnapshotEntryIsActive, resolveChannelAccounts } from "../../lib/channels/index.ts";
import "../../components/modal-dialog.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ChannelSettingsSlot } from "./channel-settings-presentation.tsx";
import { channelDetailPresentations } from "./detail-presentation.ts";
import { channelDocsUrl } from "./hub-meta.ts";
import {
  ChannelConfig,
  ChannelConfigActions,
  ChannelConfigFeedback,
  ChannelConfigStatus,
} from "./view.config.tsx";
import { renderChannelPairingDetail } from "./view.pairing.tsx";
import {
  booleanChannelFact,
  ChannelAccount,
  ChannelFacts,
  ChannelHealthStatus,
  channelLastActivity,
  channelProbe,
  resolveChannelDisplayState,
  resolveChannelHealth,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

type ChannelDetailParams = { channelId: string; props: ChannelsProps };

/** The one line that answers "does it work", with the same words as the channel's list row. */
function ChannelDetailStatus(params: ChannelDetailParams) {
  const health = createMemo(() => resolveChannelHealth(params.channelId, params.props));
  const fact = createMemo(() => {
    if (health() === "attention" || health() === "notConfigured") {
      return null;
    }
    return channelProbe(params.channelId, params.props)?.ok === true
      ? t("common.probeOk")
      : channelLastActivity(params.channelId, params.props);
  });
  return (
    <div class="oc-dialog__description channels-detail__status">
      <span class="channels-detail__state">
        <ChannelHealthStatus health={health()} />
        <Show when={fact()}>{(text) => <span>{text()}</span>}</Show>
      </span>
      <Show
        when={
          channelDetailPresentations.has(params.channelId) ||
          channelSnapshotEntryIsActive(params.props.channels.channelsSnapshot, params.channelId)
        }
      >
        <button
          type="button"
          class="btn btn--sm channels-detail__check"
          disabled={params.props.channels.channelsLoading}
          aria-busy={params.props.channels.channelsLoading ? "true" : "false"}
          onClick={() => params.props.onRefresh(true)}
        >
          {t(params.props.channels.channelsLoading ? "common.refreshing" : "common.probe")}
        </button>
      </Show>
    </div>
  );
}

function channelIssues(params: ChannelDetailParams) {
  return (
    params.props.channels.channelsSnapshot?.statusIssues?.filter(
      (issue) => issue.channel === params.channelId,
    ) ?? []
  );
}

function channelLastError(params: ChannelDetailParams) {
  return readStringField(
    asNullableRecord(resolveChannelDisplayState(params.channelId, params.props).status),
    "lastError",
  );
}

function failedProbeDetail(params: ChannelDetailParams) {
  const probe = channelProbe(params.channelId, params.props);
  return probe?.ok === false
    ? formatUiExternalText([probe.status ?? "", probe.error ?? ""].filter(Boolean).join(" "))
    : null;
}

/**
 * Why it needs attention, once. An issue already says what to do, so the raw error
 * and the failed check behind it wait in Details.
 */
function ChannelProblem(params: ChannelDetailParams) {
  const owned = () => params.props.presentation.details.has(params.channelId);
  const issues = createMemo(() => channelIssues(params));
  const severalAccounts = () =>
    resolveChannelAccounts(
      params.props.channels.channelsSnapshot?.channelAccounts,
      params.channelId,
    ).length > 1;
  const fallback = createMemo(() => {
    const readError = params.props.channels.channelsError;
    if (readError) {
      return { message: formatUiError(readError) };
    }
    if (owned() || issues().length > 0) {
      return null;
    }
    const lastError = channelLastError(params);
    if (lastError) {
      return { message: formatUiError(lastError) };
    }
    const detail = failedProbeDetail(params);
    return detail === null ? null : { title: t("common.probeFailed"), message: detail };
  });
  return (
    <Show
      when={issues().length > 0}
      fallback={
        <Show when={fallback()}>
          {(problem) => (
            <InlineAlert tone="danger" role="alert">
              <Show when={problem().title}>
                <strong>{problem().title}</strong>
              </Show>
              <Show when={problem().message}>
                <div>{problem().message}</div>
              </Show>
            </InlineAlert>
          )}
        </Show>
      }
    >
      <InlineAlert tone="danger" role="note">
        <For each={issues()}>
          {(issue) => (
            <div class="channels-detail__issue">
              <Show when={severalAccounts()}>
                <strong>{formatUiExternalText(issue.accountId)}</strong>
              </Show>
              <div>{formatUiExternalText(issue.message)}</div>
              {issue.fix ? <div>{formatUiExternalText(issue.fix)}</div> : undefined}
            </div>
          )}
        </For>
      </InlineAlert>
    </Show>
  );
}

function ChannelAccounts(params: ChannelDetailParams) {
  const presentation = () => channelDetailPresentations.get(params.channelId);
  const accounts = createMemo(() =>
    resolveChannelAccounts(
      params.props.channels.channelsSnapshot?.channelAccounts,
      params.channelId,
    ),
  );
  const shown = () => {
    const policy = presentation()?.accounts;
    return presentation()
      ? Boolean(policy && accounts().length >= policy.minimumCount)
      : accounts().length > 0;
  };
  return (
    <Show when={shown()}>
      <div class="settings-group">
        <For each={accounts()} keyed={(account) => account.accountId}>
          {(account) => {
            const username = () =>
              presentation()?.accounts?.titleSource === "botUsername"
                ? readStringField(
                    asNullableRecord(asNullableRecord(account().probe)?.bot),
                    "username",
                  )
                : undefined;
            return (
              <ChannelAccount
                title={username() ? `@${username()}` : account().name || account().accountId}
                account={account()}
              />
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** Facts for when something's off; a fact without a value isn't one. */
function ChannelDetailFacts(params: ChannelDetailParams) {
  const display = createMemo(() => resolveChannelDisplayState(params.channelId, params.props));
  const rows = createMemo(() => {
    const status = display().status;
    const text = (field: string) => readStringField(status, field);
    const time = (field: string) => {
      const value = status?.[field];
      return typeof value === "number" && value > 0 ? formatRelativeTimestamp(value) : undefined;
    };
    const audience = text("audienceType");
    const presentation = channelDetailPresentations.get(params.channelId);
    const extras = (presentation?.extraFacts ?? []).map((fact) => {
      switch (fact) {
        case "credential":
          return { label: t("common.credential"), value: text("credentialSource") };
        case "audience":
          return {
            label: t("common.audience"),
            value: audience
              ? `${audience}${text("audience") ? ` · ${text("audience")}` : ""}`
              : undefined,
          };
        case "baseUrl":
          return { label: t("common.baseUrl"), value: text("baseUrl") };
        case "mode":
          return { label: t("common.mode"), value: text("mode") };
      }
      throw new Error("Unknown bundled channel detail fact");
    });
    // Shown above when nothing better explains the failure; kept here when something does.
    const hasIssue = channelIssues(params).length > 0;
    const lastError = channelLastError(params);
    const failedProbe = failedProbeDetail(params);
    return [
      ...extras,
      { label: t("common.lastStart"), value: time("lastStartAt") },
      { label: t("common.lastProbe"), value: time("lastProbeAt") },
      {
        label: t("common.probeFailed"),
        value: hasIssue || lastError ? (failedProbe ?? undefined) : undefined,
      },
      {
        label: t("channels.lastError"),
        value: hasIssue && lastError ? formatUiError(lastError) : undefined,
      },
    ].filter((row): row is { label: string; value: string } => Boolean(row.value));
  });
  const connected = () => {
    const value = display().connected;
    return value !== null && !channelDetailPresentations.has(params.channelId)
      ? [booleanChannelFact("connected", value)]
      : [];
  };
  return (
    <Show when={rows().length + connected().length > 0}>
      <SettingsDisclosure title={t("channels.hub.details")}>
        <ChannelFacts rows={[...connected(), ...rows()]} />
      </SettingsDisclosure>
    </Show>
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
  const owned = () => params.props.presentation.details.has(params.channelId);
  return (
    <openclaw-modal-dialog
      label={params.label}
      style={{ "--openclaw-modal-width": "640px" }}
      onModal-cancel={(event: Event) => {
        // The selected channel owns this dialog; closing may still ask about unsaved edits.
        event.preventDefault();
        params.onClose();
      }}
    >
      <div class="oc-dialog channels-detail">
        <div class="oc-dialog__header">
          <h2 class="oc-dialog__title">
            <ChannelIcon
              channelId={params.channelId}
              label={params.label}
              variant="picker"
              pluginIconUrl={params.pluginIconUrl}
            />
            {params.label}
          </h2>
          <IconButton
            size={28}
            class="oc-dialog__close"
            icon="x"
            label={t("common.close")}
            tooltip={false}
            onClick={() => params.onClose()}
          />
          <ChannelDetailStatus channelId={params.channelId} props={params.props} />
        </div>
        <div class="oc-dialog__body channels-detail__body">
          <ChannelProblem channelId={params.channelId} props={params.props} />
          {owned() ? (
            <ChannelSettingsSlot
              channelId={params.channelId}
              presentation={params.props.presentation.details}
            />
          ) : (
            <>
              <ChannelAccounts channelId={params.channelId} props={params.props} />
              <ChannelConfig channelId={params.channelId} props={params.props} />
            </>
          )}
          {renderChannelPairingDetail(params.channelId, params.props)}
          <Show when={!owned()}>
            <ChannelDetailFacts channelId={params.channelId} props={params.props} />
          </Show>
        </div>
        <ChannelConfigFeedback channelId={params.channelId} props={params.props} />
        <openclaw-modal-actions class="channels-detail__footer">
          <ChannelConfigStatus channelId={params.channelId} props={params.props} />
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
            disabled={!params.props.canAdmin || !params.props.channels.connected}
            onClick={() => params.onSetup()}
          >
            {t("channels.hub.runSetup")}
          </button>
          <ChannelConfigActions channelId={params.channelId} props={params.props} />
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
