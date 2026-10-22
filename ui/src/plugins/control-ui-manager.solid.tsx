import {
  Errored,
  For,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  isPending,
} from "solid-js";
import { SettingsRow, SettingsSection } from "../components/solid/settings-ui.tsx";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { CustomPluginUiDisabled } from "./control-ui-disabled.solid.tsx";

export function PluginManager() {
  const context = useApplication();
  const [reloading, setReloading] = createOptimistic(false);
  const [operationRead, setOperationRead] = createSignal<{
    result: Promise<void>;
    revision: number;
    kind: "reload" | "refresh";
  } | null>(null);
  const source = projectOwner(context.plugins, (runtime) => runtime);
  const connection = projectOwner(
    context.gateway,
    (gateway) => gateway.connectionRevision,
    Object.is,
  );
  const completion = createMemo(() => {
    const read = operationRead();
    return read?.revision === connection.read() ? read.result.then(() => null) : null;
  });
  const refreshing = () => isPending(completion) && operationRead()?.kind === "refresh";
  const observe = (result: Promise<void>, kind: "reload" | "refresh") => {
    // The surface can disappear before the admitted operation settles.
    void result.catch(() => undefined);
    setOperationRead({ result, kind, revision: context.gateway.connectionRevision });
  };
  const reload = action(function* () {
    setReloading(true);
    yield source.read().reload();
  });
  const replacements = createMemo(() => source.read().registrations("replacements"));
  const surfaces = createMemo(() => [
    ...new Set(replacements().map((entry) => entry.value.surface)),
  ]);
  return (
    <openclaw-plugin-manager style={{ display: "contents" }}>
      <Show
        when={
          replacements().length ||
          source.read().errors.length ||
          (source.read().hasPlugins && source.read().canReload)
        }
      >
        <SettingsSection title={t("pluginUi.customize")} carapace>
          <SettingsRow
            title={t("pluginUi.selectionScope")}
            carapace
            stackedOnNarrow
            control={
              <>
                <Show when={source.read().canReload}>
                  <button
                    class="btn btn--sm oc-action oc-action-secondary"
                    type="button"
                    disabled={reloading()}
                    onClick={() => observe(reload(), "reload")}
                  >
                    {t("pluginUi.reload")}
                  </button>
                </Show>
                <button
                  class="btn btn--sm oc-action oc-action-secondary"
                  type="button"
                  aria-busy={refreshing() ? "true" : "false"}
                  onClick={() => observe(source.read().refresh(), "refresh")}
                >
                  <Show when={refreshing()}>
                    <span class="btn__spinner" aria-hidden="true" />
                  </Show>
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
                    value={source.read().selectedReplacement(surface)?.key ?? ""}
                    onChange={(event) =>
                      source.read().selectReplacement(surface, event.currentTarget.value || null)
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
          <For each={source.read().errors} keyed={(entry) => entry.pluginId}>
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
          <For each={!reloading() && operationRead() ? [operationRead()!] : []}>
            {() => (
              <Errored
                fallback={(error) => {
                  const message = () => {
                    const value = error();
                    return value instanceof Error ? value.message : String(value);
                  };
                  return <SettingsRow title={message()} role="alert" carapace />;
                }}
              >
                <Loading>{completion()}</Loading>
              </Errored>
            )}
          </For>
        </SettingsSection>
      </Show>
    </openclaw-plugin-manager>
  );
}
