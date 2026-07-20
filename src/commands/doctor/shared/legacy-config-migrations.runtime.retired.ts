// Retired runtime config keys that migrate or disappear before canonical validation.
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const rule = (
  path: string[],
  message: string,
  match?: LegacyConfigRule["match"],
): LegacyConfigRule => ({
  path,
  message: `${message} Run "openclaw doctor --fix".`,
  ...(match ? { match } : {}),
});

function moveVoice(owner: Record<string, unknown>, path: string, changes: string[]): void {
  if (!Object.hasOwn(owner, "voice")) {
    return;
  }
  if (owner.speakerVoice === undefined) {
    owner.speakerVoice = owner.voice;
    changes.push(`Moved ${path}.voice → ${path}.speakerVoice.`);
  } else {
    changes.push(`Removed ${path}.voice (${path}.speakerVoice already set).`);
  }
  delete owner.voice;
}

function migrateDiscordVoice(channels: Record<string, unknown>, changes: string[]): void {
  const discord = getRecord(channels.discord);
  if (!discord) {
    return;
  }
  const migrateEntry = (entry: Record<string, unknown>, path: string) => {
    const realtime = getRecord(getRecord(entry.voice)?.realtime);
    if (realtime) {
      moveVoice(realtime, `${path}.voice.realtime`, changes);
    }
  };
  migrateEntry(discord, "channels.discord");
  const accounts = getRecord(discord.accounts);
  if (accounts) {
    for (const [accountId, value] of Object.entries(accounts)) {
      const account = getRecord(value);
      if (account) {
        migrateEntry(account, `channels.discord.accounts.${accountId}`);
      }
    }
  }
}

function hasDiscordRealtimeVoice(value: unknown): boolean {
  const discord = getRecord(value);
  if (!discord) {
    return false;
  }
  const hasAlias = (entry: unknown) => {
    const realtime = getRecord(getRecord(getRecord(entry)?.voice)?.realtime);
    return realtime ? Object.hasOwn(realtime, "voice") : false;
  };
  if (hasAlias(discord)) {
    return true;
  }
  const accounts = getRecord(discord.accounts);
  return accounts ? Object.values(accounts).some(hasAlias) : false;
}

function mapDeepgram(value: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  if (typeof value.detectLanguage === "boolean") {
    mapped.detect_language = value.detectLanguage;
  }
  if (typeof value.punctuate === "boolean") {
    mapped.punctuate = value.punctuate;
  }
  if (typeof value.smartFormat === "boolean") {
    mapped.smart_format = value.smartFormat;
  }
  return mapped;
}

function migrateDeepgramOwner(
  owner: Record<string, unknown>,
  path: string,
  changes: string[],
): void {
  const legacy = getRecord(owner.deepgram);
  if (!legacy) {
    return;
  }
  const providerOptions = getRecord(owner.providerOptions) ?? {};
  const canonical = getRecord(providerOptions.deepgram) ?? {};
  providerOptions.deepgram = { ...mapDeepgram(legacy), ...canonical };
  owner.providerOptions = providerOptions;
  delete owner.deepgram;
  changes.push(`Moved ${path}.deepgram → ${path}.providerOptions.deepgram.`);
}

function migrateMediaDeepgram(raw: Record<string, unknown>, changes: string[]): void {
  const media = getRecord(getRecord(raw.tools)?.media);
  if (!media) {
    return;
  }
  const migrateModels = (models: unknown, path: string) => {
    if (!Array.isArray(models)) {
      return;
    }
    models.forEach((value, index) => {
      const model = getRecord(value);
      if (model) {
        migrateDeepgramOwner(model, `${path}[${index}]`, changes);
      }
    });
  };
  migrateModels(media.models, "tools.media.models");
  for (const capability of ["audio", "image", "video"]) {
    const entry = getRecord(media[capability]);
    if (!entry) {
      continue;
    }
    migrateDeepgramOwner(entry, `tools.media.${capability}`, changes);
    migrateModels(entry.models, `tools.media.${capability}.models`);
  }
}

function hasMediaDeepgram(value: unknown): boolean {
  const media = getRecord(value);
  if (!media) {
    return false;
  }
  const hasAlias = (entry: unknown) => {
    const owner = getRecord(entry);
    return owner ? Object.hasOwn(owner, "deepgram") : false;
  };
  const modelsHaveAlias = (models: unknown) => Array.isArray(models) && models.some(hasAlias);
  if (modelsHaveAlias(media.models)) {
    return true;
  }
  return ["audio", "image", "video"].some((capability) => {
    const entry = getRecord(media[capability]);
    return entry ? hasAlias(entry) || modelsHaveAlias(entry.models) : false;
  });
}

