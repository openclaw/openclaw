import { createMemo, For } from "solid-js";
import { normalizeTextScale, TEXT_SCALE_STOPS, type TextScaleStop } from "../../app/settings.ts";
import { normalizeTerminalFontFamily } from "../../app/terminal-font.ts";
import type { ThemeName } from "../../app/theme.ts";
import {
  loadTypefaceSpecimens,
  normalizeTypefaceOverride,
  resolveTypefaces,
  TYPEFACES,
} from "../../app/typography.ts";
import { SettingsRow, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import "../../components/select-picker.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { themeBrandingProjection } from "../../lib/reactive/theme-branding.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import { LanguageRow, serverUiPrefsScopeHint } from "./view-appearance-preferences.tsx";
import type { ConfigProps } from "./view-types.ts";

const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "configView.textSizes.small",
  100: "configView.textSizes.default",
  110: "configView.textSizes.large",
  125: "configView.textSizes.xl",
  140: "configView.textSizes.xxl",
};

export function TextSection(
  props: ConfigProps & {
    presentedTheme: {
      id: ThemeName;
      label: string;
    };
  },
) {
  const branding = themeBrandingProjection;
  const options = createMemo(() =>
    Object.entries(TYPEFACES).map(([face, metadata]) => ({
      value: face,
      label: face === "system" ? t("configView.appearance.fonts.system") : metadata.label,
      description: t(`configView.appearance.fontNotes.${face}`),
      labelStyle: `font-family: ${metadata.stack}`,
    })),
  );
  // Isolate committed values from unrelated settings and translation refreshes.
  const terminalFontFamily = createMemo(() => props.terminalFontFamily ?? "");
  return (
    <section id={APPEARANCE_SETTINGS_TARGET_IDS.typography} class="settings-section">
      <SettingsSectionHeader title={t("configView.appearance.languageAndText")} />
      <div class="settings-group">
        <LanguageRow {...props} />
        <div id={APPEARANCE_SETTINGS_TARGET_IDS.textSize}>
          <SettingsRow
            title={t("configView.appearance.textSize")}
            description={t("quickSettings.personal.browserOnly")}
            stackedOnNarrow={true}
            control={
              <SettingsSegmented
                value={String(props.textScale)}
                ariaLabel={t("configView.appearance.textSize")}
                options={TEXT_SCALE_STOPS.map((stop) => ({
                  value: String(stop),
                  label: `${stop}%`,
                  title: t(TEXT_SCALE_LABELS[stop]),
                }))}
                onChange={(value) => props.setTextScale(normalizeTextScale(Number(value)))}
              />
            }
          />
        </div>
        <For each={["ui", "chat"] as const}>
          {(slot) => {
            const isUi = slot === "ui";
            const title = () => t(`configView.appearance.fonts.${slot}`);
            const face = createMemo(() => resolveTypefaces(props.presentedTheme.id)[slot]);
            return (
              <SettingsRow
                title={title()}
                stackedOnNarrow={true}
                control={
                  <openclaw-select-picker
                    class="settings-select picker-select"
                    style={{ width: "100%", "min-width": "min(138px,100%)" }}
                    prop:params={{
                      id: `settings-font-${slot}`,
                      label: title(),
                      value: (isUi ? props.fontUi : props.fontChat) ?? "theme",
                      options: [
                        {
                          value: "theme",
                          // Both slots say "Theme default": Dash and Absolutely default
                          // chat to a serif that intentionally differs from the interface
                          // face, so "match interface" would misname the actual fallback.
                          label: t("configView.appearance.fonts.themeDefault"),
                          description: t("configView.appearance.fonts.themeFace", {
                            theme: props.presentedTheme.label,
                            face:
                              face() === "system"
                                ? t("configView.appearance.fonts.system")
                                : TYPEFACES[face()].label,
                          }),
                          labelStyle: `font-family: ${TYPEFACES[face()].stack}`,
                        },
                        ...options(),
                      ],
                      onOpen: loadTypefaceSpecimens,
                      onChange: (value: string) =>
                        (isUi ? props.setFontUi : props.setFontChat)(
                          normalizeTypefaceOverride(value),
                        ),
                    }}
                  />
                }
              />
            );
          }}
        </For>
        <SettingsRow
          title={t("configView.appearance.fonts.terminal")}
          description={
            <>
              {t("configView.appearance.fonts.terminalHint")}{" "}
              {t("configView.appearance.fonts.terminalLigatures")}{" "}
              {t("quickSettings.personal.browserOnly")}
            </>
          }
          stackedOnNarrow={true}
          control={
            <>
              <input
                class="settings-input"
                data-settings-terminal-font
                aria-label={t("configView.appearance.fonts.terminal")}
                placeholder={t("configView.appearance.fonts.terminalDefault")}
                maxlength={100}
                spellcheck="false"
                ref={liveValue(terminalFontFamily)}
                onInput={(event) => event.currentTarget.setCustomValidity("")}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const family = normalizeTerminalFontFamily(input.value);
                  if (input.value.trim() && !family) {
                    input.setCustomValidity(t("configView.appearance.fonts.terminalInvalid"));
                    input.reportValidity();
                    return;
                  }
                  input.setCustomValidity("");
                  input.value = family ?? "";
                  props.setTerminalFontFamily(family);
                }}
              />
              <button
                class="btn btn--sm"
                type="button"
                disabled={!props.terminalFontFamily}
                onClick={() => props.setTerminalFontFamily(undefined)}
              >
                {t("configView.appearance.fonts.terminalReset")}
              </button>
            </>
          }
        />
        <div class="settings-row settings-row--stacked">
          <div class="settings-typography-preview">
            <div class="settings-typography-preview__caption">
              {t("configView.appearance.fonts.brandedPreviewCaption", {
                brand: branding.read().brandName,
              })}
            </div>
            <p class="settings-typography-preview__prose">
              {t("configView.appearance.fonts.previewProse")}
            </p>
            <code class="settings-typography-preview__code">
              {t("configView.appearance.fonts.previewCode")}
            </code>
          </div>
        </div>
      </div>
      <p class="settings-section__desc settings-section__scope">
        {serverUiPrefsScopeHint([
          props.localeProvenance,
          props.fontUiProvenance,
          props.fontChatProvenance,
        ])}
      </p>
    </section>
  );
}
