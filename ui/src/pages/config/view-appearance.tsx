import { createEffect, createMemo, For } from "solid-js";
import { BUILTIN_THEMES } from "../../../../packages/gateway-protocol/src/theme.ts";
import { controlUiAccentInk } from "../../app/accent-contrast.ts";
import {
  TEXT_SCALE_STOPS,
  UI_APPEARANCE_DEFAULTS,
  type TextScaleStop,
} from "../../app/settings.ts";
import type { ThemeName } from "../../app/theme.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsDefaultDescription,
  SettingsPage,
  SettingsRow,
  SettingsSegmented,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { AppearanceBackground } from "./appearance-background.tsx";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { SessionSources } from "./session-sources.tsx";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import {
  ChatPreferencesSection,
  LanguageSection,
  LobsterPetSection,
  serverUiPrefProvenanceHint,
  SidebarPreferencesSection,
} from "./view-appearance-preferences.tsx";
import { Typography } from "./view-appearance-typography.tsx";
import { TabIconSection } from "./view-tab-icon.tsx";
import type { ConfigProps } from "./view-types.ts";
const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "configView.textSizes.small",
  100: "configView.textSizes.default",
  110: "configView.textSizes.large",
  125: "configView.textSizes.xl",
  140: "configView.textSizes.xxl",
};
const ACCENT_PRESETS = [
  {
    id: "default",
    hex: undefined,
    labelKey: "configView.appearance.accents.default",
  },
  {
    id: "claw",
    hex: "#ff5c5c",
    labelKey: "configView.appearance.accents.claw",
  },
  {
    id: "coral",
    hex: "#ff8066",
    labelKey: "configView.appearance.accents.coral",
  },
  {
    id: "amber",
    hex: "#f5b942",
    labelKey: "configView.appearance.accents.amber",
  },
  {
    id: "mint",
    hex: "#52c99a",
    labelKey: "configView.appearance.accents.mint",
  },
  {
    id: "teal",
    hex: "#35b9b0",
    labelKey: "configView.appearance.accents.teal",
  },
  {
    id: "blue",
    hex: "#5b9cf6",
    labelKey: "configView.appearance.accents.blue",
  },
  {
    id: "violet",
    hex: "#a78bfa",
    labelKey: "configView.appearance.accents.violet",
  },
  {
    id: "pink",
    hex: "#f472b6",
    labelKey: "configView.appearance.accents.pink",
  },
  {
    id: "slate",
    hex: "#8795a8",
    labelKey: "configView.appearance.accents.slate",
  },
] as const;

/* Builtin cards preview their real palette (chip colors live in config.css,
   mirrored from the base.css theme blocks). The custom card only has real
   colors while active — its chips read the live CSS variables — so it falls
   back to the download icon otherwise. */
