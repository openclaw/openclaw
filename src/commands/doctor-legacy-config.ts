import { migrateVoiceCallLegacyConfigInput } from "../../extensions/voice-call/config-api.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { isDeepStrictEqual } from "node:util";
import { shouldMoveSingleAccountChannelKey } from "../channels/plugins/setup-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveNormalizedProviderModelMaxTokens } from "../config/defaults.js";
import { migrateLegacyWebFetchConfig } from "../config/legacy-web-fetch.js";
import { migrateLegacyWebSearchConfig } from "../config/legacy-web-search.js";
import { migrateLegacyXSearchConfig } from "../config/legacy-x-search.js";
import { LEGACY_TALK_PROVIDER_ID, normalizeTalkSection } from "../config/talk.js";
import { DEFAULT_GOOGLE_API_BASE_URL } from "../infra/google-api-base-url.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  const NANO_BANANA_SKILL_KEY = "nano-banana-pro";
  const NANO_BANANA_MODEL = "google/gemini-3-pro-image-preview";
  let next: OpenClawConfig = cfg;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const normalizeLegacyBrowserProfiles = () => {
    const rawBrowser = next.browser;
    if (!isRecord(rawBrowser)) {
      return;
    }

    const browser = structuredClone(rawBrowser);
    let browserChanged = false;

    if ("relayBindHost" in browser) {
      delete browser.relayBindHost;
      browserChanged = true;
      changes.push(
        "Removed browser.relayBindHost (legacy Chrome extension relay setting; host-local Chrome now uses Chrome MCP existing-session attach).",
      );
    }

    const rawProfiles = browser.profiles;
    if (!isRecord(rawProfiles)) {
      if (!browserChanged) {
        return;
      }
      next = { ...next, browser };
      return;
    }

    const profiles = { ...rawProfiles };
    let profilesChanged = false;
    for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
      if (!isRecord(rawProfile)) {
        continue;
      }
      const rawDriver = typeof rawProfile.driver === "string" ? rawProfile.driver.trim() : "";
      if (rawDriver !== "extension") {
        continue;
      }
      profiles[profileName] = {
        ...rawProfile,
        driver: "existing-session",
      };
      profilesChanged = true;
      changes.push(
        `Moved browser.profiles.${profileName}.driver "extension" → "existing-session" (Chrome MCP attach).`,
      );
    }

    if (profilesChanged) {
      browser.profiles = profiles;
      browserChanged = true;
    }

    if (!browserChanged) {
      return;
    }

    next = {
      ...next,
      browser,
    };
  };

  const normalizeVoiceCallLegacyConfig = () => {
    const rawVoiceCallConfig = next.plugins?.entries?.["voice-call"]?.config;
    if (!isRecord(rawVoiceCallConfig)) {
      return;
    }

    const migration = migrateVoiceCallLegacyConfigInput({
      value: rawVoiceCallConfig,
      configPathPrefix: "plugins.entries.voice-call.config",
    });
    if (migration.changes.length === 0) {
      return;
    }

    const plugins = structuredClone(next.plugins ?? {});
    const entries = { ...plugins.entries };
    const existingVoiceCallEntry = isRecord(entries["voice-call"])
      ? (entries["voice-call"] as Record<string, unknown>)
      : {};
    entries["voice-call"] = {
      ...existingVoiceCallEntry,
      config: migration.config,
    };
    plugins.entries = entries;
    next = {
      ...next,
      plugins,
    };
    changes.push(...migration.changes);
  };

  const seedMissingDefaultAccountsFromSingleAccountBase = () => {
    const channels = next.channels as Record<string, unknown> | undefined;
    if (!channels) {
      return;
    }

    let channelsChanged = false;
    const nextChannels = { ...channels };
    for (const [channelId, rawChannel] of Object.entries(channels)) {
      if (!isRecord(rawChannel)) {
        continue;
      }
      const rawAccounts = rawChannel.accounts;
      if (!isRecord(rawAccounts)) {
        continue;
      }
      const accountKeys = Object.keys(rawAccounts);
      if (accountKeys.length === 0) {
        continue;
      }
      const hasDefault = accountKeys.some((key) => key.trim().toLowerCase() === DEFAULT_ACCOUNT_ID);
      if (hasDefault) {
        continue;
      }

      const keysToMove = Object.entries(rawChannel)
        .filter(([key, value]) => {
          if (key === "accounts" || key === "enabled" || value === undefined) {
            return false;
          }
          return shouldMoveSingleAccountChannelKey({ channelKey: channelId, key });
        })
        .map(([key]) => key);
      if (keysToMove.length === 0) {
        continue;
      }

      const defaultAccount: Record<string, unknown> = {};
      for (const key of keysToMove) {
        const value = rawChannel[key];
        defaultAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
      }
      const nextChannel: Record<string, unknown> = {
        ...rawChannel,
      };
      for (const key of keysToMove) {
        delete nextChannel[key];
      }
      nextChannel.accounts = {
        ...rawAccounts,
        [DEFAULT_ACCOUNT_ID]: defaultAccount,
      };

      nextChannels[channelId] = nextChannel;
      channelsChanged = true;
      changes.push(
        `Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`,
      );
    }

    if (!channelsChanged) {
      return;
    }
    next = {
      ...next,
      channels: nextChannels as OpenClawConfig["channels"],
    };
  };

  seedMissingDefaultAccountsFromSingleAccountBase();
  normalizeLegacyBrowserProfiles();
  normalizeVoiceCallLegacyConfig();
  const webSearchMigration = migrateLegacyWebSearchConfig(next);
  if (webSearchMigration.changes.length > 0) {
    next = webSearchMigration.config;
    changes.push(...webSearchMigration.changes);
  }
  const webFetchMigration = migrateLegacyWebFetchConfig(next);
  if (webFetchMigration.changes.length > 0) {
    next = webFetchMigration.config;
    changes.push(...webFetchMigration.changes);
  }
  const xSearchMigration = migrateLegacyXSearchConfig(next);
  if (xSearchMigration.changes.length > 0) {
    next = xSearchMigration.config;
    changes.push(...xSearchMigration.changes);
  }

  const normalizeBrowserSsrFPolicyAlias = () => {
    const rawBrowser = next.browser;
    if (!isRecord(rawBrowser)) {
      return;
    }
    const rawSsrFPolicy = rawBrowser.ssrfPolicy;
    if (!isRecord(rawSsrFPolicy) || !("allowPrivateNetwork" in rawSsrFPolicy)) {
      return;
    }

    const legacyAllowPrivateNetwork = rawSsrFPolicy.allowPrivateNetwork;
    const currentDangerousAllowPrivateNetwork = rawSsrFPolicy.dangerouslyAllowPrivateNetwork;

    let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
    if (
      typeof legacyAllowPrivateNetwork === "boolean" ||
      typeof currentDangerousAllowPrivateNetwork === "boolean"
    ) {
      // Preserve runtime behavior while collapsing to the canonical key.
      resolvedDangerousAllowPrivateNetwork =
        legacyAllowPrivateNetwork === true || currentDangerousAllowPrivateNetwork === true;
    } else if (currentDangerousAllowPrivateNetwork === undefined) {
      resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
    }

    const nextSsrFPolicy: Record<string, unknown> = { ...rawSsrFPolicy };
    delete nextSsrFPolicy.allowPrivateNetwork;
    if (resolvedDangerousAllowPrivateNetwork !== undefined) {
      nextSsrFPolicy.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
    }

    const migratedBrowser = { ...next.browser } as Record<string, unknown>;
    migratedBrowser.ssrfPolicy = nextSsrFPolicy;

    next = {
      ...next,
      browser: migratedBrowser as OpenClawConfig["browser"],
    };
    changes.push(
      `Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
    );
  };

  const normalizeLegacyNanoBananaSkill = () => {
    type ModelProviderEntry = Partial<
      NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
    >;
    type ModelsConfigPatch = Partial<NonNullable<OpenClawConfig["models"]>>;

    const rawSkills = next.skills;
    if (!isRecord(rawSkills)) {
      return;
    }

    let skillsChanged = false;
    let skills = structuredClone(rawSkills);

    if (Array.isArray(skills.allowBundled)) {
      const allowBundled = skills.allowBundled.filter(
        (value) => typeof value !== "string" || value.trim() !== NANO_BANANA_SKILL_KEY,
      );
      if (allowBundled.length !== skills.allowBundled.length) {
        if (allowBundled.length === 0) {
          delete skills.allowBundled;
          changes.push(`Removed skills.allowBundled entry for ${NANO_BANANA_SKILL_KEY}.`);
        } else {
          skills.allowBundled = allowBundled;
          changes.push(`Removed ${NANO_BANANA_SKILL_KEY} from skills.allowBundled.`);
        }
        skillsChanged = true;
      }
    }

    const rawEntries = skills.entries;
    if (!isRecord(rawEntries)) {
      if (skillsChanged) {
        next = { ...next, skills };
      }
      return;
    }

    const rawLegacyEntry = rawEntries[NANO_BANANA_SKILL_KEY];
    if (!isRecord(rawLegacyEntry)) {
      if (skillsChanged) {
        next = { ...next, skills };
      }
      return;
    }

    const existingImageGenerationModel = next.agents?.defaults?.imageGenerationModel;
    if (existingImageGenerationModel === undefined) {
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: {
            ...next.agents?.defaults,
            imageGenerationModel: {
              primary: NANO_BANANA_MODEL,
            },
          },
        },
      };
      changes.push(
        `Moved skills.entries.${NANO_BANANA_SKILL_KEY} → agents.defaults.imageGenerationModel.primary (${NANO_BANANA_MODEL}).`,
      );
    }

    const legacyEnv = isRecord(rawLegacyEntry.env) ? rawLegacyEntry.env : undefined;
    const legacyEnvApiKey =
      typeof legacyEnv?.GEMINI_API_KEY === "string" ? legacyEnv.GEMINI_API_KEY.trim() : "";
    const legacyApiKey =
      legacyEnvApiKey ||
      (typeof rawLegacyEntry.apiKey === "string"
        ? rawLegacyEntry.apiKey.trim()
        : rawLegacyEntry.apiKey && isRecord(rawLegacyEntry.apiKey)
          ? structuredClone(rawLegacyEntry.apiKey)
          : undefined);

    const rawModels = (
      isRecord(next.models) ? structuredClone(next.models) : {}
    ) as ModelsConfigPatch;
    const rawProviders = (
      isRecord(rawModels.providers) ? { ...rawModels.providers } : {}
    ) as Record<string, ModelProviderEntry>;
    const rawGoogle = (
      isRecord(rawProviders.google) ? { ...rawProviders.google } : {}
    ) as ModelProviderEntry;
    const hasGoogleApiKey = rawGoogle.apiKey !== undefined;
    if (!hasGoogleApiKey && legacyApiKey) {
      rawGoogle.apiKey = legacyApiKey;
      if (!rawGoogle.baseUrl) {
        rawGoogle.baseUrl = DEFAULT_GOOGLE_API_BASE_URL;
      }
      if (!Array.isArray(rawGoogle.models)) {
        rawGoogle.models = [];
      }
      rawProviders.google = rawGoogle;
      rawModels.providers = rawProviders as NonNullable<OpenClawConfig["models"]>["providers"];
      next = {
        ...next,
        models: rawModels as OpenClawConfig["models"],
      };
      changes.push(
        `Moved skills.entries.${NANO_BANANA_SKILL_KEY}.${legacyEnvApiKey ? "env.GEMINI_API_KEY" : "apiKey"} → models.providers.google.apiKey.`,
      );
    }

    const entries = { ...rawEntries };
    delete entries[NANO_BANANA_SKILL_KEY];
    if (Object.keys(entries).length === 0) {
      delete skills.entries;
      changes.push(`Removed legacy skills.entries.${NANO_BANANA_SKILL_KEY}.`);
    } else {
      skills.entries = entries;
      changes.push(`Removed legacy skills.entries.${NANO_BANANA_SKILL_KEY}.`);
    }
    skillsChanged = true;

    if (Object.keys(skills).length === 0) {
      const { skills: _ignored, ...rest } = next;
      next = rest;
      return;
    }

    if (skillsChanged) {
      next = {
        ...next,
        skills,
      };
    }
  };

  const normalizeLegacyTalkConfig = () => {
    const rawTalk = next.talk;
    if (!isRecord(rawTalk)) {
      return;
    }

    const normalizedTalk = normalizeTalkSection(rawTalk as OpenClawConfig["talk"]);
    if (!normalizedTalk) {
      return;
    }

    const sameShape = isDeepStrictEqual(normalizedTalk, rawTalk);
    if (sameShape) {
      return;
    }

    const hasProviderShape = typeof rawTalk.provider === "string" || isRecord(rawTalk.providers);
    next = {
      ...next,
      talk: normalizedTalk,
    };

    if (hasProviderShape) {
      changes.push(
        "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
      );
      return;
    }

    changes.push(`Moved legacy talk flat fields → talk.providers.${LEGACY_TALK_PROVIDER_ID}.`);
  };

  const normalizeLegacyCrossContextMessageConfig = () => {
    const rawTools = next.tools;
    if (!isRecord(rawTools)) {
      return;
    }
    const rawMessage = rawTools.message;
    if (!isRecord(rawMessage) || !("allowCrossContextSend" in rawMessage)) {
      return;
    }

    const legacyAllowCrossContextSend = rawMessage.allowCrossContextSend;
    if (typeof legacyAllowCrossContextSend !== "boolean") {
      return;
    }

    const nextMessage = { ...rawMessage };
    delete nextMessage.allowCrossContextSend;

    if (legacyAllowCrossContextSend) {
      const rawCrossContext = isRecord(nextMessage.crossContext)
        ? structuredClone(nextMessage.crossContext)
        : {};
      rawCrossContext.allowWithinProvider = true;
      rawCrossContext.allowAcrossProviders = true;
      nextMessage.crossContext = rawCrossContext;
      changes.push(
        "Moved tools.message.allowCrossContextSend → tools.message.crossContext.allowWithinProvider/allowAcrossProviders (true).",
      );
    } else {
      changes.push(
        "Removed tools.message.allowCrossContextSend=false (default cross-context policy already matches canonical settings).",
      );
    }

    next = {
      ...next,
      tools: {
        ...next.tools,
        message: nextMessage,
      },
    };
  };

  const mapDeepgramCompatToProviderOptions = (
    rawCompat: Record<string, unknown>,
  ): Record<string, string | number | boolean> => {
    const providerOptions: Record<string, string | number | boolean> = {};
    if (typeof rawCompat.detectLanguage === "boolean") {
      providerOptions.detect_language = rawCompat.detectLanguage;
    }
    if (typeof rawCompat.punctuate === "boolean") {
      providerOptions.punctuate = rawCompat.punctuate;
    }
    if (typeof rawCompat.smartFormat === "boolean") {
      providerOptions.smart_format = rawCompat.smartFormat;
    }
    return providerOptions;
  };

  const migrateLegacyDeepgramCompat = (params: {
    owner: Record<string, unknown>;
    pathPrefix: string;
  }): boolean => {
    const rawCompat = isRecord(params.owner.deepgram)
      ? structuredClone(params.owner.deepgram)
      : null;
    if (!rawCompat) {
      return false;
    }

    const compatProviderOptions = mapDeepgramCompatToProviderOptions(rawCompat);
    const currentProviderOptions = isRecord(params.owner.providerOptions)
      ? structuredClone(params.owner.providerOptions)
      : {};
    const currentDeepgram = isRecord(currentProviderOptions.deepgram)
      ? structuredClone(currentProviderOptions.deepgram)
      : {};
    const mergedDeepgram = { ...compatProviderOptions, ...currentDeepgram };

    delete params.owner.deepgram;
    currentProviderOptions.deepgram = mergedDeepgram;
    params.owner.providerOptions = currentProviderOptions;

    const hadCanonicalDeepgram = Object.keys(currentDeepgram).length > 0;
    changes.push(
      hadCanonicalDeepgram
        ? `Merged ${params.pathPrefix}.deepgram → ${params.pathPrefix}.providerOptions.deepgram (filled missing canonical fields from legacy).`
        : `Moved ${params.pathPrefix}.deepgram → ${params.pathPrefix}.providerOptions.deepgram.`,
    );
    return true;
  };

  const normalizeLegacyMediaProviderOptions = () => {
    const rawTools = next.tools;
    if (!isRecord(rawTools)) {
      return;
    }
    const rawMedia = rawTools.media;
    if (!isRecord(rawMedia)) {
      return;
    }

    let mediaChanged = false;
    const nextMedia = structuredClone(rawMedia);
    const migrateModelList = (models: unknown, pathPrefix: string): boolean => {
      if (!Array.isArray(models)) {
        return false;
      }
      let changed = false;
      for (const [index, entry] of models.entries()) {
        if (!isRecord(entry)) {
          continue;
        }
        if (
          migrateLegacyDeepgramCompat({
            owner: entry,
            pathPrefix: `${pathPrefix}[${index}]`,
          })
        ) {
          changed = true;
        }
      }
      return changed;
    };

    for (const capability of ["audio", "image", "video"] as const) {
      const config = isRecord(nextMedia[capability])
        ? structuredClone(nextMedia[capability])
        : null;
      if (!config) {
        continue;
      }
      let configChanged = false;
      if (migrateLegacyDeepgramCompat({ owner: config, pathPrefix: `tools.media.${capability}` })) {
        configChanged = true;
      }
      if (migrateModelList(config.models, `tools.media.${capability}.models`)) {
        configChanged = true;
      }
      if (configChanged) {
        nextMedia[capability] = config;
        mediaChanged = true;
      }
    }

    if (migrateModelList(nextMedia.models, "tools.media.models")) {
      mediaChanged = true;
    }

    if (!mediaChanged) {
      return;
    }

    next = {
      ...next,
      tools: {
        ...next.tools,
        media: nextMedia as NonNullable<OpenClawConfig["tools"]>["media"],
      },
    };
  };

  const normalizeLegacyMistralModelMaxTokens = () => {
    const rawProviders = next.models?.providers;
    if (!isRecord(rawProviders)) {
      return;
    }

    let providersChanged = false;
    const nextProviders = { ...rawProviders };
    for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
      if (normalizeProviderId(providerId) !== "mistral" || !isRecord(rawProvider)) {
        continue;
      }
      const rawModels = rawProvider.models;
      if (!Array.isArray(rawModels)) {
        continue;
      }

      let modelsChanged = false;
      const nextModels = rawModels.map((model, index) => {
        if (!isRecord(model)) {
          return model;
        }
        const modelId = typeof model.id === "string" ? model.id.trim() : "";
        const contextWindow =
          typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
            ? model.contextWindow
            : null;
        const maxTokens =
          typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
            ? model.maxTokens
            : null;
        if (!modelId || contextWindow === null || maxTokens === null) {
          return model;
        }

        const normalizedMaxTokens = resolveNormalizedProviderModelMaxTokens({
          providerId,
          modelId,
          contextWindow,
          rawMaxTokens: maxTokens,
        });
        if (normalizedMaxTokens === maxTokens) {
          return model;
        }

        modelsChanged = true;
        changes.push(
          `Normalized models.providers.${providerId}.models[${index}].maxTokens (${maxTokens} → ${normalizedMaxTokens}) to avoid Mistral context-window rejects.`,
        );
        return {
          ...model,
          maxTokens: normalizedMaxTokens,
        };
      });

      if (!modelsChanged) {
        continue;
      }

      nextProviders[providerId] = {
        ...rawProvider,
        models: nextModels,
      };
      providersChanged = true;
    }

    if (!providersChanged) {
      return;
    }

    next = {
      ...next,
      models: {
        ...next.models,
        providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
      },
    };
  };

  normalizeBrowserSsrFPolicyAlias();
  normalizeLegacyNanoBananaSkill();
  normalizeLegacyTalkConfig();
  normalizeLegacyCrossContextMessageConfig();
  normalizeLegacyMediaProviderOptions();
  normalizeLegacyMistralModelMaxTokens();

  return { config: next, changes };
}
