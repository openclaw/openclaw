import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
// DM sender access request queue shared by the Channels hub and detail panels.
import type { ChannelsPairingAccount, ChannelsPairingRequest } from "../../api/types.ts";
import { Picker } from "../../components/select-picker.ts";
import "../../components/modal-dialog.tsx";
import { ChannelPicker } from "../../components/solid/channel-picker.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import type { ChannelRead, ChannelsState } from "../../lib/channels/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ChannelRefresh } from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

function accountName(account: Pick<ChannelsPairingAccount, "accountLabel" | "accountId">): string {
  return account.accountLabel || account.accountId;
}

function formatRequestTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatRelativeTimestamp(time) : value;
}

function renderFilters(props: ChannelsProps) {
  const accounts = createMemo(() => props.channels.pairingSnapshot?.accounts ?? []);
  const channels = createMemo(() =>
    Array.from(
      new Map(accounts().map((account) => [account.channel, account.channelLabel])).entries(),
    ).toSorted((left, right) => left[1].localeCompare(right[1])),
  );
  const accountsForChannel = createMemo(() =>
    props.pairingChannelFilter
      ? accounts().filter((account) => account.channel === props.pairingChannelFilter)
      : accounts(),
  );
  return (
    <div class="channels-pairing-filters">
      <label>
        <span>{t("channels.pairing.channelFilter")}</span>
        <ChannelPicker
          label={t("channels.pairing.channelFilter")}
          value={props.pairingChannelFilter ?? ""}
          options={[
            { value: "", label: t("channels.pairing.allChannels"), kind: "neutral" },
            ...channels().map(([value, label]) => ({ value, label })),
          ]}
          onChange={(value) => props.onPairingFilterChange(value || null, null)}
        />
      </label>
      <label>
        <span>{t("channels.pairing.accountFilter")}</span>
        <Picker
          params={{
            label: t("channels.pairing.accountFilter"),
            value: props.pairingAccountFilter ?? "",
            options: [
              { value: "", label: t("channels.pairing.allAccounts") },
              ...accountsForChannel().map((account) => ({
                value: account.accountId,
                label: accountName(account),
              })),
            ],
            disabled: !props.pairingChannelFilter,
            onChange: (value) =>
              props.onPairingFilterChange(props.pairingChannelFilter, value || null),
          }}
        />
      </label>
    </div>
  );
}

function PairingRequest(props: ChannelsProps & { request: ChannelsPairingRequest }) {
  const request = () => props.request;
  const metadata = createMemo(() => Object.entries(request().metadata ?? {}));
  return (
    <div class="settings-row settings-row--stacked channels-pairing-request">
      <div class="channels-pairing-request__main">
        <div class="settings-row__text">
          <span class="settings-row__title">{request().senderId}</span>
          <span class="settings-row__desc">
            {request().senderLabel} · {request().channelLabel} · {accountName(request())} (
            {request().accountId})
          </span>
          <span class="settings-row__desc">
            {t("channels.pairing.requested", { ago: formatRequestTime(request().createdAt) })} ·
            {t("channels.pairing.expires", { ago: formatRequestTime(request().expiresAt) })}
          </span>
        </div>
        <div class="settings-row__control channels-pairing-request__actions">
          <For each={["approve", "dismiss"] as const}>
            {(action) => (
              <button
                type="button"
                class={["btn btn--sm", { primary: action === "approve" }]}
                disabled={
                  !props.channels.connected ||
                  Boolean(props.channels.pairingBusyRequestId) ||
                  !props.canManagePairing
                }
                aria-label={t(`channels.pairing.${action}Aria`, {
                  sender: request().senderId,
                  channel: request().channelLabel,
                  account: accountName(request()),
                })}
                onClick={() =>
                  (action === "approve" ? props.onPairingApprove : props.onPairingDismiss)(
                    request(),
                  )
                }
              >
                {t(
                  action === "approve" &&
                    props.channels.pairingBusyRequestId === request().requestId
                    ? "common.loading"
                    : `channels.pairing.${action}`,
                )}
              </button>
            )}
          </For>
        </div>
      </div>
      {metadata().length > 0 ? (
        <details class="channels-pairing-request__details">
          <summary>{t("channels.pairing.senderDetails")}</summary>
          <dl class="settings-kv">
            <For each={metadata()}>
              {(entry) => (
                <>
                  <dt>{entry[0]}</dt>
                  <dd>{entry[1]}</dd>
                </>
              )}
            </For>
          </dl>
        </details>
      ) : undefined}
    </div>
  );
}

