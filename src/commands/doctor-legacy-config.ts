import { normalizeProviderId } from "../agents/model-selection.js";
import { shouldMoveSingleAccountChannelKey } from "../channels/plugins/setup-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveNormalizedProviderModelMaxTokens } from "../config/defaults.js";
import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "../config/discord-preview-streaming.js";
import { migrateLegacyWebSearchConfig } from "../config/legacy-web-search.js";
import { LEGACY_TALK_PROVIDER_ID, normalizeTalkSection } from "../config/talk.js";
import { DEFAULT_GOOGLE_API_BASE_URL } from "../infra/google-api-base-url.js";
import { isRecord } from "../utils.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  const NANO_BANANA_SKILL_KEY = "nano-banana-pro";
  const NANO_BANANA_MODEL = "google/gemini-3-pro-image-preview";
  let next: OpenClawConfig = cfg;

  const normalizeDmAliases = (params: {
    provider: "slack" | "discord";
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let changed = false;
    let updated: Record<string, unknown> = params.entry;
    const rawDm = updated.dm;
    const dm = isRecord(rawDm) ? structuredClone(rawDm) : null;
    let dmChanged = false;

    const allowFromEqual = (a: unknown, b: unknown): boolean => {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return false;
      }
      const na = a.map((v) => String(v).trim()).filter(Boolean);
      const nb = b.map((v) => String(v).trim()).filter(Boolean);
      if (na.length !== nb.length) {
        return false;
      }
      return na.every((v, i) => v === nb[i]);
    };

    const topDmPolicy = updated.dmPolicy;
    const legacyDmPolicy = dm?.policy;
    if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
      updated = { ...updated, dmPolicy: legacyDmPolicy };
      changed = true;
      if (dm) {
        delete dm.policy;
        dmChanged = true;
      }
      changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
    } else if (topDmPolicy !== undefined && legacyDmPolicy !== undefined) {
      if (topDmPolicy === legacyDmPolicy) {
        if (dm) {
          delete dm.policy;
          dmChanged = true;
          changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
        }
      }
    }

    const topAllowFrom = updated.allowFrom;
    const legacyAllowFrom = dm?.allowFrom;
    if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
      updated = { ...updated, allowFrom: legacyAllowFrom };
      changed = true;
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
      }
      changes.push(`Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`);
    } else if (topAllowFrom !== undefined && legacyAllowFrom !== undefined) {
      if (allowFromEqual(topAllowFrom, legacyAllowFrom)) {
        if (dm) {
          delete dm.allowFrom;
          dmChanged = true;
          changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
        }
      }
    }

    if (dm && isRecord(rawDm) && dmChanged) {
      const keys = Object.keys(dm);
      if (keys.length === 0) {
        if (updated.dm !== undefined) {
          const { dm: _ignored, ...rest } = updated;
          updated = rest;
          changed = true;
          changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
        }
      } else {
        updated = { ...updated, dm };
        changed = true;
      }
    }

    return { entry: updated, changed };
  };

  const normalizePreviewStreamingAliases = (params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    resolveStreaming: (entry: Record<string, unknown>) => string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let updated = params.entry;
    const hadLegacyStreamMode = updated.streamMode !== undefined;
    const beforeStreaming = updated.streaming;
    const resolved = params.resolveStreaming(updated);
    const shouldNormalize =
      hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      (typeof beforeStreaming === "string" && beforeStreaming !== resolved);
    if (!shouldNormalize) {
      return { entry: updated, changed: false };
    }

    let changed = false;
    if (beforeStreaming !== resolved) {
      updated = { ...updated, streaming: resolved };
      changed = true;
    }
    if (hadLegacyStreamMode) {
      const { streamMode: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
      changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
      );
    }
    if (typeof beforeStreaming === "boolean") {
      changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
    } else if (typeof beforeStreaming === "string" && beforeStreaming !== resolved) {
      changes.push(
        `Normalized ${params.pathPrefix}.streaming (${beforeStreaming}) → (${resolved}).`,
      );
    }
    if (
      params.pathPrefix.startsWith("channels.discord") &&
      resolved === "off" &&
      hadLegacyStreamMode
    ) {
      changes.push(
        `${params.pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${params.pathPrefix}.streaming="partial" to opt in explicitly.`,
      );
    }

    return { entry: updated, changed };
  };

  const normalizeSlackStreamingAliases = (params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let updated = params.entry;
    const hadLegacyStreamMode = updated.streamMode !== undefined;
    const legacyStreaming = updated.streaming;
    const beforeStreaming = updated.streaming;
    const beforeNativeStreaming = updated.nativeStreaming;
    const resolvedStreaming = resolveSlackStreamingMode(updated);
    const resolvedNativeStreaming = resolveSlackNativeStreaming(updated);
    const shouldNormalize =
      hadLegacyStreamMode ||
      typeof legacyStreaming === "boolean" ||
      (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming);
    if (!shouldNormalize) {
      return { entry: updated, changed: false };
    }

    let changed = false;
    if (beforeStreaming !== resolvedStreaming) {
      updated = { ...updated, streaming: resolvedStreaming };
      changed = true;
    }
    if (
      typeof beforeNativeStreaming !== "boolean" ||
      beforeNativeStreaming !== resolvedNativeStreaming
    ) {
      updated = { ...updated, nativeStreaming: resolvedNativeStreaming };
      changed = true;
    }
    if (hadLegacyStreamMode) {
      const { streamMode: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
      changes.push(formatSlackStreamModeMigrationMessage(params.pathPrefix, resolvedStreaming));
    }
    if (typeof legacyStreaming === "boolean") {
      changes.push(
        formatSlackStreamingBooleanMigrationMessage(params.pathPrefix, resolvedNativeStreaming),
      );
    } else if (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming) {
      changes.push(
        `Normalized ${params.pathPrefix}.streaming (${legacyStreaming}) → (${resolvedStreaming}).`,
      );
    }

    return { entry: updated, changed };
  };

  const normalizeStreamingAliasesForProvider = (params: {
    provider: "telegram" | "slack" | "discord";
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    if (params.provider === "telegram") {
      return normalizePreviewStreamingAliases({
        entry: params.entry,
        pathPrefix: params.pathPrefix,
        resolveStreaming: resolveTelegramPreviewStreamMode,
      });
    }
    if (params.provider === "discord") {
      return normalizePreviewStreamingAliases({
        entry: params.entry,
        pathPrefix: params.pathPrefix,
        resolveStreaming: resolveDiscordPreviewStreamMode,
      });
    }
    return normalizeSlackStreamingAliases({
      entry: params.entry,
      pathPrefix: params.pathPrefix,
    });
  };

  const normalizeProvider = (provider: "telegram" | "slack" | "discord") => {
    const channels = next.channels as Record<string, unknown> | undefined;
    const rawEntry = channels?.[provider];
    if (!isRecord(rawEntry)) {
      return;
    }

    let updated = rawEntry;
    let changed = false;
    if (provider !== "telegram") {
      const base = normalizeDmAliases({
        provider,
        entry: rawEntry,
        pathPrefix: `channels.${provider}`,
      });
      updated = base.entry;
      changed = base.changed;
    }
    const providerStreaming = normalizeStreamingAliasesForProvider({
      provider,
      entry: updated,
      pathPrefix: `channels.${provider}`,
    });
    updated = providerStreaming.entry;
    changed = changed || providerStreaming.changed;

    const rawAccounts = updated.accounts;
    if (isRecord(rawAccounts)) {
      let accountsChanged = false;
      const accounts = { ...rawAccounts };
      for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
        if (!isRecord(rawAccount)) {
          continue;
        }
        let accountEntry = rawAccount;
        let accountChanged = false;
        if (provider !== "telegram") {
          const res = normalizeDmAliases({
            provider,
            entry: rawAccount,
            pathPrefix: `channels.${provider}.accounts.${accountId}`,
          });
          accountEntry = res.entry;
          accountChanged = res.changed;
        }
        const accountStreaming = normalizeStreamingAliasesForProvider({
          provider,
          entry: accountEntry,
          pathPrefix: `channels.${provider}.accounts.${accountId}`,
        });
        accountEntry = accountStreaming.entry;
        accountChanged = accountChanged || accountStreaming.changed;
        if (accountChanged) {
          accounts[accountId] = accountEntry;
          accountsChanged = true;
        }
      }
      if (accountsChanged) {
        updated = { ...updated, accounts };
        changed = true;
      }
    }

    if (changed) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          [provider]: updated as unknown,
        },
      };
    }
  };

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
        .filter(
          ([key, value]) =>
            key !== "accounts" &&
            key !== "enabled" &&
            value !== undefined &&
            shouldMoveSingleAccountChannelKey({ channelKey: channelId, key }),
        )
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

  normalizeProvider("telegram");
  normalizeProvider("slack");
  normalizeProvider("discord");
  seedMissingDefaultAccountsFromSingleAccountBase();
  normalizeLegacyBrowserProfiles();
  const webSearchMigration = migrateLegacyWebSearchConfig(next);
  if (webSearchMigration.changes.length > 0) {
    next = webSearchMigration.config;
    changes.push(...webSearchMigration.changes);
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

    const sameShape = JSON.stringify(normalizedTalk) === JSON.stringify(rawTalk);
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

  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  const hasWhatsAppConfig = cfg.channels?.whatsapp !== undefined;
  if (legacyAckReaction && hasWhatsAppConfig) {
    const hasWhatsAppAck = cfg.channels?.whatsapp?.ackReaction !== undefined;
    if (!hasWhatsAppAck) {
      const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      let direct = true;
      let group: "always" | "mentions" | "never" = "mentions";
      if (legacyScope === "all") {
        direct = true;
        group = "always";
      } else if (legacyScope === "direct") {
        direct = true;
        group = "never";
      } else if (legacyScope === "group-all") {
        direct = false;
        group = "always";
      } else if (legacyScope === "group-mentions") {
        direct = false;
        group = "mentions";
      }
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            ackReaction: { emoji: legacyAckReaction, direct, group },
          },
        },
      };
      changes.push(
        `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
      );
    }
  }

  return { config: next, changes };
}