const RETIRED_TUNING_PATHS = [
  ["systemAgent"],
  ["marketplaces"],
  ["cli", "banner", "taglineMode"],
  ["commitments"],
  ["auth", "cooldowns"],
  ["secrets", "resolution"],
  ["browser", "remoteCdpTimeoutMs"],
  ["browser", "remoteCdpHandshakeTimeoutMs"],
  ["browser", "localLaunchTimeoutMs"],
  ["browser", "localCdpReadyTimeoutMs"],
  ["browser", "actionTimeoutMs"],
  ["browser", "cdpPortRangeStart"],
  ["browser", "tabCleanup", "idleMinutes"],
  ["browser", "tabCleanup", "maxTabsPerSession"],
  ["browser", "tabCleanup", "sweepMinutes"],
  ["tools", "loopDetection", "genericRepeat"],
  ["tools", "loopDetection", "knownPollNoProgress"],
  ["tools", "loopDetection", "pingPong"],
  ["tools", "loopDetection", "windowSize"],
  ["tools", "loopDetection", "historySize"],
  ["tools", "loopDetection", "warningThreshold"],
  ["tools", "loopDetection", "unknownToolThreshold"],
  ["tools", "loopDetection", "criticalThreshold"],
  ["tools", "loopDetection", "globalCircuitBreakerThreshold"],
  ["tools", "loopDetection", "detectors"],
  ["tools", "loopDetection", "postCompactionGuard"],
  ["gateway", "handshakeTimeoutMs"],
  ["gateway", "channelHealthCheckMinutes"],
  ["gateway", "channelStaleEventThresholdMinutes"],
  ["gateway", "channelMaxRestartsPerHour"],
  ["gateway", "reload", "debounceMs"],
  ["gateway", "reload", "deferralTimeoutMs"],
  ["gateway", "http", "endpoints", "chatCompletions", "maxBodyBytes"],
  ["gateway", "http", "endpoints", "chatCompletions", "maxImageParts"],
  ["gateway", "http", "endpoints", "chatCompletions", "maxTotalImageBytes"],
  ["gateway", "http", "endpoints", "responses", "maxBodyBytes"],
  ["session", "typingIntervalSeconds"],
  ["session", "writeLock"],
  ["session", "agentToAgent", "maxPingPongTurns"],
  ["cron", "maxConcurrentRuns"],
  ["cron", "triggers", "minIntervalMs"],
  ["cron", "retry"],
  ["diagnostics", "stuckSessionWarnMs"],
  ["diagnostics", "stuckSessionAbortMs"],
  ["diagnostics", "memoryPressureSnapshot"],
  ["diagnostics", "memoryPressureBundle"],
  ["web", "heartbeatSeconds"],
  ["web", "reconnect"],
  ["web", "whatsapp"],
  ["messages", "queue", "debounceMs"],
  ["messages", "statusReactions", "timing"],
  ["acp", "stream", "coalesceIdleMs"],
  ["acp", "stream", "maxChunkChars"],
  ["acp", "stream", "maxOutputChars"],
  ["acp", "stream", "maxSessionUpdateChars"],
  ["acp", "stream", "hiddenBoundarySeparator"],
  ["acp", "maxConcurrentSessions"],
  ["acp", "runtime", "ttlMinutes"],
  ["mcp", "sessionIdleTtlMs"],
  ["worktrees"],
  ["transcripts", "maxUtterances"],
  ["hooks", "maxBodyBytes"],
  ["update", "auto", "stableDelayHours"],
  ["update", "auto", "stableJitterHours"],
  ["update", "auto", "betaCheckIntervalHours"],
  ["memory", "search", "chunking"],
  ["memory", "search", "sync", "watchDebounceMs"],
  ["memory", "search", "sync", "intervalMinutes"],
  ["memory", "search", "query", "hybrid", "vectorWeight"],
  ["memory", "search", "query", "hybrid", "textWeight"],
  ["memory", "search", "query", "hybrid", "candidateMultiplier"],
  ["memory", "search", "query", "hybrid", "mmr", "lambda"],
  ["memory", "search", "query", "hybrid", "temporalDecay", "halfLifeDays"],
  ["memory", "search", "cache", "maxEntries"],
] as const;

