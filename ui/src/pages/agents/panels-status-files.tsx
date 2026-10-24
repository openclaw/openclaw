import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, isPending, Loading, Show } from "solid-js";
import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "../../api/types.ts";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import type { AgentContext } from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import {
  resolveChannelExtras as resolveChannelExtrasFromConfig,
  type ChannelRead,
} from "../../lib/channels/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentPanelAction } from "./panel-ui.tsx";
import { renderAgentContextSection } from "./panels-overview.tsx";

registerEnglishCatalog(registerSettingsEnglish);

function resolveChannelEntries(snapshot: ChannelsStatusSnapshot | null) {
  if (!snapshot) {
    return [];
  }
  const ids = new Set([
    ...(snapshot.channelOrder ?? []),
    ...(snapshot.channelMeta ?? []).map((entry) => entry.id),
    ...Object.keys(snapshot.channelAccounts ?? {}),
  ]);
  return Array.from(ids, (id) => ({
    id,
    label:
      snapshot.channelMeta?.find((entry) => entry.id === id)?.label ||
      (snapshot.channelLabels?.[id] ?? id),
    accounts: snapshot.channelAccounts?.[id] ?? [],
  }));
}

const CHANNEL_EXTRA_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function summarizeChannelAccounts(accounts: ChannelAccountSnapshot[]) {
  let connected = 0;
  let configured = 0;
  let enabled = 0;
  for (const account of accounts) {
    const probeOk =
      account.probe && typeof account.probe === "object" && "ok" in account.probe
        ? Boolean(account.probe.ok)
        : false;
    const hasRuntimeStatus =
      typeof account.connected === "boolean" || typeof account.running === "boolean";
    // A successful probe proves API reachability, not a live transport. Preserve it only
    // as a fallback for passive channels that do not publish runtime status.
    const isConnected =
      account.connected === true || account.running === true || (!hasRuntimeStatus && probeOk);
    if (isConnected) {
      connected += 1;
    }
    if (account.configured) {
      configured += 1;
    }
    if (account.enabled) {
      enabled += 1;
    }
  }
  return {
    total: accounts.length,
    connected,
    configured,
    enabled,
  };
}

function ChannelReadBoundary(props: {
  read: ChannelRead | null;
  retainedError: string | null;
  children: (pending: boolean, error: string | null) => JSX.Element;
}) {
  return (
    <Show when={props.read} keyed fallback={props.children(false, props.retainedError)}>
      {(receipt) => {
        const complete = createMemo(async () => {
          const error = await receipt.completion;
          if (error) {
            throw new Error(error);
          }
          return null;
        });
        return (
          <Errored fallback={(error) => props.children(false, formatUiError(error()))}>
            <Loading fallback={props.children(true, props.retainedError)}>
              {props.children(
                isPending(() => complete()),
                complete(),
              )}
            </Loading>
          </Errored>
        );
      }}
    </Show>
  );
}

export function AgentChannels(
  params: AgentsPageView["channels"] & {
    context: AgentContext;
    configForm: Record<string, unknown> | null;
    readState: AgentsPageView["readChannels"];
    onSelectPanel: (panel: AgentsPanel) => void;
  },
) {
  const entries = createMemo(() => resolveChannelEntries(params.readState().channelsSnapshot));
  const lastSuccessLabel = createMemo(() =>
    params.readState().channelsLastSuccess
      ? formatRelativeTimestamp(params.readState().channelsLastSuccess)
      : t("common.never"),
  );
  return (
    <>
      {renderAgentContextSection(
        params.context,
        t("agents.context.configurationSubtitle"),
        params.onSelectPanel,
      )}
      <ChannelReadBoundary
        read={params.readState().channelsRead}
        retainedError={params.readState().channelsError}
      >
        {(_pending, error) => (error ? <div class="callout danger">{error}</div> : undefined)}
      </ChannelReadBoundary>
      {!params.readState().channelsSnapshot ? (
        <div class="callout info">{t("agents.channels.loadHint")}</div>
      ) : undefined}
      <SettingsSection
        title={t("agents.channels.title")}
        description={
          <>
            {t("agents.channels.subtitle")}{" "}
            {t("agents.channels.lastRefresh", { time: lastSuccessLabel() })}
          </>
        }
        actions={
          <ChannelReadBoundary
            read={params.readState().channelsRead}
            retainedError={params.readState().channelsError}
          >
            {(pending) => (
              <AgentPanelAction
                label={pending ? t("common.refreshing") : t("common.refresh")}
                disabled={pending}
                onClick={params.onRefresh}
              />
            )}
          </ChannelReadBoundary>
        }
      >
        <For
          each={entries()}
          keyed={(entry) => entry.id}
          fallback={<SettingsEmpty message={t("agents.channels.empty")} />}
        >
          {(entry) => {
            const summary = createMemo(() => summarizeChannelAccounts(entry().accounts));
            const status = () =>
              summary().total
                ? t("agents.channels.connectedCount", {
                    connected: String(summary().connected),
                    total: String(summary().total),
                  })
                : t("agents.channels.noAccounts");
            const configLabel = () =>
              summary().configured
                ? t("agents.channels.configuredCount", { count: String(summary().configured) })
                : t("agents.channels.notConfigured");
            const enabled = () =>
              summary().total
                ? t("agents.channels.enabledCount", { count: String(summary().enabled) })
                : t("common.disabled");
            const extras = createMemo(() =>
              resolveChannelExtrasFromConfig({
                configForm: params.configForm,
                channelId: entry().id,
                fields: CHANNEL_EXTRA_FIELDS,
              }),
            );
            const metaParts = () => [
              entry().id,
              configLabel(),
              enabled(),
              ...extras().map((extra) => `${extra.label}: ${extra.value}`),
            ];
            return (
              <SettingsRow
                title={entry().label}
                description={metaParts().join(" · ")}
                control={
                  <>
                    {summary().configured === 0 ? (
                      <a
                        class="settings-row__value"
                        href="https://docs.openclaw.ai/channels"
                        target="_blank"
                        rel="noopener"
                      >
                        {t("agents.channels.setupGuide")}
                      </a>
                    ) : undefined}
                    <SettingsStatus
                      kind={summary().connected > 0 ? "ok" : summary().total ? "warn" : "muted"}
                      label={status()}
                    />
                  </>
                }
              />
            );
          }}
        </For>
      </SettingsSection>
    </>
  );
}
