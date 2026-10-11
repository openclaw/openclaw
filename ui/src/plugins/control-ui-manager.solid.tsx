import { For, Show, createSignal } from "solid-js";
import { SettingsRow, SettingsSection } from "../components/solid/settings-ui.tsx";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { CustomPluginUiDisabled } from "./control-ui-disabled.solid.tsx";

function PluginManagerContent(_props: object, host: HTMLElement) {
  const context = useApplication();
  const [reloading, setReloading] = createSignal(false);
  const [reloadError, setReloadError] = createSignal("");
  host.style.display = "contents";
  const source = projectSource(context?.plugins, {
    read: (runtime) => runtime,
    subscribe: (runtime, notify) => runtime?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });
  const replacements = () => source.read()?.registrations("replacements") ?? [];
  const surfaces = () => [...new Set(replacements().map((entry) => entry.value.surface))];
  return (
    <Show when={source.read()}>
      <Show
        when={
          replacements().length ||
          source.read()?.errors.length ||
          (source.read()?.hasPlugins && source.read()?.canReload)
        }
      >
        <SettingsSection title={t("pluginUi.customize")} carapace>
          <SettingsRow
            title={t("pluginUi.selectionScope")}
            carapace
            stackedOnNarrow
            control={
              <>
                <Show when={source.read()?.canReload}>
                  <button
                    class="btn btn--sm oc-action oc-action-secondary"
                    type="button"
                    disabled={reloading()}
                    onClick={() =>
                      void (async () => {
                        setReloading(true);
                        setReloadError("");
                        try {
                          await source.read()?.reload();
                        } catch (error) {
                          setReloadError(error instanceof Error ? error.message : String(error));
                        } finally {
                          setReloading(false);
                        }
                      })()
                    }
                  >
                    {t("pluginUi.reload")}
                  </button>
                </Show>
                <button
                  class="btn btn--sm oc-action oc-action-secondary"
                  type="button"
                  onClick={() => void source.read()?.refresh()}
                >
                  {t("common.retry")}
                </button>
              </>
            }
          />
          <For each={surfaces()}>
            {(surface) => (
              <SettingsRow
                title={t(`pluginUi.surface.${surface}`)}
                carapace
                stackedOnNarrow
                control={
                  <select
                    class="settings-select oc-select"
                    aria-label={t(`pluginUi.surface.${surface}`)}
                    value={source.read()?.selectedReplacement(surface)?.key ?? ""}
                    onChange={(event) =>
                      source.read()?.selectReplacement(surface, event.currentTarget.value || null)
                    }
                  >
                    <option value="">{t("pluginUi.builtin")}</option>
                    <For
                      each={replacements().filter((entry) => entry.value.surface === surface)}
                      keyed={(entry) => entry.key}
                    >
                      {(entry) => (
                        <option value={entry().key}>
                          {entry().value.label} ({entry().pluginId})
                        </option>
                      )}
                    </For>
                  </select>
                }
              />
            )}
          </For>
          <For each={source.read()?.errors} keyed={(entry) => entry.pluginId}>
            {(entry) => (
              <SettingsRow
                title={entry().pluginId}
                carapace
                stacked
                role={entry().code === "custom-plugin-ui-disabled" ? "status" : "alert"}
                control={
                  <Show
                    when={entry().code === "custom-plugin-ui-disabled"}
                    fallback={<span>{entry().message}</span>}
                  >
                    <CustomPluginUiDisabled context={context} pluginId={entry().pluginId} />
                  </Show>
                }
              />
            )}
          </For>
          <Show when={reloadError()}>
            <SettingsRow title={reloadError()} role="alert" carapace />
          </Show>
        </SettingsSection>
      </Show>
    </Show>
  );
}

export const PluginManager = defineSolidBridge<object>(
  "openclaw-plugin-manager",
  PluginManagerContent,
  { properties: {} },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-manager": SolidBridgeElement<object>;
  }
}