const RETIRED_AGENT_TUNING_PATHS = [
  ["compaction", "reserveTokens"],
  ["compaction", "reserveTokensFloor"],
  ["compaction", "maxHistoryShare"],
  ["contextPruning", "keepLastAssistants"],
  ["contextPruning", "softTrimRatio"],
  ["contextPruning", "hardClearRatio"],
  ["contextPruning", "minPrunableToolChars"],
  ["contextPruning", "softTrim"],
  ["memory", "search", "chunking"],
  ["memory", "search", "sync", "watchDebounceMs"],
  ["memory", "search", "sync", "intervalMinutes"],
  ["memory", "search", "query", "hybrid", "vectorWeight"],
  ["memory", "search", "query", "hybrid", "textWeight"],
  ["memory", "search", "query", "hybrid", "candidateMultiplier"],
  ["memory", "search", "query", "hybrid", "mmr", "lambda"],
  ["memory", "search", "query", "hybrid", "temporalDecay", "halfLifeDays"],
  ["memory", "search", "cache", "maxEntries"],
  ["cliBackends", "*", "reliability", "outputLimits"],
  ["cliBackends", "*", "reliability", "watchdog", "fresh", "noOutputTimeoutMs"],
  ["cliBackends", "*", "reliability", "watchdog", "resume", "noOutputTimeoutMs"],
  ["runRetries"],
  ["tools", "loopDetection", "genericRepeat"],
  ["tools", "loopDetection", "knownPollNoProgress"],
  ["tools", "loopDetection", "pingPong"],
  ["tools", "loopDetection", "windowSize"],
  ["tools", "loopDetection", "historySize"],
  ["tools", "loopDetection", "warningThreshold"],
  ["tools", "loopDetection", "unknownToolThreshold"],
  ["tools", "loopDetection", "criticalThreshold"],
  ["tools", "loopDetection", "globalCircuitBreakerThreshold"],
  ["tools", "loopDetection", "detectors"],
  ["tools", "loopDetection", "postCompactionGuard"],
] as const;

function deleteRetiredPath(owner: unknown, path: readonly string[], index = 0): boolean {
  const record = getRecord(owner);
  if (!record) {
    return false;
  }
  const key = path[index];
  if (!key) {
    return false;
  }
  if (key === "*") {
    let changed = false;
    for (const value of Object.values(record)) {
      changed = deleteRetiredPath(value, path, index + 1) || changed;
    }
    return changed;
  }
  if (index === path.length - 1) {
    if (!Object.hasOwn(record, key)) {
      return false;
    }
    delete record[key];
    return true;
  }
  const child = getRecord(record[key]);
  if (!child || !deleteRetiredPath(child, path, index + 1)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete record[key];
  }
  return true;
}

function stripRetiredTuningKnobs(raw: Record<string, unknown>): boolean {
  let changed = false;
  for (const path of RETIRED_TUNING_PATHS) {
    changed = deleteRetiredPath(raw, path) || changed;
  }
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  if (defaults) {
    for (const path of RETIRED_AGENT_TUNING_PATHS) {
      changed = deleteRetiredPath(defaults, path) || changed;
    }
  }
  if (Array.isArray(agents?.list)) {
    for (const agent of agents.list) {
      for (const path of RETIRED_AGENT_TUNING_PATHS) {
        changed = deleteRetiredPath(agent, path) || changed;
      }
    }
  }
  return changed;
}

const MEDIA_CAPABILITIES = ["image", "audio", "video"] as const;
function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableConfigValue);
  }
  const record = getRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, stableConfigValue(record[key])]),
  );
}

function mediaModelSignature(model: Record<string, unknown>): string {
  const { capabilities: _capabilities, ...rest } = model;
  return JSON.stringify(stableConfigValue(rest));
}

function scopeLegacyMediaModel(
  model: Record<string, unknown>,
  capability: string,
): Record<string, unknown> | undefined {
  if (
    Array.isArray(model.capabilities) &&
    !model.capabilities.some((value) => value === capability)
  ) {
    return undefined;
  }
  return { ...model, capabilities: [capability] };
}

function hasLegacyMediaCapabilityConfig(value: unknown): boolean {
  const media = getRecord(value);
  return MEDIA_CAPABILITIES.some((capability) => {
    const config = getRecord(media?.[capability]);
    return Array.isArray(config?.models);
  });
}

