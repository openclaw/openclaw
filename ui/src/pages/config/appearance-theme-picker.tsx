import { createMemo, createUniqueId, Show } from "solid-js";
import type { ThemeName } from "../../app/theme.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

type ThemeOption = { id: ThemeName; label: string; description: string };

export function AppearanceThemePicker(props: {
  options: readonly ThemeOption[];
  theme: ThemeName;
  currentLabel: string;
  preview: ThemeName | null;
  onPreview: (theme: ThemeName | null) => void;
  onApply: (theme: ThemeName) => void;
  onImport: () => void;
}) {
  const themeKeyboardHintId = createUniqueId();
  const previewedTheme = createMemo(
    () =>
      props.options.find((option) => option.id === props.preview) ??
      props.options.find((option) => option.id === props.theme),
  );
  const themePickerOptions = createMemo(() =>
    props.options.map((option) => ({
      value: option.id,
      ariaLabel: option.label,
      className: [
        "settings-theme-card",
        `settings-theme-card--${option.id.includes("/") ? "custom" : option.id}`,
      ],
      label: (
        <>
          <span class="settings-theme-card__heading">
            <span class="settings-theme-card__label">{option.label}</span>
            <Show when={option.id === props.theme}>
              <span class="settings-theme-card__selected" aria-hidden="true">
                <Icon name="check" />
              </span>
            </Show>
          </span>
          <span class="settings-theme-card__palette" aria-hidden="true">
            <Show
              when={
                !(option.id === "custom" || option.id.includes("/")) ||
                option.id === (props.preview ?? props.theme)
              }
              fallback={
                <span class="settings-theme-card__icon">
                  <Icon name="download" />
                </span>
              }
            >
              <span class="settings-theme-card__chip settings-theme-card__chip--accent" />
              <span class="settings-theme-card__chip settings-theme-card__chip--accent-2" />
              <span class="settings-theme-card__chip settings-theme-card__chip--bg" />
            </Show>
          </span>
        </>
      ),
    })),
  );
  let previewPointer: { x: number; y: number } | undefined;
  function previewThemeFromEvent(event: Event) {
    if (event instanceof PointerEvent) {
      if (event.pointerType === "touch") {
        return;
      }
      // Theme typography can move cards under a stationary cursor. Only actual
      // pointer movement may supersede keyboard intent or a cancelled preview.
      if (previewPointer?.x === event.clientX && previewPointer.y === event.clientY) {
        return;
      }
      previewPointer = { x: event.clientX, y: event.clientY };
    }
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "radio") {
      return;
    }
    const option = props.options.find((theme) => theme.id === input.value);
    if (option) {
      props.onPreview(option.id);
    }
  }
  function applyTheme(theme = props.preview) {
    if (theme === null) {
      return;
    }
    props.onApply(theme);
    props.onPreview(null);
  }
  function themePickerKeyDown(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    if (event.key === "Escape" && props.preview !== null) {
      event.preventDefault();
      event.stopPropagation();
      props.onPreview(null);
    } else if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      event.target.type === "radio"
    ) {
      const value = event.target.value;
      const option = props.options.find((theme) => theme.id === value);
      if (option) {
        event.preventDefault();
        event.stopPropagation();
        applyTheme(option.id);
      }
    }
  }
  return (
    <div
      class="settings-theme-picker"
      onPointerMove={previewThemeFromEvent}
      onFocusIn={previewThemeFromEvent}
      onKeyDown={themePickerKeyDown}
    >
      <SettingsSegmented
        class="settings-theme-grid"
        value={props.preview ?? props.theme}
        options={themePickerOptions()}
        ariaLabel={t("configView.appearance.themePicker")}
        descriptionId={themeKeyboardHintId}
        onChange={(theme) => props.onPreview(theme)}
        onReselect={(theme) => props.onPreview(theme)}
      />
      <div class="settings-theme-preview">
        <div class="settings-theme-preview__copy" role="status">
          <strong>
            {t(
              props.preview === null
                ? "configView.appearance.currentTheme"
                : "configView.appearance.previewingTheme",
              { name: previewedTheme()?.label ?? props.currentLabel },
            )}
          </strong>
          <span class="settings-theme-card__description">{previewedTheme()?.description}</span>
        </div>
        <div class="settings-theme-preview__actions">
          <button type="button" class="btn btn--sm" onClick={() => props.onImport()}>
            {t("configView.appearance.import")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.preview === null}
            onClick={() => props.onPreview(null)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            disabled={props.preview === null}
            onClick={() => applyTheme()}
          >
            {t("configView.appearance.applyTheme")}
          </button>
        </div>
      </div>
      <p id={themeKeyboardHintId} class="settings-theme-keyboard-hint">
        {t("configView.appearance.themeKeyboardHint")}
      </p>
    </div>
  );
}
