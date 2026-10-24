import type { SystemChangeEntry } from "@openclaw/gateway-protocol";
import { createMemo, Errored, For, isPending, latest, Loading, Show } from "solid-js";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../styles/settings.css";

const CHANGE_SOURCE_LABELS = {
  "system-agent": "custodian.history.sources.systemAgent",
  doctor: "custodian.history.sources.doctor",
  "config-rpc": "custodian.history.sources.settings",
  external: "custodian.history.sources.manualEdit",
  cli: "custodian.history.sources.cli",
  "plugin-install": "custodian.history.sources.pluginInstall",
  unknown: "custodian.history.sources.unknown",
} satisfies Record<SystemChangeEntry["source"], string>;

function HistoryCard(props: { entry: SystemChangeEntry }) {
  return (
    <article class={["custodian__change-card", { "is-invalid": props.entry.invalid }]}>
      <div class="custodian__change-meta">
        <span class="custodian__change-source">{t(CHANGE_SOURCE_LABELS[props.entry.source])}</span>
        <time datetime={new Date(props.entry.at).toISOString()}>
          {formatRelativeTimestamp(props.entry.at)}
        </time>
      </div>
      <div class="custodian__change-summary">{props.entry.summary}</div>
      <Show when={props.entry.invalid}>
        <div class="custodian__change-warning">{t("custodian.history.invalidEdit")}</div>
      </Show>
      <Show when={props.entry.opaqueChange}>
        <div class="custodian__change-note">{t("custodian.history.opaqueChange")}</div>
      </Show>
      <Show when={props.entry.changedPaths?.length}>
        <details class="custodian__change-paths">
          <summary>
            {t("custodian.history.changedPaths", {
              count: String(props.entry.changedPaths?.length),
            })}
          </summary>
          <ul>
            <For each={props.entry.changedPaths}>
              {(path) => (
                <li>
                  <code>{path}</code>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </article>
  );
}

export type HistorySnapshot = {
  entries: SystemChangeEntry[];
  error: string | null;
  loaded: boolean;
  nextCursor: string | null;
};

function HistoryContent(
  props: HistorySnapshot & {
    loading: boolean;
    loadingMore: boolean;
    onLoad: (reset: boolean) => void;
  },
) {
  const emptyLoading = () => props.loading && props.entries.length === 0;
  return (
    <>
      <Show when={emptyLoading()}>
        <SettingsLoadingSkeleton label={t("custodian.history.loading")} />
      </Show>
      <div class="custodian__change-list" style={{ display: emptyLoading() ? "none" : undefined }}>
        <For each={props.entries} keyed={(entry) => entry.id}>
          {(entry) => <HistoryCard entry={entry()} />}
        </For>
        <Show
          when={props.loading}
          fallback={
            <Show when={props.loaded && props.entries.length === 0 && !props.error}>
              <div class="custodian__history-state" role="status">
                {t("custodian.history.empty")}
              </div>
            </Show>
          }
        >
          <div
            class="custodian__history-state"
            role="status"
            aria-label={t("custodian.history.loading")}
          >
            <span class="custodian__history-spinner" aria-hidden="true" />
          </div>
        </Show>
      </div>
      <Show when={props.nextCursor}>
        <button
          class="btn btn--ghost custodian__history-more"
          type="button"
          disabled={props.loadingMore}
          onClick={() => props.onLoad(false)}
        >
          {t(props.loadingMore ? "custodian.history.loadingMore" : "custodian.history.loadMore")}
        </button>
      </Show>
    </>
  );
}

export function CustodianChangeHistory(props: {
  request: { reset: boolean; result: Promise<HistorySnapshot> } | null;
  previous: HistorySnapshot;
  onLoad: (reset: boolean) => void;
}) {
  const read = createMemo(() => props.request?.result ?? Promise.resolve(props.previous));
  const readError = () => {
    const error = read().error;
    if (error) {
      throw new Error(error);
    }
    return null;
  };
  return (
    <section class="custodian__history" aria-label={t("custodian.history.title")}>
      <div class="custodian__history-heading">
        <strong>{t("custodian.history.title")}</strong>
        <span>{t("custodian.history.description")}</span>
      </div>
      {/* Failed reads replace feedback while expanded cards retain their DOM. */}
      <Show when={props.request} keyed>
        <Errored
          fallback={(error, reset) => (
            <div class="custodian__history-error" role="alert">
              <span>{formatUiError(error())}</span>
              <button
                class="btn btn--sm"
                type="button"
                onClick={() => {
                  props.onLoad(true);
                  reset();
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          )}
        >
          <Loading>{readError()}</Loading>
        </Errored>
      </Show>
      <Loading
        fallback={
          <HistoryContent
            {...props.previous}
            loading={props.request?.reset ?? true}
            loadingMore={props.request?.reset === false}
            onLoad={props.onLoad}
          />
        }
      >
        <HistoryContent
          {...latest(read)}
          loading={(props.request?.reset ?? true) && isPending(read)}
          loadingMore={props.request?.reset === false && isPending(read)}
          onLoad={props.onLoad}
        />
      </Loading>
    </section>
  );
}