function consolidateMediaCapabilityConfig(raw: Record<string, unknown>, changes: string[]): void {
  const media = getRecord(getRecord(raw.tools)?.media);
  if (!media) {
    return;
  }
  const sharedModels = Array.isArray(media.models)
    ? media.models.filter(
        (value): value is Record<string, unknown> => getRecord(value) !== undefined,
      )
    : [];
  const migratedModels: Record<string, unknown>[] = [];
  let changed = false;

  for (const capability of MEDIA_CAPABILITIES) {
    const config = getRecord(media[capability]);
    if (!config) {
      continue;
    }
    const legacyModels = Array.isArray(config.models)
      ? config.models.filter(
          (value): value is Record<string, unknown> => getRecord(value) !== undefined,
        )
      : [];
    const migratedBySignature = new Map<string, Record<string, unknown>>();
    const eligibleLegacyModels = legacyModels.flatMap((legacyModel) => {
      const scoped = scopeLegacyMediaModel(legacyModel, capability);
      return scoped ? [scoped] : [];
    });
    for (const migrated of eligibleLegacyModels) {
      const signature = mediaModelSignature(migrated);
      const duplicate = migratedBySignature.get(signature);
      if (duplicate) {
        continue;
      }
      migratedBySignature.set(signature, migrated);
      migratedModels.push(migrated);
    }
    if (Object.hasOwn(config, "models")) {
      delete config.models;
      changed = true;
    }
    if (Object.keys(config).length === 0) {
      delete media[capability];
    }
    changed = changed || legacyModels.length > 0;
  }
  const canonicalModels = [...migratedModels, ...sharedModels];
  if (canonicalModels.length > 0) {
    media.models = canonicalModels;
  }
  if (changed) {
    changes.push(
      "Consolidated tools.media image/audio/video model settings into capability-tagged tools.media.models entries.",
    );
  }
}

function moveKey(
  owner: Record<string, unknown> | null | undefined,
  legacyKey: string,
  canonicalKey: string,
  path: string,
  changes: string[],
): void {
  if (!owner || !Object.hasOwn(owner, legacyKey)) {
    return;
  }
  if (owner[canonicalKey] === undefined) {
    owner[canonicalKey] = owner[legacyKey];
    changes.push(`Moved ${path}.${legacyKey} → ${path}.${canonicalKey}.`);
  } else {
    changes.push(`Removed ${path}.${legacyKey} (${path}.${canonicalKey} already set).`);
  }
  delete owner[legacyKey];
}

