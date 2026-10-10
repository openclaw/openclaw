import {
  createLegacyConfigRule as rule,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { mergeMissing } from "../../../config/merge-missing.js";
import { migrateConfigTranche } from "./legacy-config-migrations.runtime.config-tranche.js";
import {
  consolidateMediaCapabilityConfig,
  hasDiscordRealtimeVoice,
  hasLegacyMediaCapabilityConfig,
  hasMediaDeepgram,
  migrateDiscordVoice,
  migrateMediaDeepgram,
  stripRetiredTuningKnobs,
} from "./legacy-config-migrations.runtime.retired-media.js";
import { LEGACY_CONFIG_MIGRATION_RUNTIME_MEMORY_QMD } from "./legacy-config-migrations.runtime.retired-memory-qmd.js";
import { migrateTierEvalTranche } from "./legacy-config-migrations.runtime.tier-eval.js";
import {
  deleteRetiredPath,
  moveLegacyConfigKey,
  visitAgentConfigScopes,
  visitChannelEntries,
} from "./legacy-config-record-shared.js";

function migrateMessageCrossContext(raw: Record<string, unknown>, changes: string[]): void {
  const globalMessage = getRecord(getRecord(raw.tools)?.message);
  const globalBypass = globalMessage?.allowCrossContextSend;
  const globalCrossContext = getRecord(globalMessage?.crossContext);
  const migrate = (message: Record<string, unknown> | null, path: string, agent: boolean) => {
    if (!message) {
      return;
    }
    const legacy = message.allowCrossContextSend;
    const inheritedBypass = agent && globalBypass === true;
    if (legacy === undefined && !inheritedBypass) {
      return;
    }
    const crossContext = getRecord(message.crossContext) ?? {};
    // The shipped legacy flag bypassed both checks. An agent's false masked the
    // root bypass, so preserve that effective policy before changing the root.
    if ((legacy ?? (agent ? globalBypass : undefined)) === true) {
      message.crossContext = {
        ...crossContext,
        allowWithinProvider: true,
        allowAcrossProviders: true,
      };
    } else if (inheritedBypass) {
      message.crossContext = {
        ...crossContext,
        allowWithinProvider:
          (crossContext.allowWithinProvider ?? globalCrossContext?.allowWithinProvider) !== false,
        allowAcrossProviders:
          (crossContext.allowAcrossProviders ?? globalCrossContext?.allowAcrossProviders) === true,
      };
    }
    delete message.allowCrossContextSend;
    changes.push(`Moved ${path}.allowCrossContextSend → ${path}.crossContext.`);
  };
  visitAgentConfigScopes(raw, (scope, path) => {
    if (path !== "agents.defaults") {
      migrate(getRecord(getRecord(scope.tools)?.message), `${path}.tools.message`, true);
    }
  });
  migrate(globalMessage, "tools.message", false);
}

function migrateTruncateAfterCompaction(raw: Record<string, unknown>, changes: string[]): void {
  const compaction = getRecord(getRecord(getRecord(raw.agents)?.defaults)?.compaction);
  if (!compaction || !Object.hasOwn(compaction, "truncateAfterCompaction")) {
    return;
  }
  if (
    compaction.truncateAfterCompaction === false &&
    Object.hasOwn(compaction, "maxActiveTranscriptBytes")
  ) {
    delete compaction.maxActiveTranscriptBytes;
    changes.push("Removed maxActiveTranscriptBytes to preserve truncateAfterCompaction: false.");
  }
  delete compaction.truncateAfterCompaction;
  changes.push("Removed retired agents.defaults.compaction.truncateAfterCompaction.");
}

function migrateFinalLayoutRenames(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  moveLegacyConfigKey(defaults, "pdfMaxBytesMb", "pdfMaxMb", "agents.defaults", changes);
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

  visitAgentConfigScopes(raw, (scope, path) => {
    moveLegacyConfigKey(
      getRecord(getRecord(scope.tools)?.exec),
      "timeoutSec",
      "timeoutSeconds",
      `${path}.tools.exec`,
      changes,
    );
    moveLegacyConfigKey(
      getRecord(getRecord(scope.sandbox)?.browser),
      "enableNoVnc",
      "noVncEnabled",
      `${path}.sandbox.browser`,
      changes,
    );
  });
  moveLegacyConfigKey(
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
    for (const [legacy, canonical] of [
      ["allowCommands", "allow"],
      ["denyCommands", "deny"],
    ] as const) {
      if (!Object.hasOwn(nodes, legacy)) {
        continue;
      }
      if (commands[canonical] === undefined) {
        commands[canonical] = nodes[legacy];
      }
      delete nodes[legacy];
      changes.push(`Moved gateway.nodes.${legacy} → gateway.nodes.commands.${canonical}.`);
    }
    if (Object.keys(commands).length > 0) {
      nodes.commands = commands;
    }
  }

  visitChannelEntries(raw, "slack", (entry, path) => {
    moveLegacyConfigKey(entry, "identity", "postAs", path, changes);
  });
}

function migrateFinalLayoutKills(raw: Record<string, unknown>, changes: string[]): void {
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  if (defaults && Object.hasOwn(defaults, "promptOverlays")) {
    const personality = getRecord(getRecord(defaults.promptOverlays)?.gpt5)?.personality;
    if (personality !== undefined) {
      const openaiConfig = ensureRecord(
        ensureRecord(ensureRecord(ensureRecord(raw, "plugins"), "entries"), "openai"),
        "config",
      );
      if (openaiConfig.personality === undefined) {
        openaiConfig.personality = personality;
        changes.push(
          "Moved agents.defaults.promptOverlays.gpt5.personality → plugins.entries.openai.config.personality.",
        );
      } else {
        changes.push(
          "Removed agents.defaults.promptOverlays.gpt5.personality (plugins.entries.openai.config.personality already set).",
        );
      }
    } else {
      changes.push("Removed agents.defaults.promptOverlays; built-in behavior now applies.");
    }
    delete defaults.promptOverlays;
  }
  for (const key of [
    "envelopeTimestamp",
    "envelopeElapsed",
    "envelopeTimezone",
    "timeFormat",
    "bootstrapPromptTruncationWarning",
    "mediaGenerationAutoProviderFallback",
  ]) {
    if (deleteRetiredPath(defaults, [key])) {
      changes.push(`Removed agents.defaults.${key}; built-in behavior now applies.`);
    }
  }

  const diagnostics = getRecord(raw.diagnostics);
  const otel = getRecord(diagnostics?.otel);
  const captureContent = getRecord(otel?.captureContent);
  if (otel && captureContent) {
    otel.captureContent =
      typeof captureContent.enabled === "boolean"
        ? captureContent.enabled
        : Object.entries(captureContent).some(
            ([key, value]) => key !== "enabled" && value === true,
          );
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

  if (deleteRetiredPath(raw.attachments, ["preserveFilenames"])) {
    changes.push("Removed attachments.preserveFilenames; temp-safe names now always apply.");
  }
  const browser = getRecord(raw.browser);
  if (deleteRetiredPath(browser, ["color"])) {
    changes.push("Removed browser.color; the built-in color now applies.");
  }
  for (const [profileId, profile] of Object.entries(getRecord(browser?.profiles) ?? {})) {
    if (deleteRetiredPath(profile, ["color"])) {
      changes.push(`Removed browser.profiles.${profileId}.color.`);
    }
  }

  visitChannelEntries(raw, "discord", (entry, path) => {
    for (const key of ["healthyText", "degradedText", "exhaustedText"]) {
      if (deleteRetiredPath(entry.autoPresence, [key])) {
        changes.push(`Removed ${path}.autoPresence.${key}.`);
      }
    }
    if (deleteRetiredPath(entry, ["ui", "components", "accentColor"])) {
      changes.push(`Removed ${path}.ui.components.accentColor.`);
    }
  });

  const messages = getRecord(raw.messages);
  if (deleteRetiredPath(messages?.statusReactions, ["emojis"])) {
    changes.push("Removed messages.statusReactions.emojis; curated defaults now apply.");
  }
  if (deleteRetiredPath(messages, ["removeAckAfterReply"])) {
    changes.push("Removed messages.removeAckAfterReply; acknowledgements are retained.");
  }

  visitChannelEntries(raw, "whatsapp", (entry, path) => {
    moveLegacyConfigKey(entry, "messagePrefix", "responsePrefix", path, changes);
  });

  visitChannelEntries(raw, "slack", (entry, path) => {
    const socketMode = getRecord(entry.socketMode);
    for (const key of ["clientPingTimeout", "serverPingTimeout", "pingPongLoggingEnabled"]) {
      if (deleteRetiredPath(socketMode, [key])) {
        changes.push(`Removed ${path}.socketMode.${key}.`);
      }
    }
    if (socketMode && Object.keys(socketMode).length === 0) {
      delete entry.socketMode;
    }
  });
  visitChannelEntries(raw, "imessage", (entry, path) => {
    if (deleteRetiredPath(entry, ["coalesceSameSenderDms"])) {
      changes.push(`Removed ${path}.coalesceSameSenderDms.`);
    }
  });

  for (const key of ["ownerDisplay", "ownerDisplaySecret"]) {
    if (deleteRetiredPath(raw.commands, [key])) {
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
  if (deleteRetiredPath(gateway?.controlUi, ["chatMessageMaxWidth"])) {
    changes.push("Removed gateway.controlUi.chatMessageMaxWidth; chat width is now browser-local.");
  }
}

function removeUiAssistantIdentity(raw: Record<string, unknown>, changes: string[]): void {
  // The retired override was presentation-only. Translating it into agent identity
  // would unexpectedly change outbound channel identity.
  if (deleteRetiredPath(raw, ["ui", "assistant"])) {
    changes.push("Removed retired ui.assistant; configure agents.list[].identity instead.");
  }
}

function probedMigration(
  id: string,
  message: string,
  apply: LegacyConfigMigrationSpec["apply"],
): LegacyConfigMigrationSpec {
  return {
    id,
    legacyRules: [
      rule([], message, (_value, root) => {
        const changes: string[] = [];
        apply(structuredClone(root), changes);
        return changes.length > 0;
      }),
    ],
    apply,
  };
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED: LegacyConfigMigrationSpec[] = [
  LEGACY_CONFIG_MIGRATION_RUNTIME_MEMORY_QMD,
  {
    id: "runtime.automatic-local-model-lean",
    legacyRules: [
      rule(
        ["wizard", "localModelLeanAutoModel"],
        "wizard.localModelLeanAutoModel is retired; local models now use Tool Search without reducing their capabilities.",
      ),
    ],
    apply: (raw, changes) => {
      const wizard = getRecord(raw.wizard);
      if (!wizard || !Object.hasOwn(wizard, "localModelLeanAutoModel")) {
        return;
      }
      const autoModel = wizard.localModelLeanAutoModel;
      const defaults = getRecord(getRecord(raw.agents)?.defaults);
      const model = defaults?.model;
      const primary = typeof model === "string" ? model : getRecord(model)?.primary;
      const experimental = getRecord(defaults?.experimental);
      // The shipped marker owned only a matching default model's true flag.
      // A changed model or explicit false relinquished that ownership.
      if (experimental?.localModelLean === true) {
        if (typeof autoModel === "string" && autoModel === primary) {
          delete experimental.localModelLean;
          changes.push("Removed onboarding-owned agents.defaults.experimental.localModelLean.");
        } else {
          changes.push(
            "Retained explicit or unowned agents.defaults.experimental.localModelLean=true; remove it or set it to false to restore the full tool capabilities through Tool Search.",
          );
        }
      }
      delete wizard.localModelLeanAutoModel;
      changes.push("Removed retired wizard.localModelLeanAutoModel.");
    },
  },
  {
    id: "runtime.messages-suppress-tool-errors",
    legacyRules: [
      rule(
        ["messages", "suppressToolErrors"],
        "messages.suppressToolErrors is retired; tool failure warnings now appear only when a run ends without a reply.",
      ),
    ],
    apply: (raw, changes) => {
      if (deleteRetiredPath(raw.messages, ["suppressToolErrors"])) {
        changes.push(
          "Removed messages.suppressToolErrors (tool failure warnings now appear only when a run ends without a reply).",
        );
      }
    },
  },
  {
    id: "runtime.retired-internal-hook-handlers",
    legacyRules: [
      {
        path: ["hooks", "internal", "handlers"],
        message:
          'hooks.internal.handlers is retired. Move each module to a managed/workspace hook directory with HOOK.md + handler file before running "openclaw doctor --fix"; the fix removes retired registrations and does not materialize executable files.',
      },
    ],
    apply: (raw, changes) => {
      const internal = getRecord(getRecord(raw.hooks)?.internal);
      if (!internal || !Object.hasOwn(internal, "handlers")) {
        return;
      }

      delete internal.handlers;
      changes.push(
        "Removed retired hooks.internal.handlers registrations; hook files must be migrated separately.",
      );

      const entries = getRecord(internal.entries);
      const extraDirs = getRecord(internal.load)?.extraDirs;
      const hasNamedEntries = Boolean(entries && Object.keys(entries).length > 0);
      const hasExtraDirs =
        Array.isArray(extraDirs) &&
        extraDirs.some((dir) => typeof dir === "string" && dir.trim().length > 0);
      if (internal.enabled === true && !hasNamedEntries && !hasExtraDirs) {
        delete internal.enabled;
        changes.push(
          "Removed legacy-only hooks.internal.enabled to avoid enabling broad hook discovery.",
        );
      }
    },
  },
  probedMigration(
    "runtime.doctor-tier-eval-tranche",
    "Approved tier-eval configuration surfaces were consolidated.",
    migrateTierEvalTranche,
  ),
  probedMigration(
    "runtime.final-layout-polish",
    "Final layout aliases were retired.",
    migrateFinalLayoutRenames,
  ),
  probedMigration(
    "runtime.final-layout-kills",
    "Final layout tuning knobs were retired.",
    migrateFinalLayoutKills,
  ),
  {
    id: "runtime.media-models-consolidation",
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
  },
  probedMigration(
    "runtime.config-tranche",
    "Presentation-only preferences and duplicate tuning options moved to canonical defaults.",
    migrateConfigTranche,
  ),
  {
    id: "runtime.tuning-knobs-purge",
    legacyRules: [
      rule(
        [],
        "Numeric runtime tuning knobs were retired and now use built-in defaults.",
        (_value, root) => stripRetiredTuningKnobs(structuredClone(root)),
      ),
    ],
    apply: stripRetiredTuningKnobs,
  },
  {
    id: "runtime.ui-assistant-identity",
    legacyRules: [
      rule(["ui", "assistant"], "ui.assistant was retired; use agents.list[].identity instead."),
    ],
    apply: removeUiAssistantIdentity,
  },
  {
    id: "runtime.retired-config-keys",
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
        ["agents"],
        "Per-agent tools.message.allowCrossContextSend moved to tools.message.crossContext on the same agent.",
        (value) => {
          let found = false;
          visitAgentConfigScopes({ agents: value }, (scope, path) => {
            found ||=
              path !== "agents.defaults" &&
              Object.hasOwn(
                getRecord(getRecord(scope.tools)?.message) ?? {},
                "allowCrossContextSend",
              );
          });
          return found;
        },
      ),
      rule(["tools", "experimental"], "tools.experimental.planTool moved to tools.updatePlan."),
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
      rule(
        ["agents", "defaults", "compaction", "truncateAfterCompaction"],
        "agents.defaults.compaction.truncateAfterCompaction is retired; byte-triggered compaction now opts in via maxActiveTranscriptBytes alone.",
      ),
    ],
    apply: (raw, changes) => {
      migrateTruncateAfterCompaction(raw, changes);
      if (deleteRetiredPath(raw, ["tui"])) {
        changes.push("Removed retired tui config; the footer uses the default compact display.");
      }
      if (deleteRetiredPath(raw.commands, ["modelsWrite"])) {
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
      if (deleteRetiredPath(getRecord(raw.tools)?.media, ["asyncCompletion"])) {
        changes.push("Removed retired tools.media.asyncCompletion.directSend.");
      }
      migrateMessageCrossContext(raw, changes);
      // planTool was the only tools.experimental member, so the strict schema now
      // rejects the whole container; lift the value, then drop the empty parent.
      const tools = getRecord(raw.tools);
      const experimentalTools = getRecord(tools?.experimental);
      if (tools && experimentalTools) {
        if (Object.hasOwn(experimentalTools, "planTool") && tools.updatePlan === undefined) {
          tools.updatePlan = experimentalTools.planTool;
          changes.push("Moved tools.experimental.planTool → tools.updatePlan.");
        } else {
          changes.push("Removed tools.experimental; tools.updatePlan now owns the switch.");
        }
        delete tools.experimental;
      }
      const talkRealtime = getRecord(getRecord(raw.talk)?.realtime);
      moveLegacyConfigKey(talkRealtime, "voice", "speakerVoice", "talk.realtime", changes);
      migrateDiscordVoice(raw, changes);
      migrateMediaDeepgram(raw, changes);
    },
  },
];
