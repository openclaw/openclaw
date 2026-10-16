import { For, Show } from "solid-js";
import { registerDebugEnglish } from "../../i18n/locales/en-debug.ts";
import type { CommandLaneDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerDebugEnglish);

export function CommandLaneRows(
  props: Pick<CommandLaneDiagnostics, "lanes" | "dynamic"> & { compact?: boolean },
) {
  return (
    <>
      <For each={props.lanes} keyed={(lane) => lane.lane}>
        {(lane) => {
          const perSession = () => lane().concurrencyScope === "session";
          const saturated = () =>
            perSession()
              ? (lane().saturatedLaneCount ?? 0) > 0
              : lane().activeCount >= lane().maxConcurrent;
          return (
            <tr
              class={[
                "command-lane-row",
                {
                  "command-lane-row--saturated": saturated(),
                  "command-lane-row--queued": lane().queuedCount > 0,
                },
              ]}
            >
              <td class="mono command-lane-row__name" data-label={t("debug.lanes.lane")}>
                {lane().lane}{" "}
              </td>
              <td class="mono" data-label={t("debug.lanes.active")}>
                {perSession()
                  ? t("debug.lanes.activePerSession", {
                      active: String(lane().activeCount),
                      limit: String(lane().maxConcurrent),
                    })
                  : `${lane().activeCount}/${lane().maxConcurrent}`}{" "}
              </td>
              <td class="mono" data-label={t("debug.lanes.queued")}>
                {lane().queuedCount}{" "}
              </td>
              <Show when={!props.compact}>
                <td data-label={t("debug.lanes.group")}>
                  {lane().group
                    ? `${lane().group} · ${lane().groupActive ?? 0}/${lane().groupBudget ?? 0}`
                    : ""}{" "}
                </td>
              </Show>
              <td class="mono" data-label={t("debug.lanes.blocked")}>
                {lane().blockedBy ?? "—"}{" "}
              </td>
            </tr>
          );
        }}
      </For>
      <Show when={props.dynamic}>
        {(dynamic) => (
          <tr
            class={[
              "command-lane-row",
              "command-lane-row--dynamic",
              { "command-lane-row--queued": dynamic().queuedCount > 0 },
            ]}
          >
            <td class="mono command-lane-row__name" data-label={t("debug.lanes.lane")}>
              {t("debug.lanes.sessionLanes", { count: String(dynamic().laneCount) })}{" "}
            </td>
            <td class="mono" data-label={t("debug.lanes.active")}>
              {dynamic().activeCount}{" "}
            </td>
            <td class="mono" data-label={t("debug.lanes.queued")}>
              {dynamic().queuedCount}{" "}
            </td>
            <Show when={!props.compact}>
              <td data-label={t("debug.lanes.group")} />
            </Show>
            <td class="mono" data-label={t("debug.lanes.blocked")}>
              —{" "}
            </td>
          </tr>
        )}
      </Show>
    </>
  );
}