function migrateFinalLayoutRenames(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  moveKey(defaults, "pdfMaxBytesMb", "pdfMaxMb", "agents.defaults", changes);
  if (defaults) {
    const mediaModels = getRecord(defaults.mediaModels) ?? {};
    for (const [legacyKey, canonicalKey] of [
      ["imageGenerationModel", "image"],
      ["videoGenerationModel", "video"],
      ["musicGenerationModel", "music"],
    ] as const) {
      if (!Object.hasOwn(defaults, legacyKey)) {
        continue;
      }
      if (mediaModels[canonicalKey] === undefined) {
        mediaModels[canonicalKey] = defaults[legacyKey];
        changes.push(
          `Moved agents.defaults.${legacyKey} → agents.defaults.mediaModels.${canonicalKey}.`,
        );
      } else {
        changes.push(
          `Removed agents.defaults.${legacyKey} (agents.defaults.mediaModels.${canonicalKey} already set).`,
        );
      }
      delete defaults[legacyKey];
    }
    if (Object.keys(mediaModels).length > 0) {
      defaults.mediaModels = mediaModels;
    }
  }

  const migrateAgentScope = (scope: Record<string, unknown> | null, path: string) => {
    moveKey(
      getRecord(getRecord(scope?.tools)?.exec),
      "timeoutSec",
      "timeoutSeconds",
      `${path}.tools.exec`,
      changes,
    );
    moveKey(
      getRecord(getRecord(getRecord(scope?.sandbox)?.browser)),
      "enableNoVnc",
      "noVncEnabled",
      `${path}.sandbox.browser`,
      changes,
    );
  };
  migrateAgentScope(defaults, "agents.defaults");
  if (Array.isArray(agents?.list)) {
    agents.list.forEach((entry, index) =>
      migrateAgentScope(getRecord(entry), `agents.list[${index}]`),
    );
  }
  moveKey(
    getRecord(getRecord(raw.tools)?.exec),
    "timeoutSec",
    "timeoutSeconds",
    "tools.exec",
    changes,
  );

  const env = getRecord(raw.env);
  if (env) {
    const vars = getRecord(env.vars) ?? {};
    let moved = false;
    for (const [key, value] of Object.entries(env)) {
      if (key === "vars" || key === "shellEnv" || typeof value !== "string") {
        continue;
      }
      if (vars[key] === undefined) {
        vars[key] = value;
        changes.push(`Moved env.${key} → env.vars.${key}.`);
      } else {
        changes.push(`Removed env.${key} (env.vars.${key} already set).`);
      }
      delete env[key];
      moved = true;
    }
    if (moved) {
      env.vars = vars;
    }
  }

  const browser = getRecord(raw.browser);
  const ssrfPolicy = getRecord(browser?.ssrfPolicy);
  if (ssrfPolicy && Array.isArray(ssrfPolicy.hostnameAllowlist)) {
    const canonical = Array.isArray(ssrfPolicy.allowedHostnames) ? ssrfPolicy.allowedHostnames : [];
    ssrfPolicy.allowedHostnames = [
      ...new Set(
        [...canonical, ...ssrfPolicy.hostnameAllowlist].filter(
          (value) => typeof value === "string",
        ),
      ),
    ];
    delete ssrfPolicy.hostnameAllowlist;
    changes.push("Merged browser.ssrfPolicy.hostnameAllowlist → allowedHostnames.");
  }

  const legacyMedia = getRecord(raw.media);
  if (legacyMedia) {
    const attachments = ensureRecord(raw, "attachments");
    mergeMissing(attachments, legacyMedia);
    delete raw.media;
    changes.push("Moved media → attachments.");
  }

  const audit = getRecord(raw.audit);
  if (audit) {
    const logging = ensureRecord(raw, "logging");
    const canonicalAudit = getRecord(logging.audit) ?? {};
    mergeMissing(canonicalAudit, audit);
    logging.audit = canonicalAudit;
    delete raw.audit;
    changes.push("Moved audit → logging.audit.");
  }

  const nodes = getRecord(getRecord(raw.gateway)?.nodes);
  if (nodes) {
    const skills = getRecord(nodes.skills);
    if (skills && Object.hasOwn(skills, "enabled")) {
      if (nodes.allowSkills === undefined) {
        nodes.allowSkills = skills.enabled;
      }
      delete nodes.skills;
      changes.push("Moved gateway.nodes.skills.enabled → gateway.nodes.allowSkills.");
    }
    const commands = getRecord(nodes.commands) ?? {};
    if (Object.hasOwn(nodes, "allowCommands")) {
      if (commands.allow === undefined) {
        commands.allow = nodes.allowCommands;
      }
      delete nodes.allowCommands;
      changes.push("Moved gateway.nodes.allowCommands → gateway.nodes.commands.allow.");
    }
    if (Object.hasOwn(nodes, "denyCommands")) {
      if (commands.deny === undefined) {
        commands.deny = nodes.denyCommands;
      }
      delete nodes.denyCommands;
      changes.push("Moved gateway.nodes.denyCommands → gateway.nodes.commands.deny.");
    }
    if (Object.keys(commands).length > 0) {
      nodes.commands = commands;
    }
  }

  const slack = getRecord(getRecord(raw.channels)?.slack);
  moveKey(slack, "identity", "postAs", "channels.slack", changes);
  const slackAccounts = getRecord(slack?.accounts);
  if (slackAccounts) {
    for (const [accountId, value] of Object.entries(slackAccounts)) {
      moveKey(
        getRecord(value),
        "identity",
        "postAs",
        `channels.slack.accounts.${accountId}`,
        changes,
      );
    }
  }
}

function visitChannelEntries(
  raw: Record<string, unknown>,
  channelId: string,
  visitor: (entry: Record<string, unknown>, path: string) => void,
): void {
  const channel = getRecord(getRecord(raw.channels)?.[channelId]);
  if (!channel) {
    return;
  }
  visitor(channel, `channels.${channelId}`);
  const accounts = getRecord(channel.accounts);
  if (!accounts) {
    return;
  }
  for (const [accountId, value] of Object.entries(accounts)) {
    const account = getRecord(value);
    if (account) {
      visitor(account, `channels.${channelId}.accounts.${accountId}`);
    }
  }
}

