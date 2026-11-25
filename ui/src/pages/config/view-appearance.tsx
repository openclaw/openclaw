import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  For,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { BUILTIN_THEMES } from "../../../../packages/gateway-protocol/src/theme.ts";
import { controlUiAccentInk } from "../../app/accent-contrast.ts";
import { UI_APPEARANCE_DEFAULTS } from "../../app/settings.ts";
import type { CatalogTheme } from "../../app/theme-catalog.ts";
import type { ThemeName } from "../../app/theme.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsPage,
  SettingsRow,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../../lib/reactive/observers.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { AppearanceBackground } from "./appearance-background.tsx";
import { formatThemeValidationError } from "./custom-theme-import.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { SessionSources } from "./session-sources.tsx";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import {
  ChatPreferencesSection,
  LobsterPetSection,
  MediaDevicesSection,
  serverUiPrefsScopeHint,
  SidebarPreferencesSection,
} from "./view-appearance-preferences.tsx";
import { TextSection } from "./view-appearance-typography.tsx";
import { ConfigReadStatus } from "./view-readiness.tsx";
import { TabIconRow } from "./view-tab-icon.tsx";
import type { ConfigProps } from "./view-types.ts";
const ACCENT_PRESETS = [
  {
    id: "default",
    hex: undefined,
  },
  {
    id: "claw",
    hex: "#ff5c5c",
  },
  {
    id: "coral",
    hex: "#ff8066",
  },
  {
    id: "amber",
    hex: "#f5b942",
  },
  {
    id: "mint",
    hex: "#52c99a",
  },
  {
    id: "teal",
    hex: "#35b9b0",
  },
  {
    id: "blue",
    hex: "#5b9cf6",
  },
  {
    id: "violet",
    hex: "#a78bfa",
  },
  {
    id: "pink",
    hex: "#f472b6",
  },
  {
    id: "slate",
    hex: "#8795a8",
  },
] as const;

/* Builtin cards preview their real palette (chip colors live in config.css,
   mirrored from the base.css theme blocks). Catalog cards use their cached palette.
   Only the inactive custom import card falls back to the download icon. */
