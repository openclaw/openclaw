import { html, nothing } from "lit";
import type { BackgroundPreference } from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export type AppearanceBackgroundView = {
  preference: BackgroundPreference;
  imageUrl: string | null;
  hasImage: boolean;
  busy: boolean;
  uploadAllowed: boolean;
  scopeHint: string;
  message: { kind: "error" | "status"; text: string } | null;
  onSource: (source: BackgroundPreference["source"]["kind"]) => void;
  onChange: (patch: Partial<BackgroundPreference>) => void;
  onChooseImage: () => void;
  onRemoveImage: () => void;
  onFile: (file: File) => void;
  onPreviewStart: (event: PointerEvent) => void;
  onPreviewInput: () => void;
  onPreviewEnd: (event: PointerEvent) => void;
  onPreviewKey: (event: KeyboardEvent) => void;
  onPreviewCancel: () => void;
  onRetry?: () => void;
};

export function renderAppearanceBackground(props: AppearanceBackgroundView) {
  const preference = props.preference;
  const disabled = props.busy || preference.source.kind === "none";
  const presentation = preference.presentation ?? "faded";
  const visibility = Math.round(preference.visibility * 100);
  const placementHint =
    preference.source.kind === "none"
      ? "noneHint"
      : !preference.showOnNewSession && !preference.showInSessions
        ? "placementOffHint"
        : preference.visibility === 0
          ? "visibilityZeroHint"
          : undefined;
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.background} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.appearance.background.title")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.appearance.background.source"),
          stacked: true,
          control: html`
            <div class="settings-background-artwork">
              <div
                class="settings-background-options"
                role="group"
                aria-label=${t("configView.appearance.background.source")}
              >
                ${(["none", "theme", "custom"] as const).map(
                  (source) => html`
                    <button
                      type="button"
                      class="settings-background-option settings-background-option--${source}"
                      data-background-source=${source}
                      aria-label=${t(`configView.appearance.background.${source}`)}
                      aria-pressed=${String(preference.source.kind === source)}
                      ?disabled=${
                        props.busy ||
                        (source === "custom" && !props.hasImage && !props.uploadAllowed)
                      }
                      @click=${() => props.onSource(source)}
                    >
                      <span class="settings-background-option__sample" aria-hidden="true">
                        ${
                          source === "custom" && props.imageUrl
                            ? html`<img src=${props.imageUrl} alt="" />`
                            : source === "none"
                              ? icons.circleX
                              : source === "custom"
                                ? icons.image
                                : icons.palette
                        }
                      </span>
                      <span class="settings-background-option__label">
                        ${t(`configView.appearance.background.${source === "none" ? "none" : `${source}Choice`}`)}
                        ${
                          preference.source.kind === source
                            ? html`<span aria-hidden="true">${icons.check}</span>`
                            : nothing
                        }
                      </span>
                    </button>
                  `,
                )}
              </div>
              <div class="settings-background-actions">
                ${!props.hasImage ? html`<span class="settings-background-formats">${t("configView.appearance.background.formats")}</span>` : nothing}
                <button
                  type="button"
                  class="btn btn--sm"
                  data-background-upload
                  title=${t("configView.appearance.background.formats")}
                  ?disabled=${props.busy || !props.uploadAllowed}
                  @click=${props.onChooseImage}
                >
                  ${t(
                    props.hasImage
                      ? "configView.appearance.background.replace"
                      : "configView.appearance.background.choose",
                  )}
                </button>
                ${
                  props.hasImage
                    ? html`<button
                        type="button"
                        class="btn btn--sm"
                        data-background-remove
                        ?disabled=${props.busy || !props.uploadAllowed}
                        @click=${props.onRemoveImage}
                      >
                        ${t("configView.appearance.background.remove")}
                      </button>`
                    : nothing
                }
              </div>
            </div>
          `,
        })}
        ${renderSettingsRow({
          title: t("configView.appearance.background.presentation"),
          description: t(`configView.appearance.background.${presentation}Hint`),
          stackedOnNarrow: true,
          control: renderSettingsSegmented({
            mode: "buttons",
            value: presentation,
            disabled,
            ariaLabel: t("configView.appearance.background.presentation"),
            options: (["faded", "full-bleed"] as const).map((mode) => ({
              value: mode,
              label: t(`configView.appearance.background.${mode}`),
              testId: `background-presentation-${mode}`,
            })),
            onChange: (nextPresentation) => props.onChange({ presentation: nextPresentation }),
          }),
        })}
        ${renderSettingsRow({
          title: t("configView.appearance.background.visibility"),
          description: html`<span id="settings-background-visibility-hint">
            ${t("configView.appearance.background.visibilityHint")}
          </span>`,
          stackedOnNarrow: true,
          control: html`<div class="settings-background-visibility">
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              aria-label=${t("configView.appearance.background.visibility")}
              aria-describedby="settings-background-visibility-hint"
              aria-valuetext=${`${visibility}%`}
              .value=${String(visibility)}
              ?disabled=${disabled}
              @pointerdown=${props.onPreviewStart}
              @pointerup=${props.onPreviewEnd}
              @pointercancel=${props.onPreviewCancel}
              @lostpointercapture=${props.onPreviewEnd}
              @keydown=${props.onPreviewKey}
              @blur=${props.onPreviewCancel}
              @input=${(event: Event) => {
                props.onChange({
                  // SAFETY: This listener is attached directly to the range input above.
                  visibility: Number((event.currentTarget as HTMLInputElement).value) / 100,
                });
                props.onPreviewInput();
              }}
            />
            <span class="settings-background-visibility__value" aria-hidden="true">
              ${visibility}%
            </span>
          </div>`,
        })}
        ${renderSettingsToggleRow({
          title: t("configView.appearance.background.newSession"),
          checked: preference.showOnNewSession,
          disabled,
          onChange: (showOnNewSession) => props.onChange({ showOnNewSession }),
        })}
        ${renderSettingsToggleRow({
          title: t("configView.appearance.background.sessions"),
          checked: preference.showInSessions,
          disabled,
          onChange: (showInSessions) => props.onChange({ showInSessions }),
        })}
      </div>
      <input
        type="file"
        data-background-file
        hidden
        accept="image/jpeg,image/png,image/webp"
        @change=${(event: Event) => {
          // SAFETY: This listener is attached directly to the file input above.
          const input = event.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          input.value = "";
          if (file) {
            props.onFile(file);
          }
        }}
      />
      ${
        placementHint
          ? html`<p class="settings-section__desc">
              ${t(`configView.appearance.background.${placementHint}`)}
            </p>`
          : nothing
      }
      <p class="settings-section__desc">${props.scopeHint}</p>
      ${
        props.message
          ? html`<p
              role=${props.message.kind === "error" ? "alert" : "status"}
              class="settings-status settings-status--${
                props.message.kind === "error" ? "danger" : "muted"
              }"
            >
              ${props.message.text}
              ${
                props.onRetry
                  ? html`<button
                      type="button"
                      class="btn btn--sm"
                      data-background-retry
                      @click=${props.onRetry}
                    >
                      ${t("common.retry")}
                    </button>`
                  : nothing
              }
            </p>`
          : nothing
      }
    </section>
  `;
}