function migrateFinalLayoutKills(raw: Record<string, unknown>, changes: string[]): void {
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  for (const key of [
    "promptOverlays",
    "envelopeTimestamp",
    "envelopeElapsed",
    "envelopeTimezone",
    "timeFormat",
    "bootstrapPromptTruncationWarning",
    "mediaGenerationAutoProviderFallback",
  ]) {
    if (defaults && Object.hasOwn(defaults, key)) {
      delete defaults[key];
      changes.push(`Removed agents.defaults.${key}; built-in behavior now applies.`);
    }
  }

  const diagnostics = getRecord(raw.diagnostics);
  const otel = getRecord(diagnostics?.otel);
  const captureContent = getRecord(otel?.captureContent);
  if (otel && captureContent) {
    otel.captureContent =
      captureContent.enabled === true ||
      Object.entries(captureContent).some(([key, value]) => key !== "enabled" && value === true);
    changes.push("Collapsed diagnostics.otel.captureContent to a boolean.");
  }
  const cacheTrace = getRecord(diagnostics?.cacheTrace);
  if (
    cacheTrace &&
    (Object.keys(cacheTrace).some((key) => key !== "enabled") ||
      (cacheTrace.enabled !== undefined && typeof cacheTrace.enabled !== "boolean"))
  ) {
    diagnostics!.cacheTrace = { enabled: cacheTrace.enabled === true };
    changes.push("Removed diagnostics.cacheTrace detail fields; only enabled remains.");
  }

  const attachments = getRecord(raw.attachments);
  if (attachments && Object.hasOwn(attachments, "preserveFilenames")) {
    delete attachments.preserveFilenames;
    changes.push("Removed attachments.preserveFilenames; temp-safe names now always apply.");
  }
  const browser = getRecord(raw.browser);
  if (browser && Object.hasOwn(browser, "color")) {
    delete browser.color;
    changes.push("Removed browser.color; the built-in color now applies.");
  }
  const profiles = getRecord(browser?.profiles);
  if (profiles) {
    for (const [profileId, value] of Object.entries(profiles)) {
      const profile = getRecord(value);
      if (profile && Object.hasOwn(profile, "color")) {
        delete profile.color;
        changes.push(`Removed browser.profiles.${profileId}.color.`);
      }
    }
  }

  visitChannelEntries(raw, "discord", (entry, path) => {
    const autoPresence = getRecord(entry.autoPresence);
    for (const key of ["healthyText", "degradedText", "exhaustedText"]) {
      if (autoPresence && Object.hasOwn(autoPresence, key)) {
        delete autoPresence[key];
        changes.push(`Removed ${path}.autoPresence.${key}.`);
      }
    }
    const components = getRecord(getRecord(entry.ui)?.components);
    if (components && Object.hasOwn(components, "accentColor")) {
      delete components.accentColor;
      changes.push(`Removed ${path}.ui.components.accentColor.`);
      const ui = getRecord(entry.ui);
      if (Object.keys(components).length === 0 && ui) {
        delete ui.components;
      }
      if (ui && Object.keys(ui).length === 0) {
        delete entry.ui;
      }
    }
    if (Object.hasOwn(entry, "subagentProgress")) {
      delete entry.subagentProgress;
      changes.push(`Removed ${path}.subagentProgress.`);
    }
  });

  let messages = getRecord(raw.messages);
  const statusReactions = getRecord(messages?.statusReactions);
  if (statusReactions && Object.hasOwn(statusReactions, "emojis")) {
    delete statusReactions.emojis;
    changes.push("Removed messages.statusReactions.emojis; curated defaults now apply.");
  }
  if (messages && Object.hasOwn(messages, "removeAckAfterReply")) {
    delete messages.removeAckAfterReply;
    changes.push("Removed messages.removeAckAfterReply; acknowledgements are retained.");
  }

  visitChannelEntries(raw, "whatsapp", (entry, path) => {
    moveKey(entry, "messagePrefix", "responsePrefix", path, changes);
    const ack = getRecord(entry.ackReaction);
    if (!ack) {
      return;
    }
    messages ??= ensureRecord(raw, "messages");
    if (messages.ackReaction === undefined && typeof ack.emoji === "string") {
      messages.ackReaction = ack.emoji;
    }
    if (messages.ackReactionScope === undefined) {
      const direct = ack.direct !== false;
      const group = ack.group ?? "mentions";
      const scope =
        direct && group === "always"
          ? "all"
          : direct && group === "never"
            ? "direct"
            : !direct && group === "always"
              ? "group-all"
              : !direct && group === "mentions"
                ? "group-mentions"
                : !direct && group === "never"
                  ? "off"
                  : undefined;
      if (scope) {
        messages.ackReactionScope = scope;
      }
    }
    delete entry.ackReaction;
    changes.push(`Moved translatable ${path}.ackReaction settings to messages ack settings.`);
  });

  visitChannelEntries(raw, "slack", (entry, path) => {
    const socketMode = getRecord(entry.socketMode);
    for (const key of ["clientPingTimeout", "serverPingTimeout", "pingPongLoggingEnabled"]) {
      if (socketMode && Object.hasOwn(socketMode, key)) {
        delete socketMode[key];
        changes.push(`Removed ${path}.socketMode.${key}.`);
      }
    }
    if (socketMode && Object.keys(socketMode).length === 0) {
      delete entry.socketMode;
    }
  });
  visitChannelEntries(raw, "imessage", (entry, path) => {
    if (Object.hasOwn(entry, "coalesceSameSenderDms")) {
      delete entry.coalesceSameSenderDms;
      changes.push(`Removed ${path}.coalesceSameSenderDms.`);
    }
  });

  const commands = getRecord(raw.commands);
  for (const key of ["ownerDisplay", "ownerDisplaySecret"]) {
    if (commands && Object.hasOwn(commands, key)) {
      delete commands[key];
      changes.push(`Removed commands.${key}; owner ids now render raw.`);
    }
  }

  const cron = getRecord(raw.cron);
  const failureDestination = getRecord(cron?.failureDestination);
  if (cron && failureDestination) {
    const failureAlert = getRecord(cron.failureAlert) ?? {};
    mergeMissing(failureAlert, failureDestination);
    cron.failureAlert = failureAlert;
    delete cron.failureDestination;
    changes.push("Merged cron.failureDestination → cron.failureAlert.");
  }
  const gateway = getRecord(raw.gateway);
  const reload = getRecord(gateway?.reload);
  if (reload?.mode === "restart" || reload?.mode === "hot") {
    reload.mode = "hybrid";
    changes.push("Mapped gateway.reload.mode to hybrid.");
  }
  const logging = getRecord(raw.logging);
  if (logging?.consoleStyle === "compact") {
    logging.consoleStyle = "pretty";
    changes.push("Mapped logging.consoleStyle compact → pretty.");
  }
  const controlUi = getRecord(gateway?.controlUi);
  if (controlUi && Object.hasOwn(controlUi, "chatMessageMaxWidth")) {
    const prefs = ensureRecord(ensureRecord(raw, "ui"), "prefs");
    if (prefs.chatMessageMaxWidth === undefined) {
      prefs.chatMessageMaxWidth = controlUi.chatMessageMaxWidth;
      changes.push("Moved gateway.controlUi.chatMessageMaxWidth → ui.prefs.chatMessageMaxWidth.");
    } else {
      changes.push("Removed gateway.controlUi.chatMessageMaxWidth (ui.prefs value already set).");
    }
    delete controlUi.chatMessageMaxWidth;
  }
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "runtime.final-layout-polish",
    describe: "Normalize final configuration layout names",
    legacyRules: [
      rule([], "Final layout aliases were retired.", (_value, root) => {
        const changes: string[] = [];
        migrateFinalLayoutRenames(structuredClone(root), changes);
        return changes.length > 0;
      }),
    ],
    apply: migrateFinalLayoutRenames,
  }),
  defineLegacyConfigMigration({
    id: "runtime.final-layout-kills",
    describe: "Remove final layout tuning knobs",
    legacyRules: [
      rule([], "Final layout tuning knobs were retired.", (_value, root) => {
        const changes: string[] = [];
        migrateFinalLayoutKills(structuredClone(root), changes);
        return changes.length > 0;
      }),
    ],
    apply: migrateFinalLayoutKills,
  }),
  defineLegacyConfigMigration({
    id: "runtime.media-models-consolidation",
    describe: "Consolidate per-capability media model configuration",
    legacyRules: [
      rule(
        ["tools", "media"],
        "Per-capability media model settings moved to capability-tagged tools.media.models entries.",
        hasLegacyMediaCapabilityConfig,
      ),
    ],
    apply: (raw, changes) => {
      migrateMediaDeepgram(raw, changes);
      consolidateMediaCapabilityConfig(raw, changes);
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.tuning-knobs-purge",
    describe: "Remove retired runtime tuning knobs",
    legacyRules: [
      rule(
        [],
        "Numeric runtime tuning knobs were retired and now use built-in defaults.",
        (_value, root) => stripRetiredTuningKnobs(structuredClone(root)),
      ),
    ],
    apply: (raw, changes) => {
      if (stripRetiredTuningKnobs(raw)) {
        changes.push("Removed retired runtime tuning knobs; built-in defaults now apply.");
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.retired-config-keys",
    describe: "Migrate retired root and tool config keys",
    legacyRules: [
      rule(["tui"], "tui was retired and is ignored."),
      rule(["commands", "modelsWrite"], "commands.modelsWrite was retired and is ignored."),
      rule(
        ["messages", "messagePrefix"],
        "messages.messagePrefix moved to channels.whatsapp.responsePrefix.",
      ),
      rule(
        ["tools", "media", "asyncCompletion"],
        "tools.media.asyncCompletion.directSend was retired and is ignored.",
      ),
      rule(
        ["tools", "message", "allowCrossContextSend"],
        "tools.message.allowCrossContextSend moved to tools.message.crossContext.",
      ),
      rule(
        ["talk", "realtime", "voice"],
        "talk.realtime.voice moved to talk.realtime.speakerVoice.",
      ),
      rule(
        ["channels", "discord"],
        "Discord realtime voice aliases moved to speakerVoice.",
        hasDiscordRealtimeVoice,
      ),
      rule(
        ["tools", "media"],
        "Legacy Deepgram options moved to providerOptions.deepgram.",
        hasMediaDeepgram,
      ),
    ],
    apply: (raw, changes) => {
      if (Object.hasOwn(raw, "tui")) {
        delete raw.tui;
        changes.push("Removed retired tui config; the footer uses the default compact display.");
      }
      const commands = getRecord(raw.commands);
      if (commands && Object.hasOwn(commands, "modelsWrite")) {
        delete commands.modelsWrite;
        changes.push("Removed retired commands.modelsWrite.");
      }
      const messages = getRecord(raw.messages);
      if (messages && Object.hasOwn(messages, "messagePrefix")) {
        const whatsapp = ensureRecord(ensureRecord(raw, "channels"), "whatsapp");
        if (whatsapp.responsePrefix === undefined) {
          whatsapp.responsePrefix = messages.messagePrefix;
          changes.push("Moved messages.messagePrefix → channels.whatsapp.responsePrefix.");
        } else {
          changes.push(
            "Removed messages.messagePrefix (channels.whatsapp.responsePrefix already set).",
          );
        }
        delete messages.messagePrefix;
      }
      const media = getRecord(getRecord(raw.tools)?.media);
      if (media && Object.hasOwn(media, "asyncCompletion")) {
        delete media.asyncCompletion;
        changes.push("Removed retired tools.media.asyncCompletion.directSend.");
      }
      const messageTool = getRecord(getRecord(raw.tools)?.message);
      if (messageTool && Object.hasOwn(messageTool, "allowCrossContextSend")) {
        const enabled = messageTool.allowCrossContextSend === true;
        if (enabled) {
          const crossContext = getRecord(messageTool.crossContext) ?? {};
          if (crossContext.allowWithinProvider === undefined) {
            crossContext.allowWithinProvider = true;
          }
          if (crossContext.allowAcrossProviders === undefined) {
            crossContext.allowAcrossProviders = true;
          }
          messageTool.crossContext = crossContext;
          changes.push("Moved tools.message.allowCrossContextSend → tools.message.crossContext.");
        } else {
          changes.push("Removed tools.message.allowCrossContextSend.");
        }
        delete messageTool.allowCrossContextSend;
      }
      const talkRealtime = getRecord(getRecord(raw.talk)?.realtime);
      if (talkRealtime) {
        moveVoice(talkRealtime, "talk.realtime", changes);
      }
      const channels = getRecord(raw.channels);
      if (channels) {
        migrateDiscordVoice(channels, changes);
      }
      migrateMediaDeepgram(raw, changes);
    },
  }),
];

/* oxlint-disable max-lines -- Final-layout retirement rules stay co-located for one bounded compatibility window. */
