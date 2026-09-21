import type {
  ThemesGetResult,
  ThemesListResult,
} from "../../../packages/gateway-protocol/src/schema/themes.ts";
import {
  isBuiltinThemeId,
  parseThemeDefinition,
  resolveThemeBranding,
  type ThemeBranding,
  type ThemeColorMode,
  type ThemeDescriptor,
} from "../../../packages/gateway-protocol/src/theme.ts";
import type { ImportedCustomTheme } from "./custom-theme.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { normalizeThemePalette } from "./theme-palette.ts";
import type { ThemeName } from "./theme.ts";

export type ThemeCatalogSnapshot = {
  themes: readonly ThemeDescriptor[];
  error: string | null;
  unavailableId?: string;
};

export type CatalogTheme = {
  branding: ThemeBranding;
  mode?: ThemeColorMode;
  palette: Pick<ImportedCustomTheme, "light" | "dark">;
};

/** Connection-scoped projection; profile preferences remain the selection owner. */
export function createThemeCatalog(gateway: ApplicationGateway, onChange: () => void) {
  let snapshot: ThemeCatalogSnapshot = { themes: [], error: null };
  let ownerScope = gateway.connection.gatewayUrl;
  let ownerClient = gateway.snapshot.client;
  let ownerProfile = gateway.snapshot.selfUser?.id;
  let ownerConnected = gateway.snapshot.phase === "connected";
  let generation = 0;
  let disposed = false;
  const definitions = new Map<string, { generation: number; theme: CatalogTheme }>();
  const definitionErrors = new Map<string, string>();
  const requested = new Set<string>();

  const remainsCurrent = (request: number) =>
    !disposed &&
    request === generation &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === ownerClient &&
    gateway.snapshot.selfUser?.id === ownerProfile;

  const rememberDefinition = (result: ThemesGetResult) => {
    const definition = parseThemeDefinition(result.definition);
    const light = definition?.light ?? definition?.dark;
    const dark = definition?.dark ?? definition?.light;
    if (definition && light && dark) {
      definitionErrors.delete(result.theme.id);
      definitions.set(result.theme.id, {
        generation,
        theme: {
          branding: resolveThemeBranding(definition),
          mode: !definition.light ? "dark" : !definition.dark ? "light" : undefined,
          palette: {
            light: normalizeThemePalette("light", light, undefined),
            dark: normalizeThemePalette("dark", dark, undefined),
          },
        },
      });
    }
  };

  const refresh = async () => {
    const client = gateway.snapshot.client;
    if (disposed || gateway.snapshot.phase !== "connected" || !client) {
      return;
    }
    ownerClient = client;
    ownerProfile = gateway.snapshot.selfUser?.id;
    const request = ++generation;
    requested.clear();
    definitionErrors.clear();
    try {
      const result = await client.request<ThemesListResult>("themes.list", {});
      if (!remainsCurrent(request)) {
        return;
      }
      const available = new Set<string>(result.themes.map((theme) => theme.id));
      for (const id of definitions.keys()) {
        if (!available.has(id)) {
          definitions.delete(id);
        }
      }
      for (const id of definitionErrors.keys()) {
        if (!available.has(id)) {
          definitionErrors.delete(id);
        }
      }
      rememberDefinition(result);
      snapshot = { themes: result.themes, error: null, unavailableId: result.current.requestedId };
      onChange();
    } catch (error) {
      if (remainsCurrent(request)) {
        snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) };
        onChange();
      }
    }
  };

  const ensureDefinition = (id: ThemeName) => {
    const client = gateway.snapshot.client;
    if (
      id === "custom" ||
      isBuiltinThemeId(id) ||
      definitions.get(id)?.generation === generation ||
      requested.has(id) ||
      !snapshot.themes.some((theme) => theme.id === id) ||
      gateway.snapshot.phase !== "connected" ||
      !client
    ) {
      return;
    }
    requested.add(id);
    const request = generation;
    const remainsAvailable = () =>
      remainsCurrent(request) && snapshot.themes.some((theme) => theme.id === id);
    void client.request<ThemesGetResult>("themes.get", { id }).then(
      (result) => {
        if (!remainsAvailable()) {
          return;
        }
        rememberDefinition(result);
        onChange();
      },
      (error: unknown) => {
        if (remainsAvailable()) {
          definitionErrors.set(id, error instanceof Error ? error.message : String(error));
          onChange();
        }
      },
    );
  };

  const clear = () => {
    definitions.clear();
    definitionErrors.clear();
    requested.clear();
    snapshot = { themes: [], error: null };
    onChange();
  };
  const stopGateway = gateway.subscribe(() => {
    const connected = gateway.snapshot.phase === "connected";
    const scopeChanged = gateway.connection.gatewayUrl !== ownerScope;
    if (!connected) {
      if (ownerConnected || scopeChanged) {
        generation += 1;
      }
      ownerConnected = false;
      if (scopeChanged) {
        ownerScope = gateway.connection.gatewayUrl;
        ownerProfile = undefined;
        ownerClient = null;
        clear();
      }
      return;
    }
    if (
      !ownerConnected ||
      scopeChanged ||
      gateway.snapshot.client !== ownerClient ||
      gateway.snapshot.selfUser?.id !== ownerProfile
    ) {
      generation += 1;
      const profileChanged = gateway.snapshot.selfUser?.id !== ownerProfile;
      ownerConnected = true;
      ownerScope = gateway.connection.gatewayUrl;
      ownerClient = gateway.snapshot.client;
      ownerProfile = gateway.snapshot.selfUser?.id;
      if (scopeChanged || profileChanged) {
        clear();
      }
      void refresh();
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event === "plugins.changed") {
      void refresh();
    } else if (event.event === "users.prefs.changed" && gateway.snapshot.selfUser?.id) {
      void refresh();
    }
  });

  // The application creates this cache before assigning it to its theme owner.
  if (ownerConnected) {
    queueMicrotask(() => {
      if (!disposed) {
        void refresh();
      }
    });
  }

  return {
    snapshot(theme: ThemeName): ThemeCatalogSnapshot {
      const error = snapshot.error ?? definitionErrors.get(theme) ?? null;
      return error === snapshot.error ? snapshot : { ...snapshot, error };
    },
    theme(id: ThemeName) {
      ensureDefinition(id);
      return definitions.get(id)?.theme;
    },
    refresh,
    dispose() {
      disposed = true;
      generation += 1;
      stopGateway();
      stopEvents();
      definitions.clear();
      definitionErrors.clear();
    },
  };
}
