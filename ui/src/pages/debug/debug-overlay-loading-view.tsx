import { For, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import {
  DEBUG_OVERLAY_SECTION_HEADERS,
  type DebugOverlaySectionId,
} from "./debug-overlay-loading.ts";

export function DebugOverlaySectionLoading(props: { id: DebugOverlaySectionId }) {
  return (
    <div
      class={`debug-overlay__placeholder debug-overlay__placeholder--${props.id}`}
      role="status"
      aria-label={t("common.loading")}
    >
      <div class="debug-overlay__placeholder-content" aria-hidden="true">
        <Show
          when={props.id === "status"}
          fallback={
            <Show
              when={props.id === "lanes"}
              fallback={
                <div class="debug-overlay__placeholder-rows">
                  <For each={Array.from({ length: props.id === "events" ? 3 : 2 })}>
                    {() => <div class="skeleton debug-overlay__placeholder-line" />}
                  </For>
                </div>
              }
            >
              <div class="debug-overlay__placeholder-lanes">
                <For each={["lane", "active", "queued", "blocked"]}>
                  {(column) => <span>{t(`debug.lanes.${column}`)}</span>}
                </For>
                <For each={Array.from({ length: 12 })}>
                  {() => <div class="skeleton debug-overlay__placeholder-line" />}
                </For>
              </div>
            </Show>
          }
        >
          <div class="debug-overlay__placeholder-vitals">
            <For each={["cpu", "memory", "delayP99"]}>
              {(metric) => (
                <div class="debug-overlay__placeholder-vital">
                  <span>{t(`debug.overlay.${metric}`)}</span>
                  <div class="skeleton debug-overlay__placeholder-value" />
                  <div class="skeleton debug-overlay__placeholder-line" />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
export function DebugOverlayLoading() {
  return (
    <For each={Object.values(DEBUG_OVERLAY_SECTION_HEADERS)}>
      {(section) => (
        <section class="debug-overlay__section" aria-busy="true">
          <h3>{t(section.titleKey)}</h3>
          <DebugOverlaySectionLoading id={section.id} />
        </section>
      )}
    </For>
  );
}
