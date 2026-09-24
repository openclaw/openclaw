import {
  ErrorCodes,
  errorShape,
  validateThemesListParams,
  validateThemesGetParams,
  validateThemesSetParams,
  validateThemesImportParams,
  type ThemesGetResult,
  type ThemeSelection,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.js";
import {
  BUILTIN_THEMES,
  isThemeId,
  normalizeThemeDefinition,
  normalizeThemeMode,
  parseThemeDefinition,
  THEME_LOCAL_ID_PATTERN,
  type ThemeCatalogEntry,
  type ThemeDescriptor,
  type ThemeColorMode,
  type ThemeMode,
} from "../../../packages/gateway-protocol/src/theme.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listPluginThemes } from "../../plugins/theme-catalog.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const DEFINITION_PREFIX = "ui.themeDefinition.";
type ThemeRequest = Omit<GatewayRequestHandlerOptions, "params">;

function requestOwner(options: ThemeRequest) {
  const { client, context } = options;
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  const caller = getGatewayToolCallerIdentity();
  const capturedProfile = runtimeIdentity
    ? runtimeIdentity.gatewayUiCommandTarget?.profileId
    : client?.internal?.syntheticClient
      ? caller?.gatewayUiCommandTarget?.profileId
      : client?.authenticatedUserProfile?.profileId;
  const assertCaller = captureGatewayToolCallerAssertion();
  const profileId = capturedProfile ? resolveUserProfileId(capturedProfile) : undefined;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.sessionMutationCommitGuard?.();
    options.sessionMutationAuthorization?.assertCurrent();
    assertActiveAgentRuntimeAuthority(client, context, assertCaller);
    if (options.hasCurrentClientAuthority?.() === false || client?.invalidated) {
      throw new Error("Theme request authority is no longer active.");
    }
    if (capturedProfile && resolveUserProfileId(capturedProfile) !== profileId) {
      throw new Error("The requesting profile changed. Ask again from your current profile.");
    }
    if (
      !runtimeIdentity &&
      !client?.internal?.syntheticClient &&
      client?.authenticatedUserProfile?.profileId !== capturedProfile
    ) {
      throw new Error("The requesting profile changed. Ask again from your current profile.");
    }
  };
  assertCurrent();
  return { profileId, assertCurrent };
}

function catalogForPreferences(entries: Record<string, unknown>): ThemeCatalogEntry[] {
  const imported: ThemeCatalogEntry[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(DEFINITION_PREFIX)) {
      continue;
    }
    const localId = key.slice(DEFINITION_PREFIX.length);
    const definition = parseThemeDefinition(value);
    if (!THEME_LOCAL_ID_PATTERN.test(localId) || !definition) {
      continue;
    }
    imported.push({
      id: `user/${localId}`,
      name: definition.name,
      description: definition.description,
      ...(definition.mascot !== undefined ? { mascot: definition.mascot } : {}),
      ...(definition.workingPhrases !== undefined
        ? { workingPhrases: definition.workingPhrases }
        : {}),
      ...(definition.critters !== undefined ? { critters: definition.critters } : {}),
      ...(definition.avatarHat !== undefined ? { avatarHat: definition.avatarHat } : {}),
      source: "user",
      modes: (["light", "dark"] as const).filter((mode) => Boolean(definition[mode])),
      definition,
    });
  }
  return [
    ...BUILTIN_THEMES,
    ...listPluginThemes(),
    ...imported.toSorted((a, b) => a.id.localeCompare(b.id)),
  ];
}

function descriptor(entry: ThemeCatalogEntry): ThemeDescriptor {
  const { definition: _definition, ...metadata } = entry;
  return metadata;
}

function selectionMode(
  modes: readonly ThemeColorMode[],
  requested: ThemeMode | null | undefined,
  retained: ThemeMode,
  inherited: ThemeMode,
): ThemeMode | null | undefined {
  const effective = requested === null ? inherited : (requested ?? retained);
  if (effective === "system" || modes.includes(effective)) {
    return requested;
  }
  if (requested !== undefined) {
    throw new Error(
      `This theme does not provide ${effective} mode. Choose system or ${modes.join(" or ")}.`,
    );
  }
  // Selecting a single-mode theme also selects its palette when the old mode cannot render it.
  return modes.includes("dark") ? "dark" : "light";
}

