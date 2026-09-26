import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { renderSettingsRow, renderSettingsSection } from "../components/settings-ui.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { renderCustomPluginUiDisabled } from "./control-ui-disabled.ts";

class ControlUiPluginManager extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @state() private reloading = false;
  @state() private reloadError = "";

  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.context?.plugins,
      (plugins, notify) => plugins.subscribe(notify),
    );
  }

  override render() {
    const runtime = this.context?.plugins;
    if (!runtime) {
      return nothing;
    }
    const replacements = runtime.registrations("replacements");
    if (
      !replacements.length &&
      !runtime.errors.length &&
      !(runtime.hasPlugins && runtime.canReload)
    ) {
      return nothing;
    }
    const surfaces = [...new Set(replacements.map((entry) => entry.value.surface))];
    return renderSettingsSection(
      { title: t("pluginUi.customize"), carapace: true },
      html`
        ${renderSettingsRow({
          title: t("pluginUi.selectionScope"),
          carapace: true,
          stackedOnNarrow: true,
          control: html`
            ${
              runtime.canReload
                ? html`<button
                    class="btn btn--sm oc-action oc-action-secondary"
                    type="button"
                    ?disabled=${this.reloading}
                    @click=${async () => {
                      this.reloading = true;
                      this.reloadError = "";
                      try {
                        await runtime.reload();
                      } catch (error) {
                        this.reloadError = error instanceof Error ? error.message : String(error);
                      } finally {
                        this.reloading = false;
                      }
                    }}
                  >
                    ${t("pluginUi.reload")}
                  </button>`
                : nothing
            }
            <button
              class="btn btn--sm oc-action oc-action-secondary"
              type="button"
              @click=${() => void runtime.refresh()}
            >
              ${t("common.retry")}
            </button>
          `,
        })}
        ${surfaces.map((surface) =>
          renderSettingsRow({
            title: t(`pluginUi.surface.${surface}`),
            carapace: true,
            stackedOnNarrow: true,
            control: html`<select
              class="settings-select oc-select"
              aria-label=${t(`pluginUi.surface.${surface}`)}
              @change=${(event: Event) =>
                runtime.selectReplacement(
                  surface,
                  // SAFETY: this handler is bound directly to the select element.
                  (event.currentTarget as HTMLSelectElement).value || null,
                )}
            >
              <option value="" .selected=${!runtime.selectedReplacement(surface)}>
                ${t("pluginUi.builtin")}
              </option>
              ${replacements
                .filter((entry) => entry.value.surface === surface)
                .map(
                  (entry) => html`<option
                    value=${entry.key}
                    .selected=${runtime.selectedReplacement(surface)?.key === entry.key}
                  >
                    ${entry.value.label} (${entry.pluginId})
                  </option>`,
                )}
            </select>`,
          }),
        )}
        ${runtime.errors.map((entry) => {
          const disabled = renderCustomPluginUiDisabled(this.context, entry.pluginId);
          return renderSettingsRow({
            title: entry.pluginId,
            carapace: true,
            stacked: true,
            role: disabled ? "status" : "alert",
            control: disabled ?? html`<span>${entry.message}</span>`,
          });
        })}
        ${
          this.reloadError
            ? renderSettingsRow({
                title: this.reloadError,
                role: "alert",
                carapace: true,
              })
            : nothing
        }
      `,
    );
  }
}

if (!customElements.get("openclaw-plugin-manager")) {
  customElements.define("openclaw-plugin-manager", ControlUiPluginManager);
}