function ThemeCardVisual(props: {
  id: ThemeName;
  activeTheme: ThemeName;
  selected: boolean;
  palette?: CatalogTheme["palette"];
}) {
  const previewStyle = createMemo(() => {
    const palette = props.palette;
    if (!palette) {
      // Catalog cards stay neutral until their own palette is available.
      return props.id.includes("/")
        ? {
            "--theme-chip-bg": "var(--bg-hover)",
            "--theme-chip-accent": "var(--muted)",
            "--theme-chip-accent-2": "var(--muted)",
          }
        : undefined;
    }
    return {
      "--theme-chip-bg": `light-dark(${palette.light.bg}, ${palette.dark.bg})`,
      "--theme-chip-ink": `light-dark(${palette.light.text}, ${palette.dark.text})`,
      "--theme-chip-accent": `light-dark(${palette.light.accent}, ${palette.dark.accent})`,
      "--theme-chip-accent-2": `light-dark(${palette.light["accent-2"]}, ${palette.dark["accent-2"]})`,
    };
  });
  return (
    <span class="settings-theme-card__swatch" aria-hidden="true" style={previewStyle()}>
      <Show
        when={props.id !== "custom" || props.activeTheme === props.id}
        fallback={
          <span class="settings-theme-card__icon">
            <Icon name="download" />
          </span>
        }
      >
        <span class="settings-theme-card__palette">
          <span class="settings-theme-card__line" />
          <span class="settings-theme-card__line settings-theme-card__line--short" />
          <span class="settings-theme-card__chips">
            <span class="settings-theme-card__chip settings-theme-card__chip--accent" />
            <span class="settings-theme-card__chip settings-theme-card__chip--accent-2" />
          </span>
        </span>
      </Show>
      <Show when={props.selected}>
        <span class="settings-theme-card__check">
          <Icon name="check" />
        </span>
      </Show>
    </span>
  );
}
export function AppearanceSection(props: ConfigProps) {
  let customThemeImportInput: HTMLInputElement | undefined;
  let sidebar!: HTMLElement;
  let sessionSources!: HTMLElement;
  createIntersectionObserver(
    () => [sidebar, sessionSources],
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        props.onAppearanceDataNeeded?.();
      }
    },
    { rootMargin: "400px 0px" },
  );
  const [importing, setImporting] = createOptimistic(false, { equals: false });
  // Pending work belongs to the action; terminal receipts feed the error region.
  const importResult = createMemo(() => props.customThemeImportCompletion);
  const presentImport = action(function* (completion: Promise<void>) {
    setImporting(true);
    yield completion;
  });
  function importTheme() {
    const completion = props.onImportCustomTheme();
    if (completion) {
      // Commit synchronous admission before starting the pending frame.
      onSettled(() => {
        // The same receipt reports failures through the inline error boundary.
        void presentImport(completion).catch(() => undefined);
      });
    }
  }
  const importMessage = () => {
    importResult();
    const message = props.customThemeImportMessage;
    return message?.kind === "error" ? message : null;
  };
  let focusFrame = 0;
  const showCustomThemeImport = () =>
    props.hasCustomTheme || props.customThemeImportExpanded === true;
  function focusImporter() {
    const input = customThemeImportInput;
    if (!input?.isConnected) {
      return;
    }
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      if (!input.isConnected) {
        return;
      }
      input.scrollIntoView({ block: "center", behavior: resolveScrollBehavior() });
      input.focus();
      input.select();
    });
  }
  onSettled(() => {
    if (showCustomThemeImport()) {
      focusImporter();
    }
    return () => cancelAnimationFrame(focusFrame);
  });
  const importedName = createMemo(() =>
    props.hasCustomTheme && props.customThemeLabel
      ? props.customThemeLabel
      : t("configView.appearance.customTheme"),
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
  const themeUnavailable = () =>
    props.themeCatalog?.unavailableId === props.theme ||
    (props.theme.includes("/") && Boolean(props.themeCatalog?.themes.length) && !selectedTheme());
  const presentedTheme = createMemo(
    () =>
      selectedTheme() ?? {
        id: UI_APPEARANCE_DEFAULTS.theme,
        label: t("configView.themes.claw.label"),
      },
  );
  const themeScope = () =>
    serverUiPrefsScopeHint([
      props.themeProvenance,
      props.themeModeProvenance,
      props.accentProvenance,
    ]);
  // The theme swatch is selected whenever resetting would land on the current
  // accent. A boolean `overridden` cannot express that: the resolver reports an
  // inherited server or profile accent as overridden too, which is what left the
  // swatch permanently unselectable and its reset click without a visible effect.
  // Accepted cost: an override equal to its reset target reads as inherited
  // until the two diverge, when the swatches correct themselves.
  const themeAccentSelected = () => props.accent === "theme";
  const accentColor = createMemo(() => (themeAccentSelected() ? undefined : props.accent));
  const defaultAccentSelected = () =>
    props.accent === props.accentResetValue ||
    (themeAccentSelected() && props.accentResetValue === undefined);
  // Preview the accent a reset lands on, never var(--accent): the live override
  // would render this swatch as a duplicate of the selected preset.
  const themeAccentColor = () =>
    props.accentResetValue && props.accentResetValue !== "theme"
      ? props.accentResetValue
      : "var(--theme-chip-accent)";
  const selectedAccentPreset = createMemo(() =>
    ACCENT_PRESETS.find((preset) => preset.hex !== undefined && preset.hex === props.accent),
  );
  const customAccentSelected = () =>
    Boolean(
      !defaultAccentSelected() && !themeAccentSelected() && props.accent && !selectedAccentPreset(),
    );
  const accentSelectionName = createMemo(() => {
    const preset = selectedAccentPreset();
    return customAccentSelected()
      ? t("configView.appearance.customAccent")
      : t(
          `configView.appearance.accents.${preset && !defaultAccentSelected() ? preset.id : "default"}`,
        );
  });
  return (
    <SettingsPage>
      <section id={APPEARANCE_SETTINGS_TARGET_IDS.theme} class="settings-section">
        <SettingsSectionHeader title={t("configView.appearance.theme")} />
        <p class="settings-section__desc">{t("configView.appearance.chooseTheme")}</p>
        {themeUnavailable() ? (
          <p class="settings-section__desc" role="status">
            {t("configView.appearance.themeUnavailable", {
              id: props.theme,
            })}
          </p>
        ) : undefined}
        <Show when={props.themeCatalog?.read ?? props.themeCatalog} keyed>
          {(initialCatalog) => {
            const catalog = createMemo(() =>
              "result" in initialCatalog ? initialCatalog.result : initialCatalog,
            );
            const status = () => {
              const error = catalog()?.error;
              if (error) {
                throw error instanceof Error ? error : new Error(error);
              }
              return undefined;
            };
            return (
              <Errored
                fallback={(error) => (
                  <p class="settings-status settings-status--error" role="alert">
                    {formatThemeValidationError(error())}{" "}
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => props.onRetryThemeCatalog?.()}
                    >
                      {t("common.retry")}
                    </button>
                  </p>
                )}
              >
                <Loading fallback={undefined}>{status()}</Loading>
              </Errored>
            );
          }}
        </Show>
        <div class="settings-group">
          <SettingsRow
            title={t("common.colorMode")}
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
          <div class="settings-row settings-row--stacked">
            <div class="settings-theme-grid">
              <For each={themeOptions()} keyed={(entry) => entry.id}>
                {(opt) => (
                  <button
                    class={[
                      "settings-theme-card",
                      `settings-theme-card--${opt().id.includes("/") ? "catalog" : opt().id}`,
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
                        onSettled(focusImporter);
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
                    <ThemeCardVisual
                      id={opt().id}
                      activeTheme={presentedTheme().id}
                      selected={opt().id === presentedTheme().id}
                      palette={props.themeCatalog?.palettes?.get(opt().id)}
                    />
                    <span class="settings-theme-card__label">{opt().label}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
          {showCustomThemeImport() ? (
            <div class="settings-row settings-row--stacked">
              <div
                class="settings-theme-import"
                onFocusIn={() => props.onCustomThemeImportFocus?.()}
              >
                <div class="settings-theme-import__head">
                  <div class="settings-row__text">
                    <span class="settings-row__title">
                      {t("configView.appearance.importFromTweakcn")}
                    </span>
                    <span class="settings-row__desc">
                      {t("configView.appearance.tweakcnInstructions")}
                    </span>
                  </div>
                  <a
                    class="btn btn--sm settings-theme-import__external"
                    href="https://tweakcn.com/editor/theme"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("configView.appearance.browseTweakcn")} <Icon name="externalLink" />
                  </a>
                </div>
                <ConfigReadStatus config={props} />
                <div class="settings-theme-import__field">
                  <input
                    ref={(input) => (customThemeImportInput = input)}
                    class="settings-input settings-theme-import__input"
                    data-custom-theme-import-input
                    type="text"
                    spellcheck="false"
                    aria-label={t("configView.appearance.themeLink")}
                    placeholder="https://tweakcn.com/editor/theme?theme=... or amethyst-haze"
                    value={props.customThemeImportUrl}
                    onInput={(event: Event) =>
                      props.onCustomThemeImportUrlChange(
                        // SAFETY: The listener is bound directly to this input.
                        (event.currentTarget as HTMLInputElement).value,
                      )
                    }
                  />
                  <button
                    class="btn btn--sm primary"
                    disabled={
                      importing() ||
                      (props.connected && (!props.configLoaded || props.loading)) ||
                      props.customThemeImportUrl.trim().length === 0
                    }
                    onClick={importTheme}
                  >
                    {importing()
                      ? t("common.importing")
                      : props.hasCustomTheme
                        ? t("configView.appearance.replace", {
                            name: importedName(),
                          })
                        : t("configView.appearance.importTheme")}
                  </button>
                </div>
                {props.hasCustomTheme ? (
                  <div class="settings-theme-import__meta">
                    <span class="settings-row__desc settings-theme-import__meta-value">
                      {t("configView.appearance.loaded")} · {importedName()} ·{" "}
                      {props.customThemeSourceUrl ?? "tweakcn"}
                    </span>
                    <button class="btn btn--sm danger" onClick={() => props.onClearCustomTheme()}>
                      {t("configView.appearance.clear", {
                        name: importedName(),
                      })}
                    </button>
                  </div>
                ) : undefined}
                <Errored
                  fallback={(error) => (
                    <div
                      class="settings-theme-import__message settings-theme-import__message--error"
                      role="alert"
                    >
                      <div>{t("configView.appearance.importFailed")}</div>
                      <div>{formatThemeValidationError(error())}</div>
                    </div>
                  )}
                >
                  <Loading>
                    <Show when={importMessage()}>
                      {(message) => (
                        <div
                          class={[
                            "settings-theme-import__message",
                            `settings-theme-import__message--${message().kind}`,
                          ]}
                          role={message().kind === "error" ? "alert" : "status"}
                        >
                          {message().text}
                        </div>
                      )}
                    </Show>
                  </Loading>
                </Errored>
              </div>
            </div>
          ) : undefined}
          <div id={APPEARANCE_SETTINGS_TARGET_IDS.accent}>
            <SettingsRow
              title={t("configView.appearance.accent")}
              description={<span id="settings-accent-status">{accentSelectionName()}</span>}
              stackedOnNarrow={true}
              control={
                <div class="settings-accent-swatches">
                  <For each={ACCENT_PRESETS}>
                    {(preset) => {
                      const isDefault = preset.hex === undefined;
                      const selected = () =>
                        isDefault
                          ? defaultAccentSelected()
                          : !defaultAccentSelected() && preset.hex === props.accent;
                      const label = () => t(`configView.appearance.accents.${preset.id}`);
                      const themeChipScope = () =>
                        isDefault
                          ? `settings-accent-theme--${presentedTheme().id.includes("/") ? "custom" : presentedTheme().id}`
                          : "";
                      return (
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
                            <span class="settings-accent-swatch__reset" aria-hidden="true">
                              <Icon name="rotateCcw" />
                            </span>
                          ) : selected() ? (
                            <span class="settings-accent-swatch__check" aria-hidden="true">
                              <Icon name="check" />
                            </span>
                          ) : undefined}
                        </button>
                      );
                    }}
                  </For>
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
                      <Icon name="pipette" />
                    </span>
                  </span>
                </div>
              }
            />
          </div>
          <TabIconRow {...props} />
        </div>
        <p class="settings-section__desc settings-section__scope">{themeScope()}</p>
      </section>
      <TextSection {...props} presentedTheme={presentedTheme()} />
      <AppearanceBackground />
      <ChatPreferencesSection {...props} />
      <MediaDevicesSection {...props} />
      <SidebarPreferencesSection {...props} sectionRef={(element) => (sidebar = element)} />
      <SessionSources {...props} sectionRef={(element) => (sessionSources = element)} />
      <LobsterPetSection {...props} />
    </SettingsPage>
  );
}