function PairingReadSettled(props: { receipt: ChannelRead; children: JSX.Element }) {
  const ready = createMemo(async () => {
    const error = await props.receipt.completion;
    if (error !== null) {
      throw new Error(error);
    }
    return true;
  });
  return <Show when={ready()}>{props.children}</Show>;
}

function PairingReadFeedback(props: { channels: ChannelsState; prompt?: boolean }) {
  const empty = () => !props.prompt && !props.channels.pairingSnapshot;
  const emptyMessage = () => <SettingsEmpty message={t("channels.pairing.noAccounts")} />;
  return (
    // Only stateless feedback is replaced; filters, request rows and dialogs keep their owners.
    <Show
      when={props.channels.pairingRead}
      keyed
      fallback={<Show when={empty()}>{emptyMessage()}</Show>}
    >
      {(receipt) => (
        <Errored
          fallback={(error) => (
            <>
              {props.prompt ? (
                <div class="callout danger" role="alert">
                  {formatUiError(error())}
                </div>
              ) : (
                <div class="settings-row channels-pairing-feedback" role="alert">
                  <SettingsStatus kind="danger" label={formatUiError(error())} />
                </div>
              )}
              <Show when={empty()}>{emptyMessage()}</Show>
            </>
          )}
        >
          <Loading
            fallback={
              <Show when={empty()}>
                <SettingsLoadingSkeleton rows={2} />
              </Show>
            }
          >
            <PairingReadSettled receipt={receipt}>
              <Show when={empty()}>{emptyMessage()}</Show>
            </PairingReadSettled>
          </Loading>
        </Errored>
      )}
    </Show>
  );
}

export function renderChannelPairingQueue(props: ChannelsProps) {
  const snapshot = createMemo(() =>
    props.canManagePairing ? props.channels.pairingSnapshot : null,
  );
  const requests = createMemo(() =>
    (snapshot()?.requests ?? []).filter(
      (request) =>
        (!props.pairingChannelFilter || request.channel === props.pairingChannelFilter) &&
        (!props.pairingAccountFilter || request.accountId === props.pairingAccountFilter),
    ),
  );
  return (
    <div id="channels-pairing-requests" ref={(element) => props.onPairingRoot(element)}>
      <SettingsSection
        title={t("channels.pairing.title")}
        description={t("channels.pairing.subtitle")}
        count={snapshot()?.requests.length || undefined}
        actions={
          <ChannelRefresh
            updatedAt={props.canManagePairing ? props.channels.pairingLastSuccess : null}
            disabled={
              !props.channels.connected || props.channels.pairingLoading || !props.canManagePairing
            }
            onRefresh={props.onPairingRefresh}
          />
        }
      >
        {!props.canManagePairing ? (
          <div class="settings-row channels-pairing-feedback">
            <SettingsStatus kind={"warn"} label={t("channels.pairing.missingPermission")} />
          </div>
        ) : (
          <>
            <Show when={props.channels.pairingError}>
              {(label) => (
                <div class="settings-row channels-pairing-feedback" role="alert">
                  <SettingsStatus kind="danger" label={label()} />
                </div>
              )}
            </Show>
            <PairingReadFeedback channels={props.channels} />
            <Show when={props.pairingNotice}>
              {(label) => (
                <div class="settings-row channels-pairing-feedback" role="status">
                  <SettingsStatus kind="ok" label={label()} />
                </div>
              )}
            </Show>
            {snapshot() ? renderFilters(props) : undefined}
            <Show when={snapshot()}>
              {(snapshot()?.accounts.length ?? 0) === 0 ? (
                <SettingsEmpty message={t("channels.pairing.noAccounts")} />
              ) : requests().length === 0 ? (
                <SettingsEmpty
                  message={
                    props.pairingChannelFilter || props.pairingAccountFilter
                      ? t("channels.pairing.noFilteredRequests")
                      : t("channels.pairing.noRequests")
                  }
                />
              ) : (
                <For each={requests()} keyed={(request) => request.requestId}>
                  {(request) => <PairingRequest {...props} request={request()} />}
                </For>
              )}
            </Show>
            <Show when={snapshot()}>
              {(current) => (
                <div class="channels-pairing-help">
                  {t("channels.pairing.limits", {
                    count: String(current().limits.pendingPerAccount),
                    minutes: String(Math.round(current().limits.ttlMs / 60_000)),
                  })}
                </div>
              )}
            </Show>
          </>
        )}
      </SettingsSection>
    </div>
  );
}

