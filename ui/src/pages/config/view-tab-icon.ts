import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import { renderSettingsRow, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import type { ConfigProps } from "./view-types.ts";

export type TabIconViewProps = Pick<
  ConfigProps,
  | "tabIcon"
  | "tabIconBusy"
  | "tabIconError"
  | "tabIconUploadsEnabled"
  | "setTabIconMode"
  | "onTabIconFileChange"
  | "onRemoveTabIconImage"
>;

export function renderTabIconSection(props: TabIconViewProps) {
  const image = props.tabIcon?.image;
  const mode = props.tabIcon?.mode ?? "default";
  let fileInput: HTMLInputElement | undefined;
  const chooseImage = () => fileInput?.click();
  const label = image
    ? t("configView.appearance.tabIcon.replaceImage", { name: image.fileName })
    : t("configView.appearance.tabIcon.chooseImage");
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.tabIcon} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.appearance.tabIcon.title")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.appearance.tabIcon.source"),
          stackedOnNarrow: true,
          control: renderSettingsSegmented({
            value: mode,
            options: [
              { value: "default", label: t("configView.appearance.tabIcon.default") },
              { value: "agent", label: t("configView.appearance.tabIcon.agent") },
              { value: "custom", label: t("configView.appearance.tabIcon.custom") },
            ],
            ariaLabel: t("configView.appearance.tabIcon.sourceLabel"),
            onChange: props.setTabIconMode,
          }),
        })}
        ${
          mode === "custom"
            ? renderSettingsRow({
                title: t("configView.appearance.tabIcon.image"),
                description: t("configView.appearance.tabIcon.formats"),
                stackedOnNarrow: true,
                control: html`
                  <div class="settings-file" aria-busy=${String(props.tabIconBusy)}>
                    <button
                      type="button"
                      class="btn settings-file__value"
                      aria-label=${label}
                      title=${props.tabIconUploadsEnabled ? label : uploadsDisabledMessage()}
                      ?disabled=${!props.tabIconUploadsEnabled}
                      @click=${chooseImage}
                    >
                      <span class="settings-file__thumbnail" aria-hidden="true">
                        ${image ? html`<img src=${image.dataUrl} alt="" />` : icons.arrowUp}
                      </span>
                      <span class="settings-file__name">
                        ${image ? image.fileName : t("configView.appearance.tabIcon.chooseImage")}
                      </span>
                    </button>
                    ${
                      image
                        ? html`
                            <button
                              type="button"
                              class="btn settings-file__remove"
                              aria-label=${t("configView.appearance.tabIcon.removeImage")}
                              title=${t("configView.appearance.tabIcon.removeImage")}
                              @click=${props.onRemoveTabIconImage}
                            >
                              ${icons.x}
                            </button>
                          `
                        : nothing
                    }
                    <input
                      ${ref((element) => {
                        fileInput = element instanceof HTMLInputElement ? element : undefined;
                      })}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label=${t("configView.appearance.tabIcon.chooseImage")}
                      ?disabled=${!props.tabIconUploadsEnabled}
                      hidden
                      @change=${(event: Event) => {
                        const input = event.currentTarget;
                        if (!(input instanceof HTMLInputElement)) {
                          return;
                        }
                        const file = input.files?.[0];
                        input.value = "";
                        if (file) {
                          props.onTabIconFileChange(file);
                        }
                      }}
                    />
                  </div>
                `,
              })
            : nothing
        }
      </div>
      ${
        props.tabIconError
          ? html`<p class="settings-status settings-status--error" role="alert">
              ${props.tabIconError}
            </p>`
          : nothing
      }
    </section>
  `;
}
