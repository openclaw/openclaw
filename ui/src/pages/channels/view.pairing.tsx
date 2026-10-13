import { createMemo, For, Show } from "solid-js";
// DM sender access request queue shared by the Channels hub and detail panels.
import type { ChannelsPairingAccount, ChannelsPairingRequest } from "../../api/types.ts";
import { renderChannelPicker } from "../../components/channel-picker.ts";
import { renderPicker } from "../../components/select-picker.ts";
import "../../components/modal-dialog.ts";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
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
        <LitContent
          render={() =>
            renderChannelPicker({
              label: t("channels.pairing.channelFilter"),
              value: props.pairingChannelFilter ?? "",
              options: [
                { value: "", label: t("channels.pairing.allChannels"), kind: "neutral" },
                ...channels().map(([value, label]) => ({ value, label })),
              ],
              onChange: (value) => props.onPairingFilterChange(value || null, null),
            })
          }
        />
      </label>
      <label>
        <span>{t("channels.pairing.accountFilter")}</span>
        <LitContent
          render={() =>
            renderPicker({
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
            })
          }
        />
      </label>
    </div>
  );
}

function renderRequest(request: ChannelsPairingRequest, props: ChannelsProps) {
  const metadata = Object.entries(request.metadata ?? {});
  return (
    <div class="settings-row settings-row--stacked channels-pairing-request">
      <div class="channels-pairing-request__main">
        <div class="settings-row__text">
          <span class="settings-row__title">{request.senderId}</span>
          <span class="settings-row__desc">
            {request.senderLabel} · {request.channelLabel} · {accountName(request)} (
            {request.accountId})
          </span>
          <span class="settings-row__desc">
            {t("channels.pairing.requested", { ago: formatRequestTime(request.createdAt) })} ·
            {t("channels.pairing.expires", { ago: formatRequestTime(request.expiresAt) })}
          </span>
        </div>
        <div class="settings-row__control channels-pairing-request__actions">
          <For each={["approve", "dismiss"] as const}>
            {(action) => (
              <button
                type="button"
                class={action === "approve" ? "btn btn--sm primary" : "btn btn--sm"}
                disabled={Boolean(props.channels.pairingBusyRequestId) || !props.canManagePairing}
                aria-label={t(`channels.pairing.${action}Aria`, {
                  sender: request.senderId,
                  channel: request.channelLabel,
                  account: accountName(request),
                })}
                onClick={() =>
                  (action === "approve" ? props.onPairingApprove : props.onPairingDismiss)(request)
                }
              >
                {t(
                  action === "approve" && props.channels.pairingBusyRequestId === request.requestId
                    ? "common.loading"
                    : `channels.pairing.${action}`,
                )}
              </button>
            )}
          </For>
        </div>
      </div>
      {metadata.length > 0 ? (
        <details class="channels-pairing-request__details">
          <summary>{t("channels.pairing.senderDetails")}</summary>
          <dl class="settings-kv">
            <For each={metadata}>
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
    <div id="channels-pairing-requests">
      <SettingsSection
        title={t("channels.pairing.title")}
        description={t("channels.pairing.subtitle")}
        count={snapshot()?.requests.length || undefined}
        actions={
          <ChannelRefresh
            updatedAt={props.canManagePairing ? props.channels.pairingLastSuccess : null}
            disabled={props.channels.pairingLoading || !props.canManagePairing}
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
            <For
              each={
                [
                  [props.channels.pairingError, "alert", "danger"],
                  [props.pairingNotice, "status", "ok"],
                ] as const
              }
            >
              {([label, role, kind]) =>
                label ? (
                  <div class="settings-row channels-pairing-feedback" role={role}>
                    <SettingsStatus kind={kind} label={label} />
                  </div>
                ) : undefined
              }
            </For>
            {snapshot() ? renderFilters(props) : undefined}
            {props.channels.pairingLoading && !snapshot() ? (
              <SettingsLoadingSkeleton rows={2} />
            ) : (snapshot()?.accounts.length ?? 0) === 0 ? (
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
              requests().map((request) => renderRequest(request, props))
            )}
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
              <div class="settings-row">
                <div class="settings-row__text">
                  <span class="settings-row__title">{accountName(account())}</span>
                  <span class="settings-row__desc">{account().accountId}</span>
                </div>
                <div class="settings-row__control">
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
                </div>
              </div>
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
  const request = createMemo(() => params.prompt.request);
  const busy = createMemo(() => params.props.channels.pairingBusyRequestId === request().requestId);
  const approving = createMemo(() => params.prompt.kind === "approve");
  const ownerMissing = createMemo(
    () => params.props.channels.pairingSnapshot?.commandOwnerConfigured === false,
  );
  const dialogTitle = createMemo(() => t(`channels.pairing.${params.prompt.kind}DialogTitle`));
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
        <div class="channels-pairing-dialog__actions">
          <button
            type="button"
            class={approving() ? "btn primary" : "btn danger"}
            disabled={busy()}
            onClick={() => params.props.onPairingPromptConfirm()}
          >
            {t(`channels.pairing.${params.prompt.kind}`)}
          </button>
          <button
            type="button"
            class="btn"
            disabled={busy()}
            onClick={() => params.props.onPairingPromptCancel()}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}