export function renderChannelPairingDetail(channelId: string, props: ChannelsProps) {
  const accounts = createMemo(() =>
    (props.channels.pairingSnapshot?.accounts ?? []).filter(
      (account) => account.channel === channelId,
    ),
  );
  const requests = createMemo(() => props.channels.pairingSnapshot?.requests ?? []);
  return (
    <Show when={props.canManagePairing && accounts().length > 0}>
      <SettingsSection
        title={t("channels.pairing.detailTitle")}
        description={t("channels.pairing.detailSubtitle")}
      >
        <For each={accounts()} keyed={(account) => account.accountId}>
          {(account) => {
            const pending = createMemo(
              () =>
                requests().filter(
                  (request) =>
                    request.channel === account().channel &&
                    request.accountId === account().accountId,
                ).length,
            );
            return (
              <SettingsRow
                title={accountName(account())}
                description={account().accountId}
                control={
                  <>
                    <SettingsStatus
                      kind={pending() > 0 ? "warn" : "muted"}
                      label={
                        pending() > 0
                          ? t("channels.pairing.pendingCount", { count: String(pending()) })
                          : t("channels.pairing.noPending")
                      }
                    />
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() =>
                        props.onPairingReviewAccount(account().channel, account().accountId)
                      }
                    >
                      {t("channels.pairing.review")}
                    </button>
                  </>
                }
              />
            );
          }}
        </For>
      </SettingsSection>
    </Show>
  );
}

export function renderChannelPairingPrompt(props: ChannelsProps) {
  return (
    <Show when={props.canManagePairing && props.pairingPrompt}>
      {(prompt) => <PairingPromptContent prompt={prompt()} props={props} />}
    </Show>
  );
}

function PairingPromptContent(params: {
  prompt: NonNullable<ChannelsProps["pairingPrompt"]>;
  props: ChannelsProps;
}) {
  const request = () => params.prompt.request;
  const busy = () =>
    params.props.mutationBusy?.pairing ||
    params.props.channels.pairingBusyRequestId === request().requestId;
  const approving = () => params.prompt.kind === "approve";
  const ownerMissing = () =>
    params.props.channels.pairingSnapshot?.commandOwnerConfigured === false;
  const dialogTitle = () => t(`channels.pairing.${params.prompt.kind}DialogTitle`);
  const option = (field: "notify" | "bootstrapCommandOwner", label: string) => (
    <label class="channels-pairing-dialog__option">
      <input
        type="checkbox"
        checked={params.prompt[field]}
        onChange={(event) =>
          params.props.onPairingPromptChange({ [field]: event.currentTarget.checked })
        }
      />
      <span>{label}</span>
    </label>
  );
  return (
    <openclaw-modal-dialog
      label={dialogTitle()}
      onModal-cancel={() => params.props.onPairingPromptCancel()}
    >
      <div class="channels-pairing-dialog">
        <div class="settings-row__title">{dialogTitle()}</div>
        <div class="settings-row__desc">
          {request().senderId} · {request().channelLabel} · {accountName(request())} (
          {request().accountId})
        </div>
        <div class={["callout", { info: approving(), warn: !approving() }]}>
          {t(`channels.pairing.${params.prompt.kind}Explanation`)}
        </div>
        {params.props.channels.pairingError ? (
          <div class="callout danger" role="alert">
            {params.props.channels.pairingError}
          </div>
        ) : undefined}
        <PairingReadFeedback channels={params.props.channels} prompt />
        {approving() && request().notifySupported
          ? option("notify", t("channels.pairing.notifyRequester"))
          : undefined}
        {approving() && ownerMissing() && params.props.canAdmin ? (
          <>
            {option("bootstrapCommandOwner", t("channels.pairing.makeCommandOwner"))}
            <div class="settings-row__desc">{t("channels.pairing.commandOwnerHelp")}</div>
          </>
        ) : undefined}
        {approving() && ownerMissing() && !params.props.canAdmin ? (
          <div class="callout warn">{t("channels.pairing.commandOwnerNeedsAdmin")}</div>
        ) : undefined}
        <openclaw-modal-actions class="channels-pairing-dialog__actions">
          <button
            type="button"
            class="btn"
            disabled={busy()}
            onClick={() => params.props.onPairingPromptCancel()}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class={["btn", approving() ? "primary" : "danger"]}
            disabled={!params.props.channels.connected || busy()}
            onClick={() => params.props.onPairingPromptConfirm()}
          >
            {t(`channels.pairing.${params.prompt.kind}`)}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