function selection(
  entries: Record<string, unknown>,
  config: OpenClawConfig,
  catalog: ThemeCatalogEntry[],
  profileId: string | undefined,
): ThemeSelection {
  const id = isThemeId(entries["ui.theme"]) ? entries["ui.theme"] : undefined;
  const mode = normalizeThemeMode(entries["ui.themeMode"]);
  const requestedId = id ?? config.ui?.prefs?.theme ?? "claw";
  const selected = catalog.find((theme) => theme.id === requestedId);
  const effectiveTheme = selected ?? BUILTIN_THEMES[0];
  const selectedMode = mode ?? normalizeThemeMode(config.ui?.prefs?.themeMode) ?? "system";
  const effectiveMode =
    effectiveTheme?.modes.length === 1
      ? effectiveTheme.modes[0]
      : selectedMode === "system"
        ? undefined
        : selectedMode;
  return {
    id: selected ? requestedId : "claw",
    mode: selectedMode,
    ...(effectiveMode ? { effectiveMode } : {}),
    scope: profileId ? "profile" : "gateway",
    overrides: { ...(id ? { id } : {}), ...(mode ? { mode } : {}) },
    ...(!selected ? { requestedId } : {}),
  };
}

async function readThemes(
  options: ThemeRequest,
  owner: ReturnType<typeof requestOwner>,
  inspectId?: string,
) {
  const stored = owner.profileId ? await getCanonicalUserPreferences(owner.profileId) : undefined;
  owner.assertCurrent();
  if (owner.profileId && !stored) {
    throw new Error("The requesting profile is unavailable.");
  }
  const entries = stored?.entries ?? {};
  const catalog = catalogForPreferences(entries);
  const current = selection(entries, options.context.getRuntimeConfig(), catalog, owner.profileId);
  const theme = catalog.find((entry) => entry.id === (inspectId ?? current.id));
  if (!theme) {
    throw new Error(`Theme ${inspectId} is unavailable. List themes to choose an installed theme.`);
  }
  const result: ThemesGetResult = {
    current,
    theme: descriptor(theme),
    ...(theme.definition ? { definition: theme.definition } : {}),
    ...(theme.artwork ? { artwork: theme.artwork } : {}),
  };
  return { owner, entries, catalog, result };
}

async function writeThemes(
  options: ThemeRequest,
  owner: ReturnType<typeof requestOwner>,
  entries: Record<string, unknown>,
  conditions: {
    assertCatalog?: () => void;
    expectedEntries: Readonly<Record<string, unknown>>;
  },
) {
  if (!owner.profileId) {
    throw new Error(
      "Changing themes requires the requesting person's authenticated profile. Ask from your signed-in Control UI.",
    );
  }
  const written = await setCanonicalUserPreferences(owner.profileId, entries, {
    expectedEntries: conditions.expectedEntries,
    assertCurrent: () => {
      owner.assertCurrent();
      conditions.assertCatalog?.();
    },
  });
  if (!written) {
    throw new Error("The requesting profile is unavailable.");
  }
  if (!written.ok) {
    if (written.error.code === "conflict") {
      throw new Error(
        "Appearance changed while this request was being prepared. Read the current theme and try again.",
      );
    }
    throw new Error(`Theme could not be saved: ${written.error.code}.`);
  }
  publishUserPreferencesChanged(options.context, written.value.profileId, Object.keys(entries));
  return owner;
}

function failed(options: ThemeRequest, error: unknown) {
  options.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error instanceof Error ? error.message : String(error)),
  );
}

