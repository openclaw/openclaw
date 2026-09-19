import type {
  ApplicationGateway,
  ApplicationTheme,
  ApplicationThemeServerSelection,
} from "./context.ts";
import { applyControlUiAccent, syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import {
  bindUiPreferences,
  loadUiPreferences,
  patchSettings,
  settingsKeyForGateway,
  type UiPreferences,
  type UiSettings,
} from "./settings.ts";
import type { CatalogTheme, createThemeCatalog, ThemeCatalogSnapshot } from "./theme-catalog.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, syncThemePaletteStylesheet, type ThemeMode } from "./theme.ts";
import {
  applyChatFontSmoothing,
  applyTypefaceOverrides,
  resolveTypefaces,
  syncTypefaceStylesheets,
} from "./typography.ts";

function applyThemePresentation(settings: UiPreferences, catalogTheme?: CatalogTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const dynamic = settings.theme.includes("/");
  const effectiveTheme = dynamic && !catalogTheme ? "claw" : settings.theme;
  const mode = catalogTheme?.mode ?? settings.themeMode;
  const resolvedTheme = resolveTheme(effectiveTheme, mode);
  root.dataset.themeId = effectiveTheme;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark";
  // Plugin semantic styles select on [data-theme-resolved]; keep it in lockstep
  // with data-theme-mode before their lazy stylesheet loads.
  root.dataset.themeResolved = root.dataset.themeMode;
  root.classList.toggle("wa-light", root.dataset.themeMode === "light");
  root.classList.toggle("wa-dark", root.dataset.themeMode === "dark");
  root.style.colorScheme = root.dataset.themeMode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
  const typefaces = resolveTypefaces(effectiveTheme, settings.fontUi, settings.fontChat);
  syncTypefaceStylesheets(typefaces);
  applyTypefaceOverrides(settings.fontUi, settings.fontChat);
  applyChatFontSmoothing(typefaces.chat);
  syncCustomThemeStyleTag(catalogTheme?.palette ?? settings.customTheme);
  applyControlUiAccent(settings.accent);
  syncControlUiSystemChrome();
}

export function createApplicationTheme(
  initialSettings: UiSettings,
  gateway: ApplicationGateway,
): ApplicationTheme & { dispose: () => void } {
  const { token: _token, ...initialPreferences } = initialSettings;
  let settings: UiPreferences = initialPreferences;
  let serverSelection: ApplicationThemeServerSelection | null = null;
  let systemThemeCleanup: (() => void) | undefined;
  let chromeBreakpointCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  let presentationGeneration = 0;
  let catalog: ReturnType<typeof createThemeCatalog> | undefined;
  let catalogLoading = false;
  let catalogRequested = false;
  let catalogLoadError: ThemeCatalogSnapshot | undefined;
  let disposed = false;
  const publish = () => {
    const generation = ++presentationGeneration;
    syncThemePaletteStylesheet(settings.theme, () => {
      // A slower palette cannot overwrite a newer selection or a disposed app.
      if (generation !== presentationGeneration) {
        return;
      }
      applyThemePresentation(settings, catalog?.theme(settings.theme));
    });
    // Live preferences cannot wait for a palette download. Presentation keeps
    // its own generation fence; subscribers consume the new snapshot now.
    for (const listener of listeners) {
      listener();
    }
  };

  const loadCatalog = async () => {
    if (
      disposed ||
      catalog ||
      catalogLoading ||
      gateway.snapshot.phase !== "connected" ||
      (!catalogRequested && !settings.theme.includes("/"))
    ) {
      return;
    }
    catalogLoading = true;
    try {
      const { createThemeCatalog } = await import("./theme-catalog.ts");
      if (!disposed) {
        catalog = createThemeCatalog(gateway, publish);
        catalogLoadError = undefined;
      }
    } catch (error) {
      if (!disposed) {
        catalogLoadError = {
          themes: [],
          error: error instanceof Error ? error.message : String(error),
        };
        publish();
      }
    } finally {
      catalogLoading = false;
    }
  };

  const detachSystemThemeListener = () => {
    systemThemeCleanup?.();
    systemThemeCleanup = undefined;
  };

  const syncSystemThemeListener = () => {
    detachSystemThemeListener();
    if (settings.themeMode !== "system" || typeof globalThis.matchMedia !== "function") {
      return;
    }
    const mediaQuery = globalThis.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (settings.themeMode === "system") {
        publish();
      }
    };
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      systemThemeCleanup = () => mediaQuery.removeEventListener("change", onChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      systemThemeCleanup = () => mediaQuery.removeListener(onChange);
    }
  };

  if (typeof globalThis.matchMedia === "function") {
    const mediaQuery = globalThis.matchMedia(
      "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    );
    const onChange = () => syncControlUiSystemChrome();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      chromeBreakpointCleanup = () => mediaQuery.removeEventListener("change", onChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      chromeBreakpointCleanup = () => mediaQuery.removeListener(onChange);
    }
  }

  const refresh = () => {
    const next = loadUiPreferences(gateway.connection.gatewayUrl);
    if (JSON.stringify(next) === JSON.stringify(settings)) {
      return;
    }
    settings = next;
    void loadCatalog();
    publish();
    syncSystemThemeListener();
  };
  const stopPreferences = bindUiPreferences({
    gatewayUrl: () => gateway.connection.gatewayUrl,
    refresh,
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === settingsKeyForGateway(gateway.connection.gatewayUrl)) {
      refresh();
    }
  };
  globalThis.addEventListener?.("storage", onStorage);
  const stopGateway = gateway.subscribe(() => {
    void loadCatalog();
    if (settings.gatewayUrl !== gateway.connection.gatewayUrl) {
      refresh();
    }
  });
  syncSystemThemeListener();
  publish();
  void loadCatalog();

  return {
    get catalog() {
      if (!catalogRequested) {
        catalogRequested = true;
        void loadCatalog();
      }
      return catalog?.snapshot ?? catalogLoadError;
    },
    get settings() {
      return settings;
    },
    get mode() {
      return settings.themeMode;
    },
    get resolvedMode() {
      const mode = catalog?.theme(settings.theme)?.mode ?? settings.themeMode;
      return resolveTheme(settings.theme, mode).endsWith("light") ? "light" : "dark";
    },
    get serverSelection() {
      return serverSelection;
    },
    recordServerSelection(theme, scope) {
      serverSelection = { revision: (serverSelection?.revision ?? 0) + 1, scope, theme };
      publish();
    },
    setMode(mode: ThemeMode, element) {
      const currentTheme = resolveTheme(settings.theme, settings.themeMode);
      const nextTheme = resolveTheme(settings.theme, mode);
      startThemeTransition({
        nextTheme,
        currentTheme,
        context: { element },
        applyTheme: () => {
          patchSettings({ themeMode: mode });
        },
      });
    },
    refresh,
    retryCatalog() {
      void (catalog?.refresh() ?? loadCatalog());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      catalog?.dispose();
      stopPreferences();
      globalThis.removeEventListener?.("storage", onStorage);
      stopGateway();
      presentationGeneration += 1;
      detachSystemThemeListener();
      chromeBreakpointCleanup?.();
      listeners.clear();
    },
  };
}
