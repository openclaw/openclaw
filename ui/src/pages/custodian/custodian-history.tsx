import type { SystemChangeEntry } from "@openclaw/gateway-protocol";
import { For, Show } from "solid-js";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
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

export function CustodianChangeHistory(props: {
  entries: SystemChangeEntry[];
  error: string | null;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoad: (reset: boolean) => void;
}) {
  return (
    <section class="custodian__history" aria-label={t("custodian.history.title")}>
      <div class="custodian__history-heading">
        <strong>{t("custodian.history.title")}</strong>
        <span>{t("custodian.history.description")}</span>
      </div>
      <Show when={props.error}>
        <div class="custodian__history-error" role="alert">
          <span>{props.error}</span>
          <button class="btn btn--sm" type="button" onClick={() => props.onLoad(true)}>
            {t("common.retry")}
          </button>
        </div>
      </Show>
      <Show
        when={props.loading && props.entries.length === 0}
        fallback={
          <div class="custodian__change-list">
            <For each={props.entries}>{(entry) => <HistoryCard entry={entry} />}</For>
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
        }
      >
        <SettingsLoadingSkeleton label={t("custodian.history.loading")} />
      </Show>
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
    </section>
  );
}
