import type {
  ThemesGetResult,
  ThemesListResult,
} from "../../../packages/gateway-protocol/src/schema/themes.ts";
import {
  isBuiltinThemeId,
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
  read?: {
    scope: object;
    result: Promise<ThemeCatalogSnapshot | undefined>;
  };
};

export type CatalogTheme = {
  branding: ThemeBranding;
  mode?: ThemeColorMode;
  palette: Pick<ImportedCustomTheme, "light" | "dark">;
};

/** Connection-scoped projection; profile preferences remain the selection owner. */
export function createThemeCatalog(
  gateway: ApplicationGateway,
  onChange: () => void,
  onRead?: () => void,
) {
  let snapshot: ThemeCatalogSnapshot = { themes: [], error: null };
  let ownerScope = gateway.connection.gatewayUrl;
  let ownerClient = gateway.snapshot.client;
  let ownerProfile = gateway.snapshot.selfUser?.id;
  let ownerConnected = gateway.snapshot.phase === "connected";
  let disposed = false;
  const definitions = new Map<string, CatalogTheme>();
  const definitionErrors = new Map<string, string>();
  const requested = new Set<string>();
  let readScope = {};
  let retired = Promise.withResolvers<void>();
  let catalogRead: Promise<void> | undefined;
  const definitionReads = new Map<ThemeName, Promise<void>>();
  const reads = new Map<ThemeName, NonNullable<ThemeCatalogSnapshot["read"]>>();
  const retireReads = () => {
    retired.resolve();
    retired = Promise.withResolvers<void>();
    readScope = {};
    catalogRead = undefined;
    definitionReads.clear();
    reads.clear();
  };
  const readSnapshot = (theme: ThemeName): ThemeCatalogSnapshot => {
    const error = snapshot.error ?? definitionErrors.get(theme) ?? null;
    return error === snapshot.error ? snapshot : { ...snapshot, error };
  };

  const remainsCurrent = (client: ApplicationGateway["snapshot"]["client"], profile?: string) =>
    !disposed &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === client &&
    gateway.snapshot.selfUser?.id === profile;

  const rememberDefinition = (result: ThemesGetResult) => {
    const definition = result.definition;
    const artwork = result.theme.source === "plugin" ? result.theme.artwork : undefined;
    const light = definition?.light ?? definition?.dark;
    const dark = definition?.dark ?? definition?.light;
    if (definition && light && dark) {
      definitionErrors.delete(result.theme.id);
      definitions.set(result.theme.id, {
        branding: { ...resolveThemeBranding(definition), ...(artwork ? { artwork } : {}) },
        mode: !definition.light ? "dark" : !definition.dark ? "light" : undefined,
        palette: {
          light: normalizeThemePalette("light", light, undefined),
          dark: normalizeThemePalette("dark", dark, undefined),
        },
      });
      requested.add(result.theme.id);
    }
  };

  const refresh = () => {
    const client = gateway.snapshot.client;
    if (disposed || gateway.snapshot.phase !== "connected" || !client) {
      return undefined;
    }
    ownerClient = client;
    ownerProfile = gateway.snapshot.selfUser?.id;
    const profile = ownerProfile;
    requested.clear();
    definitionErrors.clear();
    definitionReads.clear();
    const operation = (async () => {
      try {
        const result = await client.request<ThemesListResult>("themes.list", {});
        if (!remainsCurrent(client, profile)) {
          return;
        }
        const available = new Set<string>(result.themes.map((theme) => theme.id));
        for (const entries of [definitions, definitionErrors]) {
          for (const id of entries.keys()) {
            if (!available.has(id)) {
              entries.delete(id);
            }
          }
        }
        rememberDefinition(result);
        snapshot = {
          themes: result.themes,
          error: null,
          unavailableId: result.current.requestedId,
        };
        onChange();
      } catch (error) {
        if (remainsCurrent(client, profile)) {
          snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) };
          onChange();
        }
      }
    })();
    catalogRead = operation;
    reads.clear();
    onRead?.();
    return operation;
  };

  const ensureDefinition = (id: ThemeName) => {
    const client = gateway.snapshot.client;
    if (
      id === "custom" ||
      isBuiltinThemeId(id) ||
      requested.has(id) ||
      !snapshot.themes.some((theme) => theme.id === id) ||
      gateway.snapshot.phase !== "connected" ||
      !client
    ) {
      return;
    }
    requested.add(id);
    const profile = gateway.snapshot.selfUser?.id;
    const operation = client.request<ThemesGetResult>("themes.get", { id }).then(
      (result) => {
        if (!remainsCurrent(client, profile)) {
          return;
        }
        rememberDefinition(result);
        onChange();
      },
      (error: unknown) => {
        if (remainsCurrent(client, profile)) {
          definitionErrors.set(id, error instanceof Error ? error.message : String(error));
          onChange();
        }
      },
    );
    definitionReads.set(id, operation);
    reads.delete(id);
    onRead?.();
  };

  const clear = () => {
    definitions.clear();
    definitionErrors.clear();
    requested.clear();
    snapshot = { themes: [], error: null };
    onChange();
  };
  // Retire profile-scoped catalog data immediately when connection ownership changes.
  const stopGateway = gateway.subscribe(() => {
    const connected = gateway.snapshot.phase === "connected";
    const scopeChanged = gateway.connection.gatewayUrl !== ownerScope;
    if (!connected) {
      if (ownerConnected || scopeChanged) {
        retireReads();
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
      retireReads();
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
    if (
      event.event === "plugins.changed" ||
      (event.event === "users.prefs.changed" && gateway.snapshot.selfUser?.id)
    ) {
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
      const value = readSnapshot(theme);
      if (!catalogRead && !definitionReads.has(theme)) {
        return value;
      }
      let read = reads.get(theme);
      if (!read) {
        const scope = readScope;
        read = {
          scope,
          // A held previous selection must not delay the current palette.
          result: Promise.race([
            Promise.all([catalogRead, definitionReads.get(theme)]),
            retired.promise,
          ]).then(() => (!disposed && scope === readScope ? readSnapshot(theme) : undefined)),
        };
        reads.set(theme, read);
      }
      return { ...value, read };
    },
    theme(id: ThemeName) {
      ensureDefinition(id);
      return definitions.get(id);
    },
    refresh,
    dispose() {
      disposed = true;
      retireReads();
      stopGateway();
      stopEvents();
      definitions.clear();
      definitionErrors.clear();
    },
  };
}