function renderThemeCardVisual(id: ThemeName, activeTheme: ThemeName) {
  if ((id === "custom" || id.includes("/")) && activeTheme !== id) {
    return (
      <>
        <span class="settings-theme-card__icon" aria-hidden="true">
          {<Icon name="download" />}
        </span>
      </>
    );
  }
  return (
    <>
      <span class="settings-theme-card__palette" aria-hidden="true">
        <span class="settings-theme-card__chip settings-theme-card__chip--accent" />
        <span class="settings-theme-card__chip settings-theme-card__chip--accent-2" />
        <span class="settings-theme-card__chip settings-theme-card__chip--bg" />
      </span>
    </>
  );
}
function focusCustomThemeImportInput() {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>("[data-custom-theme-import-input]");
    if (!input) {
      return;
    }
    input.scrollIntoView({
      block: "center",
      behavior: resolveScrollBehavior(),
    });
    input.focus();
    input.select();
  });
}
export function AppearanceSection(props: ConfigProps) {
  const showCustomThemeImport = createMemo(
    () => props.hasCustomTheme || props.customThemeImportExpanded === true,
  );
  createEffect(
    () => ({
      shown: showCustomThemeImport(),
      token: props.customThemeImportFocusToken,
      viewState: props.viewState,
    }),
    ({ shown, token, viewState }) => {
      if (shown && token != null && token !== viewState.lastCustomThemeImportFocusToken) {
        viewState.lastCustomThemeImportFocusToken = token;
        focusCustomThemeImportInput();
      }
    },
  );
  const importedName = createMemo(() =>
    props.hasCustomTheme && props.customThemeLabel
      ? props.customThemeLabel
      : t("configView.appearance.importedTheme"),
  );
  const themeOptions = createMemo(
    (): Array<{ id: ThemeName; label: string; description: string }> => [
      ...(props.themeCatalog?.themes.length ? props.themeCatalog.themes : BUILTIN_THEMES).map(
        (theme) => ({
          id: theme.id,
          label: theme.source === "builtin" ? t(`configView.themes.${theme.id}.label`) : theme.name,
          description:
            theme.source === "builtin"
              ? t(`configView.themes.${theme.id}.description`)
              : theme.description,
        }),
      ),
      {
        id: "custom",
        label: props.hasCustomTheme ? importedName() : t("configView.appearance.import"),
        description: props.hasCustomTheme
          ? t("configView.appearance.importedFrom", {
              name: importedName(),
            })
          : t("configView.appearance.importHint"),
      },
    ],
  );
  const selectedTheme = createMemo(() =>
    themeOptions().find((option) => option.id === props.theme),
  );
  const themeUnavailable = createMemo(
    () =>
      props.themeCatalog?.unavailableId === props.theme ||
      (props.theme.includes("/") && Boolean(props.themeCatalog?.themes.length) && !selectedTheme()),
  );
  const presentedTheme = createMemo(
    () =>
      selectedTheme() ?? {
        id: UI_APPEARANCE_DEFAULTS.theme,
        label: t("configView.themes.claw.label"),
      },
  );
  const themeDefault = createMemo(
    () =>
      themeOptions().find((option) => option.id === props.themeResetValue)?.label ??
      t("configView.themes.claw.label"),
  );
  const themeModeDefault = createMemo(() =>
    props.themeModeResetValue === "light"
      ? t("common.light")
      : props.themeModeResetValue === "dark"
        ? t("common.dark")
        : t("common.system"),
  );
  const themeProvenance = createMemo(() => serverUiPrefProvenanceHint(props.themeProvenance));
  const themeModeProvenance = createMemo(() =>
    serverUiPrefProvenanceHint(props.themeModeProvenance),
  );
  const accentProvenance = createMemo(() => serverUiPrefProvenanceHint(props.accentProvenance));
  // The theme swatch is selected whenever resetting would land on the current
  // accent. A boolean `overridden` cannot express that: the resolver reports an
  // inherited server or profile accent as overridden too, which is what left the
  // swatch permanently unselectable and its reset click without a visible effect.
  // Accepted cost: an override equal to its reset target reads as inherited
  // until the two diverge, when the swatches correct themselves.
  const themeAccentSelected = createMemo(() => props.accent === "theme");
  const accentColor = createMemo(() => (themeAccentSelected() ? undefined : props.accent));
  const defaultAccentSelected = createMemo(
    () =>
      props.accent === props.accentResetValue ||
      (themeAccentSelected() && props.accentResetValue === undefined),
  );
  // Preview the accent a reset lands on, never var(--accent): the live override
  // would render this swatch as a duplicate of the selected preset.
  const themeAccentColor = createMemo(() =>
    props.accentResetValue && props.accentResetValue !== "theme"
      ? props.accentResetValue
      : "var(--theme-chip-accent)",
  );
  const customAccentSelected = createMemo(() =>
    Boolean(
      !defaultAccentSelected() &&
      !themeAccentSelected() &&
      props.accent &&
      !ACCENT_PRESETS.some((preset) => preset.hex === props.accent),
    ),
  );
  const selectedAccentPreset = createMemo(() =>
    ACCENT_PRESETS.find((preset) => preset.hex !== undefined && preset.hex === props.accent),
  );
  const accentSelectionStatus = createMemo(() =>
    themeAccentSelected()
      ? t("configView.appearance.usingThemeAccent")
      : defaultAccentSelected()
        ? null
        : t("configView.appearance.usingAccent", {
            value: t(selectedAccentPreset()?.labelKey ?? "configView.appearance.customAccent"),
          }),
  );
  return (
    <>
      <SettingsPage>
        {<LanguageSection {...props} />}
        <section id={APPEARANCE_SETTINGS_TARGET_IDS.theme} class="settings-section">
          {<SettingsSectionHeader title={t("configView.appearance.theme")} />}
          <p class="settings-section__desc">
            {t("configView.appearance.chooseTheme")}{" "}
            {
              <SettingsDefaultDescription
                value={themeDefault()}
                overridden={props.themeOverridden}
              />
            }{" "}
            {themeProvenance()}
          </p>
          {themeUnavailable() ? (
            <>
              <p class="settings-section__desc" role="status">
                {t("configView.appearance.themeUnavailable", {
                  id: props.theme,
                })}
              </p>
            </>
          ) : undefined}
          {props.themeCatalog?.error ? (
            <>
              <p class="settings-status settings-status--error" role="alert">
                {props.themeCatalog.error}{" "}
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => props.onRetryThemeCatalog?.()}
                >
                  {t("common.retry")}
                </button>
              </p>
            </>
          ) : undefined}
          <div class="settings-group">
            <div class="settings-row settings-row--stacked">
              <div class="settings-theme-grid">
                {
                  <For each={themeOptions()} keyed={(entry) => entry.id}>
                    {(opt) => (
                      <>
                        <button
                          class={[
                            "settings-theme-card",
                            `settings-theme-card--${opt().id.includes("/") ? "custom" : opt().id}`,
                            { "settings-theme-card--active": opt().id === presentedTheme().id },
                          ]}
                          aria-pressed={
                            opt().id === "custom" && !props.hasCustomTheme
                              ? undefined
                              : opt().id === presentedTheme().id
                                ? "true"
                                : "false"
                          }
                          title={opt().description}
                          data-theme-id={opt().id}
                          onClick={() => {
                            if (opt().id === "custom" && !props.hasCustomTheme) {
                              props.onOpenCustomThemeImport?.();
                              return;
                            }
                            if (
                              opt().id !== props.theme ||
                              (opt().id === props.themeResetValue && props.themeOverridden)
                            ) {
                              props.setTheme(opt().id);
                            }
                          }}
                        >
                          {renderThemeCardVisual(opt().id, presentedTheme().id)}
                          <span class="settings-theme-card__label">{opt().label}</span>
                        </button>
                      </>
                    )}
                  </For>
                }
              </div>
            </div>
            {
              <SettingsRow
                title={t("common.colorMode")}
                description={
                  <>
                    {
                      <SettingsDefaultDescription
                        value={themeModeDefault()}
                        overridden={props.themeModeOverridden}
                      />
                    }{" "}
                    {themeModeProvenance()}
                  </>
                }
                stackedOnNarrow={true}
                control={
                  <SettingsSegmented
                    value={props.themeMode}
                    options={[
                      {
                        value: "system",
                        label: t("common.system"),
                      },
                      {
                        value: "light",
                        label: t("common.light"),
                      },
                      {
                        value: "dark",
                        label: t("common.dark"),
                      },
                    ]}
                    ariaLabel={t("common.colorMode")}
                    onChange={(mode) => props.setThemeMode(mode)}
                    onReselect={(mode) => {
                      if (props.themeModeOverridden && mode === props.themeModeResetValue) {
                        props.setThemeMode(mode);
                      }
                    }}
                  />
                }
              />
            }
            <div class="settings-row settings-row--stacked">
              {showCustomThemeImport() ? (
                <>
                  <div class="settings-theme-import">
                    <div class="settings-theme-import__copy">
                      <div class="settings-theme-import__title">
                        {t("configView.appearance.importFromTweakcn")}
                      </div>
                      <p class="settings-theme-import__hint">
                        {t("configView.appearance.tweakcnInstructions")}
                      </p>
                    </div>
                    <a
                      class="settings-theme-import__external"
                      href="https://tweakcn.com/editor/theme"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {t("configView.appearance.browseTweakcn")} {<Icon name="externalLink" />}
                    </a>
                    <label class="settings-theme-import__field">
                      <span class="settings-theme-import__label">
                        {t("configView.appearance.themeLink")}
                      </span>
                      <input
                        class="settings-theme-import__input"
                        data-custom-theme-import-input
                        type="text"
                        spellcheck="false"
                        placeholder="https://tweakcn.com/editor/theme?theme=... or amethyst-haze"
                        value={props.customThemeImportUrl}
                        onInput={(event: Event) =>
                          props.onCustomThemeImportUrlChange(
                            // SAFETY: The listener is bound directly to this input.
                            (event.currentTarget as HTMLInputElement).value,
                          )
                        }
                      />
                    </label>
                    <div class="settings-theme-import__actions">
                      <button
                        class="btn btn--sm primary"
                        disabled={
                          props.customThemeImportBusy ||
                          props.customThemeImportUrl.trim().length === 0
                        }
                        onClick={() => props.onImportCustomTheme()}
                      >
                        {props.customThemeImportBusy
                          ? t("common.importing")
                          : props.hasCustomTheme
                            ? t("configView.appearance.replace", {
                                name: importedName(),
                              })
                            : t("configView.appearance.importTheme")}
                      </button>
                      {props.hasCustomTheme ? (
                        <>
                          <button
                            class="btn btn--sm danger"
                            onClick={() => props.onClearCustomTheme()}
                          >
                            {t("configView.appearance.clear", {
                              name: importedName(),
                            })}
                          </button>
                        </>
                      ) : undefined}
                    </div>
                    {props.hasCustomTheme ? (
                      <>
                        <div class="settings-theme-import__meta">
                          <span class="settings-theme-import__meta-label">
                            {t("configView.appearance.loaded")}
                          </span>
                          <span class="settings-theme-import__meta-value">
                            {importedName()} · {props.customThemeSourceUrl ?? "tweakcn"}
                          </span>
                        </div>
                      </>
                    ) : undefined}
                    {props.customThemeImportMessage ? (
                      <>
                        <div
                          class={[
                            "settings-theme-import__message",
                            `settings-theme-import__message--${props.customThemeImportMessage.kind}`,
                          ]}
                          role={
                            props.customThemeImportMessage.kind === "error" ? "alert" : "status"
                          }
                        >
                          {props.customThemeImportMessage.text}
                        </div>
                      </>
                    ) : undefined}
                  </div>
                </>
              ) : (
                <>
                  <p class="settings-theme-import__inline-hint">
                    {t("configView.appearance.inlineHintBefore")}{" "}
                    <strong>{t("configView.appearance.import")}</strong>{" "}
                    {t("configView.appearance.inlineHintAfter")}
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
        <AppearanceBackground />
        <section id={APPEARANCE_SETTINGS_TARGET_IDS.accent} class="settings-section">
          {<SettingsSectionHeader title={t("configView.appearance.accent")} />}
          <p class="settings-section__desc">{t("configView.appearance.accentHint")}</p>
          <div class="settings-group">
            <div class="settings-row settings-row--stacked">
              <div class="settings-accent-swatches">
                {
                  <For each={ACCENT_PRESETS}>
                    {(preset) => {
                      const isDefault = preset.hex === undefined;
                      const selected = createMemo(() =>
                        isDefault
                          ? defaultAccentSelected()
                          : !defaultAccentSelected() && preset.hex === props.accent,
                      );
                      const label = createMemo(() => t(preset.labelKey));
                      const themeChipScope = createMemo(() =>
                        isDefault
                          ? `settings-accent-theme--${presentedTheme().id.includes("/") ? "custom" : presentedTheme().id}`
                          : "",
                      );
                      return (
                        <>
                          <button
                            type="button"
                            class={[
                              "settings-accent-swatch",
                              themeChipScope(),
                              { "settings-accent-swatch--active": selected() },
                            ]}
                            style={{
                              "--settings-accent-swatch": preset.hex ?? themeAccentColor(),
                            }}
                            data-accent-preset={preset.id}
                            aria-label={label()}
                            aria-pressed={selected() ? "true" : "false"}
                            title={label()}
                            onClick={() => props.setAccent(preset.hex)}
                          >
                            {isDefault && !defaultAccentSelected() ? (
                              <>
                                <span class="settings-accent-swatch__reset" aria-hidden="true">
                                  {<Icon name="rotateCcw" />}
                                </span>
                              </>
                            ) : selected() ? (
                              <>
                                <span class="settings-accent-swatch__check" aria-hidden="true">
                                  {<Icon name="check" />}
                                </span>
                              </>
                            ) : undefined}
                          </button>
                        </>
                      );
                    }}
                  </For>
                }
                <span
                  class={[
                    "settings-accent-swatch settings-accent-swatch--custom",
                    { "settings-accent-swatch--active": customAccentSelected() },
                  ]}
                  style={{
                    "--settings-accent-swatch": accentColor() ?? ACCENT_PRESETS[1].hex,
                    "--settings-accent-swatch-ink": controlUiAccentInk(
                      accentColor() ?? ACCENT_PRESETS[1].hex,
                    ),
                  }}
                >
                  <input
                    type="color"
                    class="settings-accent-swatch__input"
                    data-accent-custom
                    aria-label={t("configView.appearance.customAccent")}
                    aria-describedby="settings-accent-status"
                    title={t("configView.appearance.customAccent")}
                    value={accentColor() ?? ACCENT_PRESETS[1].hex}
                    onInput={(
                      event: Event & {
                        currentTarget: HTMLInputElement;
                      },
                    ) => props.setAccent(event.currentTarget.value)}
                  />
                  <span class="settings-accent-swatch__picker" aria-hidden="true">
                    {<Icon name="pipette" />}
                  </span>
                </span>
              </div>
            </div>
          </div>
          <p id="settings-accent-status" class="settings-section__desc settings-accent-status">
            {accentSelectionStatus() ? (
              <>
                <span class="settings-accent-status__selection">{accentSelectionStatus()}</span>
              </>
            ) : undefined}
            <span class="settings-accent-status__scope">{accentProvenance()}</span>
          </p>
        </section>
        <Typography {...props} presentedTheme={presentedTheme()} /> {<TabIconSection {...props} />}
        <section id={APPEARANCE_SETTINGS_TARGET_IDS.textSize} class="settings-section">
          {<SettingsSectionHeader title={t("configView.appearance.textSize")} />}
          <p class="settings-section__desc">
            {
              <SettingsDefaultDescription
                value={`${UI_APPEARANCE_DEFAULTS.textScale}%`}
                overridden={props.textScaleOverridden}
              />
            }{" "}
            {t("quickSettings.personal.browserOnly")}
          </p>
          <div class="settings-group">
            <div class="settings-row settings-row--stacked">
              <div class="settings-text-scale">
                <div class="settings-text-scale__options">
                  {
                    <For each={TEXT_SCALE_STOPS}>
                      {(stop) => (
                        <>
                          <button
                            type="button"
                            class={[
                              "settings-text-scale__btn",
                              { active: stop === props.textScale },
                            ]}
                            aria-pressed={stop === props.textScale ? "true" : "false"}
                            onClick={() => props.setTextScale(stop)}
                          >
                            <span class="settings-text-scale__sample">
                              {t(TEXT_SCALE_LABELS[stop])}
                            </span>
                            <span class="settings-text-scale__label">{stop}%</span>
                          </button>
                        </>
                      )}
                    </For>
                  }
                </div>
              </div>
            </div>
          </div>
        </section>
        {<SidebarPreferencesSection {...props} />} {<LobsterPetSection {...props} />}
        {<ChatPreferencesSection {...props} />} {<SessionSources {...props} />}
        <section id={APPEARANCE_SETTINGS_TARGET_IDS.connection} class="settings-section">
          {<SettingsSectionHeader title={t("configView.connection.title")} />}
          <div class="settings-group">
            {
              <SettingsRow
                title={t("configView.connection.gateway")}
                control={<SettingsValue value={props.gatewayUrl || "-"} mono />}
              />
            }
            {
              <SettingsRow
                title={t("configView.connection.status")}
                control={
                  <SettingsStatus
                    kind={props.connected ? "ok" : "muted"}
                    label={props.connected ? t("common.connected") : t("common.offline")}
                  />
                }
              />
            }
            {props.assistantName ? (
              <SettingsRow
                title={t("configView.connection.assistant")}
                control={<SettingsValue value={props.assistantName} />}
              />
            ) : undefined}
          </div>
        </section>
      </SettingsPage>
    </>
  );
}