export const themeHandlers: GatewayRequestHandlers = {
  "themes.list": defineValidatedGatewayMethod(
    "themes.list",
    validateThemesListParams,
    async (options) => {
      try {
        const { catalog, result } = await readThemes(options, requestOwner(options));
        options.respond(true, { ...result, themes: catalog.map(descriptor) });
      } catch (error) {
        failed(options, error);
      }
    },
  ),
  "themes.get": defineValidatedGatewayMethod(
    "themes.get",
    validateThemesGetParams,
    async (options) => {
      try {
        options.respond(
          true,
          (await readThemes(options, requestOwner(options), options.params.id)).result,
        );
      } catch (error) {
        failed(options, error);
      }
    },
  ),
  "themes.set": defineValidatedGatewayMethod(
    "themes.set",
    validateThemesSetParams,
    async (options) => {
      try {
        const { id, mode, appearance } = options.params;
        const appearanceEntries: Record<string, unknown> = {};
        for (const key of ["accent", "fontUi", "fontChat"] as const) {
          const value = appearance?.[key];
          if (value === undefined) {
            continue;
          }
          const prefKey = UI_APPEARANCE_PREFERENCE_KEYS[key];
          const normalized =
            value === null ? null : normalizeUiAppearancePreference(prefKey, value);
          if (normalized === undefined) {
            throw new Error(`Unsupported appearance preference: ${key}.`);
          }
          appearanceEntries[prefKey] = normalized;
        }
        if (id === undefined && mode === undefined) {
          throw new Error("Set a theme id or mode; use null to restore its default.");
        }
        const owner = requestOwner(options);
        const { catalog, result, entries } = await readThemes(options, owner);
        const target = id == null ? undefined : catalog.find((theme) => theme.id === id);
        if (id != null && !target) {
          throw new Error(`Theme ${id} is unavailable. List themes to choose an installed theme.`);
        }
        const resetId = options.context.getRuntimeConfig().ui?.prefs?.theme ?? "claw";
        const selected =
          target ??
          catalog.find((theme) => theme.id === (id === null ? resetId : result.current.id));
        const nextMode = selected
          ? selectionMode(
              selected.modes,
              mode,
              result.current.mode,
              normalizeThemeMode(options.context.getRuntimeConfig().ui?.prefs?.themeMode) ??
                "system",
            )
          : mode;
        await writeThemes(
          options,
          owner,
          {
            ...appearanceEntries,
            ...(id !== undefined ? { "ui.theme": id } : {}),
            ...(nextMode !== undefined ? { "ui.themeMode": nextMode } : {}),
          },
          {
            expectedEntries: {
              "ui.theme": entries["ui.theme"] ?? null,
              "ui.themeMode": entries["ui.themeMode"] ?? null,
              ...(selected?.source === "user"
                ? {
                    [`${DEFINITION_PREFIX}${selected.id.slice("user/".length)}`]:
                      entries[`${DEFINITION_PREFIX}${selected.id.slice("user/".length)}`] ?? null,
                  }
                : {}),
            },
            assertCatalog:
              selected?.source === "plugin"
                ? () => {
                    const current = listPluginThemes().find((theme) => theme.id === selected.id);
                    if (!current || current.definition !== selected.definition) {
                      throw new Error(
                        "The theme plugin changed before selection was saved. List themes and try again.",
                      );
                    }
                  }
                : undefined,
          },
        );
        options.respond(true, {
          ...(await readThemes(options, owner)).result,
          application: "saved",
        });
      } catch (error) {
        failed(options, error);
      }
    },
  ),
  "themes.import": defineValidatedGatewayMethod(
    "themes.import",
    validateThemesImportParams,
    async (options) => {
      try {
        const { id, apply, mode } = options.params;
        const owner = requestOwner(options);
        const definition = normalizeThemeDefinition(options.params.definition);
        if (mode && mode !== "system" && !definition[mode]) {
          throw new Error(`The imported theme does not provide ${mode} mode.`);
        }
        if (mode && !apply) {
          throw new Error("Use apply: true when importing with a mode.");
        }
        const snapshot = await readThemes(options, owner);
        const current = snapshot.result.current;
        const affectsSelection = apply || (current.requestedId ?? current.id) === `user/${id}`;
        const nextMode = affectsSelection
          ? selectionMode(
              (["light", "dark"] as const).filter((palette) => Boolean(definition[palette])),
              mode,
              current.mode,
              normalizeThemeMode(options.context.getRuntimeConfig().ui?.prefs?.themeMode) ??
                "system",
            )
          : undefined;
        await writeThemes(
          options,
          owner,
          {
            [`${DEFINITION_PREFIX}${id}`]: definition,
            ...(apply ? { "ui.theme": `user/${id}` } : {}),
            ...(nextMode !== undefined ? { "ui.themeMode": nextMode } : {}),
          },
          {
            expectedEntries: {
              "ui.theme": snapshot.entries["ui.theme"] ?? null,
              "ui.themeMode": snapshot.entries["ui.themeMode"] ?? null,
            },
          },
        );
        options.respond(true, {
          ...(await readThemes(options, owner, `user/${id}`)).result,
          application: "saved",
        });
      } catch (error) {
        failed(options, error);
      }
    },
  ),
};
