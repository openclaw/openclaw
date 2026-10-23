import { createMemo, createSignal, createUniqueId, onSettled, Show } from "solid-js";
import { isBuiltinThemeId } from "../../../../packages/gateway-protocol/src/theme-ids.ts";
import { syncThemePaletteStylesheet, type ThemeMode, type ThemeName } from "../../app/theme.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../lib/reactive/observers.ts";
import { themeMiniatureDocument } from "./theme-miniature.ts";

type ThemeOption = { id: ThemeName; label: string; description: string };

function ThemeMiniature(props: { theme: ThemeName; mode: ThemeMode }) {
  const [source, setSource] = createSignal("");
  onSettled(() => {
    let retired = false;
    syncThemePaletteStylesheet(props.theme, () => {
      if (!retired) {
        setSource(themeMiniatureDocument(props.theme, props.mode));
      }
    });
    return () => {
      retired = true;
    };
  });
  // Keep the frame absent until its complete scriptless document is ready.
  return (
    <Show when={source()}>
      {(html) => (
        <iframe
          class="settings-theme-miniature__frame"
          title=""
          aria-hidden="true"
          tabindex={-1}
          sandbox=""
          srcdoc={html()}
        />
      )}
    </Show>
  );
}

export function AppearanceThemePicker(props: {
  options: readonly ThemeOption[];
  theme: ThemeName;
  mode: ThemeMode;
  paletteRevision?: number;
  preview: ThemeName | null;
  onPreview: (theme: ThemeName | null) => void;
  onApply: (theme: ThemeName) => void;
  onImport: () => void;
}) {
  const hintId = createUniqueId();
  const miniatureId = createUniqueId();
  // A new saved selection retires the local candidate; inspection never writes preferences.
  const savedTheme = createMemo(() => props.theme);
  const [candidate, setCandidate] = createSignal(() => savedTheme());
  const [inspected, setInspected] = createSignal<ThemeName | null>(null);
  const inspectedTheme = createMemo(() =>
    props.options.find((option) => option.id === inspected()),
  );
  let grid!: HTMLDivElement;
  let focusedChoice: HTMLInputElement | undefined;
  const [columns, setColumns] = createSignal(1);
  // CSS owns responsive columns; observe its resolved layout rather than duplicating breakpoints.
  createResizeObserver(
    () => [grid],
    () => {
      setColumns(getComputedStyle(grid).gridTemplateColumns.trim().split(" ").length);
    },
  );
  const inspectionRow = () =>
    Math.floor(props.options.findIndex((option) => option.id === inspected()) / columns()) + 2;
  function closeInspection() {
    focusedChoice?.focus();
    setInspected(null);
  }
  const candidateTheme = createMemo(
    () =>
      props.options.find((option) => option.id === candidate()) ??
      props.options.find((option) => option.id === savedTheme()),
  );
  // A withdrawn plugin candidate falls back to the saved choice, not a dead action.
  const candidateId = () => candidateTheme()?.id ?? savedTheme();
  // Palette revisions publish the application-owned contrast intent after rendering.
  const unsupportedContrast = createMemo(
    () =>
      props.paletteRevision !== undefined &&
      document.documentElement.dataset.contrastIntent === "enhanced" &&
      !isBuiltinThemeId(candidateId()),
  );
  const previewTheme = createMemo(() =>
    props.options.find((option) => option.id === props.preview),
  );
  const miniatureKey = () => `${inspected()}:${props.mode}:${props.paletteRevision ?? 0}`;
  const options = createMemo(() =>
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
              when={isBuiltinThemeId(option.id) || option.id === (props.preview ?? props.theme)}
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
          <span class="settings-theme-card__description">{option.description}</span>
        </>
      ),
    })),
  );
  function inspect(event: Event) {
    if (event instanceof PointerEvent && event.pointerType === "touch") {
      return;
    }
    const input = event.target;
    const option =
      input instanceof HTMLInputElement && props.options.find((entry) => entry.id === input.value);
    if (option && input instanceof HTMLInputElement) {
      focusedChoice = input;
      setInspected(option.id);
    }
  }
  function apply() {
    if (props.preview === null) {
      return;
    }
    props.onApply(props.preview);
    props.onPreview(null);
  }
  return (
    <div
      class="settings-theme-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (props.preview !== null || inspected() !== null)) {
          event.preventDefault();
          event.stopPropagation();
          setInspected(null);
          if (props.preview !== null) {
            props.onPreview(null);
          }
        }
      }}
    >
      <div onPointerOver={inspect} onFocusIn={inspect}>
        <SettingsSegmented
          class="settings-theme-grid"
          groupRef={(element) => (grid = element)}
          value={candidateId()}
          options={options()}
          ariaLabel={t("configView.appearance.themePicker")}
          descriptionId={hintId}
          onChange={(theme) => {
            setCandidate(theme);
            setInspected(theme);
          }}
          onReselect={(theme) => setInspected(theme)}
        >
          <Show when={inspectedTheme()}>
            {(inspection) => (
              <div
                class="settings-theme-miniature"
                role="region"
                aria-labelledby={miniatureId}
                style={{ "grid-row": inspectionRow() }}
              >
                <Show
                  when={
                    isBuiltinThemeId(inspection().id) ||
                    inspection().id === (props.preview ?? props.theme)
                  }
                  fallback={
                    <p class="settings-theme-card__description">
                      {t("configView.appearance.previewPaletteHint")}
                    </p>
                  }
                >
                  <Show when={miniatureKey()} keyed>
                    {(_key) => <ThemeMiniature theme={inspection().id} mode={props.mode} />}
                  </Show>
                </Show>
                <div class="settings-theme-miniature__copy">
                  <strong id={miniatureId}>
                    {t("configView.appearance.inspectingTheme", { name: inspection().label })}
                  </strong>
                  <span class="settings-theme-card__description">{inspection().description}</span>
                  <button type="button" class="btn btn--sm" onClick={closeInspection}>
                    {t("configView.appearance.closeThemeInspection")}
                  </button>
                </div>
              </div>
            )}
          </Show>
        </SettingsSegmented>
      </div>
      <div class="settings-theme-preview">
        <div class="settings-theme-preview__copy" role="status">
          <strong>
            {props.preview === null
              ? t("configView.appearance.selectedTheme", { name: candidateTheme()?.label ?? "" })
              : t("configView.appearance.previewingTheme", { name: previewTheme()?.label ?? "" })}
          </strong>
          <Show when={candidateId() !== props.theme || props.preview !== null}>
            <span>
              {t("configView.appearance.appliedTheme", {
                name: props.options.find((option) => option.id === props.theme)?.label ?? "",
              })}
            </span>
          </Show>
          <p id={hintId} class="settings-theme-keyboard-hint">
            {t("configView.appearance.themeInspectionHint")}
          </p>
          <Show when={unsupportedContrast()}>
            <p class="settings-theme-card__description">
              {t("configView.appearance.enhancedPreviewUnavailable")}
            </p>
          </Show>
        </div>
        <div class="settings-theme-preview__actions">
          <button type="button" class="btn btn--sm" onClick={() => props.onImport()}>
            {t("configView.appearance.import")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            disabled={candidateId() === props.preview}
            onClick={() => {
              setInspected(null);
              props.onPreview(candidateId());
            }}
          >
            {t("configView.appearance.previewTheme")}
          </button>
          <Show when={props.preview !== null}>
            <button type="button" class="btn btn--sm" onClick={() => props.onPreview(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              class="btn btn--sm primary"
              disabled={candidateId() !== props.preview}
              onClick={apply}
            >
              {t("configView.appearance.applyTheme")}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
