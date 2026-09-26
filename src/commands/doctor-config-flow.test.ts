// Doctor config-flow tests cover config repair, migration, stripping, and validation orchestration.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { writeChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import { buildPluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { warmDoctorConfigFlow } from "./doctor-config-flow-warmup.test-support.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  getDoctorConfigInputForTest,
  runDoctorConfigWithInput,
} from "./doctor-config-flow.test-utils.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

type TerminalNote = (message: string, title?: string) => void;

const terminalNoteMock = vi.hoisted(() => vi.fn<TerminalNote>());
const callGatewayMock = vi.hoisted(() => vi.fn());
const runDoctorRepairSequenceMock = vi.hoisted(() => vi.fn());
const createDoctorPluginMetadataSnapshotScopeParamsMock = vi.hoisted(() => vi.fn());
const runDoctorConfigPreflightOptionsMock = vi.hoisted(() => vi.fn());
const collectDoctorPreviewNotesParamsMock = vi.hoisted(() => vi.fn());
const prepareTailscaleConfigMigrationMock = vi.hoisted(() =>
  vi.fn(({ cfg }: { cfg: OpenClawConfig }) => ({
    config: cfg,
    changes: [] as string[],
    warnings: [] as string[],
  })),
);
const collectImplicitFallbackClobberWarningsMock = vi.hoisted(() =>
  vi.fn<(cfg: unknown) => string[]>(() => []),
);
const noteImplicitFallbackClobberWarningsMock = vi.hoisted(() =>
  vi.fn<(cfg: unknown) => void>((cfg) => {
    const warnings = collectImplicitFallbackClobberWarningsMock(cfg);
    if (warnings.length > 0) {
      terminalNoteMock(warnings.join("\n"), "Doctor warnings");
    }
  }),
);
const legacyConfigMigrationForTest = await vi.hoisted(async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");

  function migrate(raw: unknown): { next: Record<string, unknown> | null; changes: string[] } {
    const root = readNullableRecord(raw);
    if (!root) {
      return { next: null, changes: [] };
    }
    const next = structuredClone(root);
    const changes: string[] = [];

    const internalHooks = readNullableRecord(readNullableRecord(next.hooks)?.internal);
    if (internalHooks && "handlers" in internalHooks) {
      delete internalHooks.handlers;
      changes.push(
        "Removed retired hooks.internal.handlers registrations; hook files must be migrated separately.",
      );
      const entries = readNullableRecord(internalHooks.entries);
      const extraDirs = readNullableRecord(internalHooks.load)?.extraDirs;
      const hasNamedEntries = Boolean(entries && Object.keys(entries).length > 0);
      const hasExtraDirs =
        Array.isArray(extraDirs) &&
        extraDirs.some((dir) => typeof dir === "string" && dir.trim().length > 0);
      if (internalHooks.enabled === true && !hasNamedEntries && !hasExtraDirs) {
        delete internalHooks.enabled;
        changes.push(
          "Removed legacy-only hooks.internal.enabled to avoid enabling broad hook discovery.",
        );
      }
    }

    const gateway = readNullableRecord(next.gateway);
    if (gateway?.bind === "0.0.0.0") {
      gateway.bind = "lan";
      changes.push("Normalized gateway.bind host alias.");
    } else if (gateway?.bind === "localhost" || gateway?.bind === "127.0.0.1") {
      gateway.bind = "loopback";
      changes.push("Normalized gateway.bind host alias.");
    }

    const sessionMaintenance = readNullableRecord(readNullableRecord(next.session)?.maintenance);
    if (sessionMaintenance && "rotateBytes" in sessionMaintenance) {
      delete sessionMaintenance.rotateBytes;
      changes.push("Removed deprecated session.maintenance.rotateBytes.");
    }

    return changes.length > 0 ? { next, changes } : { next: null, changes: [] };
  }

  let partiallyValidOverride: boolean | undefined;

  return {
    migrateLegacyConfig: (raw: unknown) => {
      const { next, changes } = migrate(raw);
      const partiallyValid = partiallyValidOverride;
      return { config: next, changes, ...(partiallyValid ? { partiallyValid } : {}) };
    },
    setPartiallyValidOverride(value: boolean | undefined) {
      partiallyValidOverride = value;
    },
  };
});

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: terminalNoteMock,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./doctor-tailscale.js", () => ({
  prepareTailscaleConfigMigration: prepareTailscaleConfigMigrationMock,
}));

vi.mock("./doctor/repair-sequencing.js", async () => {
  const actual = await vi.importActual<typeof import("./doctor/repair-sequencing.js")>(
    "./doctor/repair-sequencing.js",
  );
  return {
    ...actual,
    runDoctorRepairSequence: (params: unknown) => {
      if (runDoctorRepairSequenceMock.getMockImplementation()) {
        return runDoctorRepairSequenceMock(params);
      }
      return actual.runDoctorRepairSequence(
        params as Parameters<typeof actual.runDoctorRepairSequence>[0],
      );
    },
  };
});

vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", async () => {
  const actual = await vi.importActual<
    typeof import("./doctor/shared/plugin-metadata-snapshot-scope.js")
  >("./doctor/shared/plugin-metadata-snapshot-scope.js");
  return {
    ...actual,
    createDoctorPluginMetadataSnapshotScope: (
      params: Parameters<typeof actual.createDoctorPluginMetadataSnapshotScope>[0],
    ) => {
      createDoctorPluginMetadataSnapshotScopeParamsMock(params);
      return actual.createDoctorPluginMetadataSnapshotScope(params);
    },
  };
});

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: vi.fn(
    ({
      config,
    }: {
      config: {
        plugins?: { allow?: string[]; entries?: Record<string, unknown> };
        tools?: { alsoAllow?: string[] };
      };
    }) => {
      if (!config.tools?.alsoAllow?.includes("browser")) {
        return { config, changes: [], autoEnabledReasons: {} };
      }
      const allow = config.plugins?.allow ?? [];
      if (allow.includes("browser")) {
        return { config, changes: [], autoEnabledReasons: {} };
      }
      return {
        config: {
          ...config,
          plugins: {
            ...config.plugins,
            allow: [...allow, "browser"],
            entries: {
              ...config.plugins?.entries,
              browser: {
                ...(config.plugins?.entries?.browser as Record<string, unknown> | undefined),
                enabled: true,
              },
            },
          },
        },
        changes: ["browser referenced by tools.alsoAllow, enabled automatically."],
        autoEnabledReasons: { browser: ["tools.alsoAllow"] },
      };
    },
  ),
}));

vi.mock("../config/validation.js", () => ({
  validateConfigObjectWithPlugins: vi.fn((config: unknown) => ({ ok: true, config })),
}));

vi.mock("../config/legacy.js", async () => {
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");
  type LegacyRule = {
    path: string[];
    message: string;
    match?: (value: unknown, root: Record<string, unknown>) => boolean;
    requireSourceLiteral?: boolean;
  };

  function getPathValue(root: Record<string, unknown>, pathParts: readonly string[]): unknown {
    let cursor: unknown = root;
    for (const part of pathParts) {
      const record = readNullableRecord(cursor);
      if (!record) {
        return undefined;
      }
      cursor = record[part];
    }
    return cursor;
  }

  function addIssue(
    issues: Array<{ path: string; message: string }>,
    pathParts: readonly string[],
    message: string,
  ) {
    issues.push({ path: pathParts.join("."), message });
  }

  return {
    findLegacyConfigIssues: (raw: unknown, sourceRaw?: unknown, extraRules: LegacyRule[] = []) => {
      const root = readNullableRecord(raw);
      if (!root) {
        return [];
      }
      const sourceRoot = readNullableRecord(sourceRaw) ?? root;
      const issues: Array<{ path: string; message: string }> = [];

      if ("memorySearch" in root) {
        addIssue(
          issues,
          ["memorySearch"],
          'memorySearch is legacy; use memory.search. Run "openclaw doctor --fix".',
        );
      }
      const gateway = readNullableRecord(root.gateway);
      if (gateway && "bind" in gateway) {
        addIssue(
          issues,
          ["gateway", "bind"],
          'gateway.bind host aliases are legacy; use the canonical bind mode. Run "openclaw doctor --fix".',
        );
      }
      const sessionMaintenance = readNullableRecord(readNullableRecord(root.session)?.maintenance);
      if (sessionMaintenance && "rotateBytes" in sessionMaintenance) {
        addIssue(
          issues,
          ["session", "maintenance"],
          'session.maintenance.rotateBytes is deprecated and ignored; run "openclaw doctor --fix" to remove it.',
        );
      }
      const xSearch = readNullableRecord(
        readNullableRecord(readNullableRecord(root.tools)?.web)?.x_search,
      );
      if (xSearch && "apiKey" in xSearch) {
        addIssue(
          issues,
          ["tools", "web", "x_search", "apiKey"],
          'tools.web.x_search.apiKey is legacy; use plugins.entries.xai.config.webSearch.apiKey. Run "openclaw doctor --fix".',
        );
      }
      const internalHooks = readNullableRecord(readNullableRecord(root.hooks)?.internal);
      if (internalHooks && "handlers" in internalHooks) {
        addIssue(
          issues,
          ["hooks", "internal", "handlers"],
          'hooks.internal.handlers is retired. Move each module to a managed/workspace hook directory with HOOK.md + handler file before running "openclaw doctor --fix"; the fix removes retired registrations and does not materialize executable files.',
        );
      }

      for (const rule of extraRules) {
        const value = getPathValue(root, rule.path);
        if (value === undefined || (rule.match && !rule.match(value, root))) {
          continue;
        }
        if (rule.requireSourceLiteral) {
          const sourceValue = getPathValue(sourceRoot, rule.path);
          if (sourceValue === undefined || (rule.match && !rule.match(sourceValue, sourceRoot))) {
            continue;
          }
        }
        addIssue(issues, rule.path, rule.message);
      }
      return issues;
    },
  };
});

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: vi.fn((_channelId: string) => undefined),
}));

vi.mock("../channels/plugins/setup-promotion-helpers.js", () => {
  const commonSingleAccountKeys = new Set([
    "name",
    "token",
    "tokenFile",
    "botId",
    "secret",
    "botToken",
    "webhookPath",
    "webhookUrl",
    "dmPolicy",
    "allowFrom",
    "groupPolicy",
    "groupAllowFrom",
    "defaultTo",
  ]);
  const legacyCommonSingleAccountKeys = new Set([
    "accessToken",
    "appToken",
    "httpUrl",
    "password",
    "userId",
    "webhookSecret",
  ]);
  const declaredSingleAccountKeys: Record<string, readonly string[]> = {
    discord: [],
    imessage: ["cliPath", "dbPath", "service", "region"],
    irc: ["password"],
    matrix: [
      "homeserver",
      "userId",
      "accessToken",
      "password",
      "deviceId",
      "deviceName",
      "avatarUrl",
      "initialSyncLimit",
      "encryption",
    ],
    mattermost: [],
    "nextcloud-talk": ["rooms"],
    signal: ["signalNumber", "account", "cliPath", "httpUrl", "httpHost", "httpPort"],
    slack: ["appToken"],
    telegram: ["streaming", "webhookSecret"],
    tlon: ["url", "code"],
    twitch: ["accessToken"],
    whatsapp: ["authDir"],
    zalo: ["webhookSecret", "tokenFile"],
  };
  const namedAccountPromotionKeys: Record<string, readonly string[]> = {
    matrix: [
      "name",
      "homeserver",
      "userId",
      "accessToken",
      "password",
      "deviceId",
      "deviceName",
      "avatarUrl",
      "initialSyncLimit",
      "encryption",
    ],
    telegram: ["botToken", "tokenFile"],
  };

  const resolveKeys = ({
    channelKey,
    channel,
  }: {
    channelKey: string;
    channel: Record<string, unknown>;
  }) => {
    const accounts =
      channel.accounts && typeof channel.accounts === "object" && !Array.isArray(channel.accounts)
        ? (channel.accounts as Record<string, unknown>)
        : {};
    const hasNamedAccounts = Object.keys(accounts).some(Boolean);
    const allowedNamedKeys = namedAccountPromotionKeys[channelKey];
    const hasDeclarations = Object.hasOwn(declaredSingleAccountKeys, channelKey);
    const declaredKeys = declaredSingleAccountKeys[channelKey];
    return Object.entries(channel)
      .filter(([key, value]) => {
        if (key === "accounts" || key === "enabled" || value === undefined) {
          return false;
        }
        const isKnownKey =
          commonSingleAccountKeys.has(key) ||
          (hasDeclarations
            ? (declaredKeys?.includes(key) ?? false)
            : legacyCommonSingleAccountKeys.has(key));
        if (!isKnownKey) {
          return false;
        }
        if (hasNamedAccounts && allowedNamedKeys && !allowedNamedKeys.includes(key)) {
          return false;
        }
        return true;
      })
      .map(([key]) => key);
  };

  return {
    resolveSingleAccountPromotion: (params: {
      channelKey: string;
      channel: Record<string, unknown>;
    }) => ({
      kind: "promote",
      keysToMove: resolveKeys(params),
      shouldDeferPromotion:
        !Object.hasOwn(declaredSingleAccountKeys, params.channelKey) &&
        Object.keys(params.channel).some(
          (key) =>
            !commonSingleAccountKeys.has(key) &&
            !legacyCommonSingleAccountKeys.has(key) &&
            !["accounts", "defaultAccount", "enabled"].includes(key),
        ),
    }),
  };
});

vi.mock("./doctor/shared/channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: (cfg: Record<string, unknown>) => ({
    next: cfg,
    changes: [],
  }),
}));

vi.mock("./doctor/shared/legacy-config-migrate.js", () => ({
  migrateLegacyConfig: (raw: unknown) => legacyConfigMigrationForTest.migrateLegacyConfig(raw),
}));

vi.mock("./doctor/shared/bundled-plugin-load-paths.js", () => ({
  maybeRepairBundledPluginLoadPaths: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/exec-safe-bins.js", () => ({
  maybeRepairExecSafeBinProfiles: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
    warnings: [],
  })),
}));

vi.mock("./doctor/shared/stale-plugin-config.js", () => ({
  maybeRepairStalePluginConfig: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/plugin-tool-allowlist-warnings.js", () => ({
  collectBundledProviderAllowlistPolicyWarnings: vi.fn(() => []),
  collectPluginToolAllowlistWarnings: vi.fn(() => []),
}));

vi.mock("./doctor/shared/context-engine-host-compat.js", () => ({
  maybeRepairContextEngineHostCompatibility: vi.fn(async ({ cfg }) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: vi.fn(async ({ cfg }) => ({
    config: cfg,
    changes: [],
    warnings: [],
    failedPluginIds: [],
  })),
}));

vi.mock("./doctor/shared/stale-oauth-profile-shadows.js", () => ({
  repairStaleOAuthProfileShadows: vi.fn(async () => ({
    changes: [],
    warnings: [],
  })),
}));

vi.mock("./doctor/channel-capabilities.js", () => {
  const byChannel = {
    googlechat: {
      dmAllowFromMode: "topOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    },
    matrix: {
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    },
    msteams: {
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: true,
      warnOnEmptyGroupSenderAllowlist: true,
    },
    zalouser: {
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    },
  } as const;
  const fallback = {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
  };
  return {
    getDoctorChannelCapabilities: (channelName?: string) =>
      channelName && channelName in byChannel
        ? byChannel[channelName as keyof typeof byChannel]
        : fallback,
    resolveDoctorChannelAccountIds: () => undefined,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const { withDeferredPluginDoctorMigrations } =
    await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const { asNullableRecord: readNullableRecord } =
    await import("@openclaw/normalization-core/record-coerce");

  function hasLegacyTalkFields(value: unknown): boolean {
    const talk = readNullableRecord(value);
    return Boolean(
      talk &&
      ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
        Object.hasOwn(talk, key),
      ),
    );
  }

  const collectRelevantDoctorPluginIds = (raw: unknown): string[] => {
    const ids = new Set<string>();
    const root = readNullableRecord(raw);
    const channels = readNullableRecord(root?.channels);
    for (const channelId of Object.keys(channels ?? {})) {
      if (channelId !== "defaults") {
        ids.add(channelId);
      }
    }
    if (hasLegacyTalkFields(root?.talk)) {
      ids.add("elevenlabs");
    }
    return [...ids].toSorted();
  };
  return {
    collectRelevantDoctorPluginIds,
    withDeferredPluginDoctorMigrations,
    collectDoctorConfigRepairPluginIds: collectRelevantDoctorPluginIds,
    applyPluginDoctorCompatibilityMigrations: (config: unknown) => ({ config, changes: [] }),
    listPluginDoctorLegacyConfigRules: () => [
      {
        path: ["channels", "telegram", "groupMentionsOnly"],
        message:
          'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
      },
      {
        path: ["talk"],
        message:
          "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey are legacy; use talk.providers.<provider> and run openclaw doctor --fix.",
        match: hasLegacyTalkFields,
      },
    ],
  };
});

vi.mock("./doctor/shared/legacy-config-issues.js", async () => {
  const {
    collectRelevantDoctorPluginIds,
    listPluginDoctorLegacyConfigRules,
  }: typeof import("../plugins/doctor-contract-registry.js") =
    await import("../plugins/doctor-contract-registry.js");
  const { findLegacyConfigIssues }: typeof import("../config/legacy.js") =
    await import("../config/legacy.js");
  return {
    findDoctorLegacyConfigIssues: (raw: unknown, sourceRaw?: unknown) =>
      findLegacyConfigIssues(
        raw,
        sourceRaw,
        listPluginDoctorLegacyConfigRules({
          pluginIds: collectRelevantDoctorPluginIds(raw),
        }),
      ),
  };
});

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupCliBackend: vi.fn(() => undefined),
  resolvePluginSetupRegistry: vi.fn(() => ({
    providers: [],
    cliBackends: [],
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  })),
  resolvePluginSetupAutoEnableReasons: vi.fn(() => []),
  runPluginSetupConfigMigrations: vi.fn(({ config }: { config: unknown }) => ({
    config,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorCompatibilityMutations: vi.fn(() => []),
  collectChannelDoctorEmptyAllowlistExtraWarnings: vi.fn(() => []),
  collectChannelDoctorMutableAllowlistWarnings: vi.fn(() => []),
  collectChannelDoctorPreviewWarnings: vi.fn(async () => []),
  collectChannelDoctorRepairMutations: vi.fn(async () => []),
  collectChannelDoctorStaleConfigMutations: vi.fn(async () => []),
  createChannelDoctorEmptyAllowlistPolicyHooks: vi.fn(() => ({
    extraWarningsForAccount: () => [],
    shouldSkipDefaultEmptyGroupAllowlistWarning: ({ channelName }: { channelName: string }) =>
      channelName === "googlechat" || channelName === "telegram",
  })),
  runChannelDoctorConfigSequences: vi.fn(async () => ({ changeNotes: [], warningNotes: [] })),
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: vi.fn(
    ({ channelName }: { channelName: string }) =>
      channelName === "googlechat" || channelName === "telegram",
  ),
}));

vi.mock("./doctor/shared/preview-warnings.js", () => ({
  collectDoctorPreviewNotes: vi.fn(async (params) => {
    collectDoctorPreviewNotesParamsMock(params);
    return { infoNotes: [], warningNotes: [] };
  }),
}));

vi.mock("./doctor-config-preflight.js", async () => {
  const fsLocal = await import("node:fs/promises");
  const pathLocal = await import("node:path");
  const { hashConfigRaw } = await import("../config/io.read-helpers.js");
  const {
    collectRelevantDoctorPluginIds,
    listPluginDoctorLegacyConfigRules,
  }: typeof import("../plugins/doctor-contract-registry.js") =
    await import("../plugins/doctor-contract-registry.js");
  const { findLegacyConfigIssues }: typeof import("../config/legacy.js") =
    await import("../config/legacy.js");

  function resolveConfigPath() {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ||
      (process.env.HOME ? pathLocal.join(process.env.HOME, ".openclaw") : "");
    return process.env.OPENCLAW_CONFIG_PATH || pathLocal.join(stateDir, "openclaw.json");
  }

  return {
    runDoctorConfigPreflight: vi.fn(async (options: unknown) => {
      runDoctorConfigPreflightOptionsMock(options);
      const injected = getDoctorConfigInputForTest();
      const configPath = injected?.path ?? resolveConfigPath();
      let parsed: Record<string, unknown> = injected?.parsed
        ? structuredClone(injected.parsed)
        : injected?.config
          ? structuredClone(injected.config)
          : {};
      let injectedEffectiveConfig = injected?.config ? structuredClone(injected.config) : parsed;
      let exists = injected?.exists ?? false;
      let raw: string | null = exists ? JSON.stringify(parsed) : null;
      if (!injected) {
        try {
          const contents = await fsLocal.readFile(configPath, "utf-8");
          parsed = JSON.parse(contents) as Record<string, unknown>;
          raw = contents;
          exists = true;
          injectedEffectiveConfig = parsed;
        } catch {
          parsed = {};
          injectedEffectiveConfig = parsed;
        }
      }
      const sourceConfigBeforeMigrations = injected?.sourceConfigBeforeMigrations
        ? structuredClone(injected.sourceConfigBeforeMigrations)
        : injectedEffectiveConfig;
      if (injected?.preflightMode === "fast") {
        return {
          snapshot: {
            exists,
            path: configPath,
            raw,
            hash: hashConfigRaw(raw),
            parsed,
            agentRosterIncludeOwned: injected?.agentRosterIncludeOwned === true,
            ...(injected?.includeProvenance
              ? { includeProvenance: injected.includeProvenance }
              : {}),
            sourceConfigBeforeMigrations,
            config: injectedEffectiveConfig,
            sourceConfig: injectedEffectiveConfig,
            valid: true,
            warnings: [],
            legacyIssues: [],
          },
          baseConfig: injectedEffectiveConfig,
        };
      }
      const legacyIssues = findLegacyConfigIssues(
        parsed,
        parsed,
        listPluginDoctorLegacyConfigRules({
          pluginIds: collectRelevantDoctorPluginIds(parsed),
        }),
      );
      // The read path does not apply Doctor-only repairs before the migration owner runs.
      return {
        snapshot: {
          exists,
          path: configPath,
          raw,
          hash: hashConfigRaw(raw),
          parsed,
          agentRosterIncludeOwned: injected?.agentRosterIncludeOwned === true,
          ...(injected?.includeProvenance ? { includeProvenance: injected.includeProvenance } : {}),
          sourceConfigBeforeMigrations,
          config: injectedEffectiveConfig,
          sourceConfig: injectedEffectiveConfig,
          valid: legacyIssues.length === 0,
          warnings: [],
          legacyIssues,
        },
        baseConfig: injectedEffectiveConfig,
      };
    }),
  };
});

vi.mock("./doctor-config-analysis.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-config-analysis.js")>();

  return {
    formatConfigKeyPath: actual.formatConfigKeyPath,
    noteImplicitFallbackClobberWarnings: noteImplicitFallbackClobberWarningsMock,
    noteOpencodeProviderOverrides: vi.fn(),
    noteMcpOriginWarning: vi.fn(),
    noteDoctorHookConfigWarnings: actual.noteDoctorHookConfigWarnings,
    noteMediaCliModelWarnings: actual.noteMediaCliModelWarnings,
    noteMissingDefaultAgentOwner: actual.noteMissingDefaultAgentOwner,
    noteSandboxOriginProxyWarning: vi.fn(),
    resolveConfigPathTarget: actual.resolveConfigPathTarget,
    stripUnknownConfigKeys: vi.fn((config: Record<string, unknown>) => {
      const next = structuredClone(config);
      const removed: string[] = [];
      if ("bridge" in next) {
        delete next.bridge;
        removed.push("bridge");
      }
      const gatewayAuth = actual.resolveConfigPathTarget(next, ["gateway", "auth"]);
      if (
        gatewayAuth &&
        typeof gatewayAuth === "object" &&
        !Array.isArray(gatewayAuth) &&
        "extra" in gatewayAuth
      ) {
        delete (gatewayAuth as Record<string, unknown>).extra;
        removed.push("gateway.auth.extra");
      }
      return { config: next, removed };
    }),
  };
});

function resetTerminalNoteMock() {
  terminalNoteMock.mockClear();
  return terminalNoteMock;
}

async function collectDoctorWarnings(config: Record<string, unknown>): Promise<string[]> {
  const noteSpy = resetTerminalNoteMock();
  await runDoctorConfigWithInput({
    config,
    run: loadAndMaybeMigrateDoctorConfig,
  });
  const warnings: string[] = [];
  for (const [message, title] of noteSpy.mock.calls) {
    if (title === "Doctor warnings") {
      warnings.push(message);
    }
  }
  return warnings;
}

describe("doctor config flow", () => {
  beforeAll(() => warmDoctorConfigFlow(collectDoctorWarnings));

  beforeEach(() => {
    terminalNoteMock.mockClear();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
    runDoctorRepairSequenceMock.mockReset();
    createDoctorPluginMetadataSnapshotScopeParamsMock.mockClear();
    collectDoctorPreviewNotesParamsMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockImplementation(({ cfg }) => ({
      config: cfg,
      changes: [],
      warnings: [],
    }));
    collectImplicitFallbackClobberWarningsMock.mockClear();
    collectImplicitFallbackClobberWarningsMock.mockReturnValue([]);
    noteImplicitFallbackClobberWarningsMock.mockClear();
    runDoctorConfigPreflightOptionsMock.mockClear();
  });

  it("explains GitHub preview recovery without expanding the plugin allowlist", async () => {
    const config = { plugins: { allow: ["telegram"] } };
    const warnings = await collectDoctorWarnings(config);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('append "github" to the existing allowlist'),
      ]),
    );
    expect(config.plugins.allow).toEqual(["telegram"]);
  });

  it("preserves invalid config for doctor repairs", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        gateway: { auth: { mode: "token", token: 123 } },
        agents: { entries: { openclaw: {} } },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect((result.cfg as Record<string, unknown>).gateway).toEqual({
      auth: { mode: "token", token: 123 },
    });
  });

  it("previews and applies the legacy Tailscale Serve migration through Doctor", async () => {
    const config: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
      },
    };
    prepareTailscaleConfigMigrationMock.mockImplementation(({ cfg }) => ({
      config: {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          bind: "loopback" as const,
          tailscale: { ...cfg.gateway?.tailscale, mode: "serve" as const },
        },
      },
      changes: ["Migrated legacy Tailscale Serve to managed ingress."],
      warnings: [],
    }));

    const preview = await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const repair = await runDoctorConfigWithInput({
      config,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(preview.shouldWriteConfig).toBe(false);
    expect(preview.cfg.gateway?.bind).toBe("lan");
    expect(repair.shouldWriteConfig).toBe(true);
    expect(repair.cfg.gateway?.bind).toBe("loopback");
    expect(repair.cfg.gateway?.tailscale?.mode).toBe("serve");
    expect(prepareTailscaleConfigMigrationMock).toHaveBeenCalledTimes(2);
  });

  it("plans persistence of the injected main roster during doctor repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: {
          entries: { main: { workspace: "/tmp/migrated-main" } },
        },
        gateway: { mode: "local" },
      },
      parsedConfig: { gateway: { mode: "local" } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.persistCanonicalAgentRoster).toBe(true);
    expect(result.explicitSetPaths).toBeUndefined();
    expect(result.cfg.agents?.entries).toEqual({
      main: { workspace: "/tmp/migrated-main" },
    });
    // Repair panels defer to the atomic write runner; the flow itself must not
    // claim the roster change happened before anything reached disk.
    expect(result.pendingChangePanels).toContain(
      "Prepared the canonical agent roster without retired default markers for persistence.",
    );
    expect(terminalNoteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
    expect(terminalNoteMock.mock.calls.some(([message]) => message.includes("Persisted"))).toBe(
      false,
    );
  });

  it("previews and persists pre-parse context-budget cleanup with every path reported", async () => {
    const canonical = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                contextTokens: 64_000,
                contextWindow: 128_000,
              },
            ],
          },
        },
      },
      agents: { defaults: {}, entries: { ops: {} } },
    };
    const legacy = {
      models: {
        providers: {
          openai: {
            contextTokens: 64_000,
            contextWindow: 128_000,
            models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
          },
        },
      },
      agents: { defaults: { contextTokens: 48_000 }, entries: { ops: { contextTokens: 32_000 } } },
    };

    await runDoctorConfigWithInput({
      config: canonical,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const previewText = terminalNoteMock.mock.calls.map(([message]) => message).join("\n");
    expect(previewText).toContain(
      "models.providers.openai.contextTokens → models.providers.openai.models[0].contextTokens",
    );
    expect(previewText).toContain("Removed agents.defaults.contextTokens");
    expect(previewText).toContain("Removed agents.entries.ops.contextTokens");
    expect(previewText).toContain("models.providers.<provider>.models[].contextTokens");

    terminalNoteMock.mockClear();
    const repaired = await runDoctorConfigWithInput({
      config: canonical,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(repaired.shouldWriteConfig).toBe(true);
    expect(repaired.cfg).toMatchObject(canonical);
    expect(repaired.pendingChangePanels?.join("\n")).toContain(
      "Removed models.providers.openai.contextWindow after baking it into explicit model entries.",
    );
    expect(terminalNoteMock.mock.calls.map(([message]) => message).join("\n")).toContain(
      "agents.entries.ops.contextTokens cannot be represented per model",
    );
  });

  it("drops roster write intent when a preview repair is declined", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: { default: true } } } },
      parsedConfig: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.persistCanonicalAgentRoster).toBeUndefined();
    expect(result.explicitSetPaths).toBeUndefined();
  });

  it("removes a legacy list when Doctor persists keyed roster entries", async () => {
    const rawConfig = {
      agents: {
        list: [
          { id: "ops", default: true, workspace: "/srv/ops" },
          { id: "research", model: "openai/research" },
        ],
      },
    };
    const result = await runDoctorConfigWithInput({
      config: migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.persistCanonicalAgentRoster).toBe(true);
    expect(result.explicitSetPaths).toEqual([["agents", "ownership"]]);
    expect(result.cfg.agents?.entries).toEqual({
      ops: { workspace: "/srv/ops" },
      research: { model: "openai/research" },
    });
    expect(result.cfg.agents?.ownership).toBe("explicit");
    expect(result.cfg.agents?.entries?.ops).not.toHaveProperty("default");
    expect(result.cfg.agents).not.toHaveProperty("list");
  });

  it("skips root wizard metadata when an include boundary owns the repair", async () => {
    // A retired tuning knob inside an include-owned section is a Doctor repair
    // whose only changed path lives in that include file. The root already
    // carries a canonical roster, so Doctor has no root roster write to make.
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { main: {} } },
        browser: { enabled: true, actionTimeoutMs: 5000 },
      },
      parsedConfig: { agents: { entries: { main: {} } }, browser: { $include: "./browser.json5" } },
      includeProvenance: [
        {
          path: ["browser"],
          kind: "single",
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPath: "/virtual/.openclaw/browser.json5",
        },
      ],
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.browser).toEqual({ enabled: true });
    expect(result.skipWizardMetadataForIncludeWrite).toBe(true);
  });

  it("keeps root wizard metadata when no include boundary owns the repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { main: {} } },
        browser: { enabled: true, actionTimeoutMs: 5000 },
      },
      parsedConfig: {
        agents: { entries: { main: {} } },
        browser: { enabled: true, actionTimeoutMs: 5000 },
      },
      includeProvenance: [],
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.browser).toEqual({ enabled: true });
    expect(result.skipWizardMetadataForIncludeWrite).toBeUndefined();
  });

  it("stamps explicit ownership when Doctor migrates a markerless multi-agent list", async () => {
    const rawConfig = {
      agents: {
        defaults: { workspace: "/srv/legacy-shared" },
        list: [{ id: "ops" }, { id: "research", model: "openai/research" }],
      },
    };
    const result = await runDoctorConfigWithInput({
      config: migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.persistCanonicalAgentRoster).toBe(true);
    expect(result.explicitSetPaths).toEqual([["agents", "ownership"]]);
    expect(result.cfg.agents).toEqual({
      defaults: { workspace: "/srv/legacy-shared" },
      ownership: "explicit",
      entries: {
        ops: { workspace: "/srv/legacy-shared" },
        research: { model: "openai/research" },
      },
    });
  });

  it.each([false, true])(
    "explains how to select a default for an ownerless explicit fleet (repair: %s)",
    async (repair) => {
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      };
      const result = await runDoctorConfigWithInput({
        config,
        parsedConfig: config,
        repair,
        run: loadAndMaybeMigrateDoctorConfig,
      });
      expect(result.cfg.agents).toEqual(config.agents);
      expect(result.shouldWriteConfig).toBe(false);
      expect(terminalNoteMock).toHaveBeenCalledWith(
        expect.stringContaining("openclaw config set agents.defaults.systemAgent.agentId <id>"),
        "Agent ownership",
      );
    },
  );

  it("materializes ambient roles for a multi-agent configured default", async () => {
    const rawConfig = {
      agents: {
        entries: {
          ops: { default: true },
          research: {},
        },
      },
      channels: { telegram: { enabled: true } },
      talk: { provider: "test" },
    };
    const config = migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig;
    const result = await runDoctorConfigWithInput({
      config,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.bindings).toEqual([
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
    ]);
    expect(result.cfg.agents?.defaults).toMatchObject({
      heartbeat: { agentId: "ops" },
      systemAgent: { agentId: "ops" },
      authInheritance: { agentId: "ops" },
    });
    expect(result.cfg.talk).toMatchObject({ provider: "test", agentId: "ops" });
    expect(result.cfg.agents?.entries?.ops).not.toHaveProperty("default");
    expect(result.cfg.agents?.ownership).toBe("explicit");
  });

  it("preserves shared all-agent heartbeat enrollment during materialization", async () => {
    const rawConfig = {
      agents: {
        defaults: { heartbeat: { every: "1h" } },
        entries: { ops: { default: true }, research: {} },
      },
      channels: { telegram: { enabled: true } },
      talk: { provider: "test" },
    };
    const config = migratePersistedImplicitMainRoster(rawConfig).config as OpenClawConfig;
    const result = await runDoctorConfigWithInput({
      config,
      parsedConfig: rawConfig,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents?.defaults?.heartbeat).toEqual({ every: "1h" });
    expect(result.cfg.agents?.defaults?.heartbeat).not.toHaveProperty("agentId");
    expect(result.cfg.agents?.defaults?.systemAgent).toEqual({ agentId: "ops" });
  });

  it("does not rematerialize explicit roles or touch single-agent configs", async () => {
    const materialized = {
      agents: {
        ownership: "explicit" as const,
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
        },
        entries: { ops: { workspace: "/srv/ops" }, research: {} },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
      channels: { telegram: { enabled: true } },
      talk: { provider: "test", agentId: "ops" },
    };
    const secondRun = await runDoctorConfigWithInput({
      config: materialized,
      parsedConfig: materialized,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const singleAgent = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { ops: {} } },
        channels: { telegram: { enabled: true } },
        talk: { provider: "test" },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(secondRun.shouldWriteConfig).toBe(false);
    expect(secondRun.persistCanonicalAgentRoster).toBeUndefined();
    expect(singleAgent.shouldWriteConfig).toBe(false);
    expect(singleAgent.persistCanonicalAgentRoster).toBeUndefined();
  });

  it("preserves malformed keyed entries for schema validation during repair", async () => {
    const agents = { entries: { main: {}, broken: null as never } };
    const result = await runDoctorConfigWithInput({
      config: { agents },
      parsedConfig: { agents },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({
      main: {},
      broken: null,
    });
  });

  it("detects a legacy roster after environment resolution", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { ops: {} } } },
      parsedConfig: { agents: { list: [{ id: "${AGENT_ID}", default: true }] } },
      sourceConfigBeforeMigrations: {
        agents: { list: [{ id: "ops", default: true }] },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents).toEqual({ entries: { ops: {} } });
  });

  it("preserves a roster supplied by an included config during repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { ops: {} } } },
      parsedConfig: { $include: "./agents.json" },
      agentRosterIncludeOwned: true,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.explicitSetPaths).toBeUndefined();
    expect(result.cfg.agents?.entries).toEqual({ ops: {} });
  });

  it("preserves ownership of an explicitly empty included roster", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: {} } } },
      parsedConfig: { $include: "./agents.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
      agentRosterIncludeOwned: true,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("persists an injected roster when a root include contributes only channels", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { main: {} } },
        channels: { telegram: { enabled: true } },
      },
      parsedConfig: { $include: "./channels.json" },
      sourceConfigBeforeMigrations: { channels: { telegram: { enabled: true } } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("repairs a locally authored roster when unrelated includes exist", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: {
          defaults: { workspace: "/tmp/ops" },
          entries: { main: {} },
        },
      },
      parsedConfig: { $include: "./channels.json", agents: { entries: {} } },
      sourceConfigBeforeMigrations: {
        channels: { telegram: { enabled: true } },
        agents: { entries: {} },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents).toEqual({
      defaults: { workspace: "/tmp/ops" },
      entries: { main: {} },
    });
  });

  it("repairs a missing roster when only a nested channel include exists", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: {} } } },
      parsedConfig: { channels: { $include: "./channels.json" } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("does not persist an implicit roster when no config file exists", async () => {
    const result = await runDoctorConfigWithInput({
      config: { agents: { entries: { main: {} } } },
      exists: false,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("enables Doctor-only state migrations only for explicit repair", async () => {
    await runDoctorConfigWithInput({
      config: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });
    expect(runDoctorConfigPreflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ doctorOnlyStateMigrations: false }),
    );

    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    expect(runDoctorConfigPreflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ doctorOnlyStateMigrations: true }),
    );
  });

  it("prepares plugin metadata for the complete Doctor lifecycle", async () => {
    const result = await runDoctorConfigWithInput({
      config: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(runDoctorConfigPreflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ preparePluginMetadataSnapshot: true }),
    );
    expect(result.runWithPluginMetadataSnapshot).toEqual(expect.any(Function));
    expect(result.invalidatePluginMetadataSnapshot).toEqual(expect.any(Function));
  });

  it("exposes cleanup-refreshed plugin metadata to later Doctor scopes", async () => {
    const refreshedSnapshot = {
      plugins: [],
      index: { installRecords: {} },
    } as unknown as PluginMetadataSnapshot;
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warningNotes: [],
      authProfilesRepaired: false,
      pluginMetadataSnapshot: refreshedSnapshot,
    }));

    const result = await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.pluginMetadataSnapshot).toBe(refreshedSnapshot);
    const scopeParams = createDoctorPluginMetadataSnapshotScopeParamsMock.mock.lastCall?.[0] as {
      getBaseSnapshot: () => PluginMetadataSnapshot | undefined;
    };
    expect(scopeParams.getBaseSnapshot()).toBe(refreshedSnapshot);
    expect(scopeParams.getBaseSnapshot()?.index.installRecords).not.toHaveProperty("google-meet");
    result.invalidatePluginMetadataSnapshot();
    expect(scopeParams.getBaseSnapshot()).toBeUndefined();
  });

  it("does not treat noninteractive doctor fix as plugin capability consent", async () => {
    const review = buildPluginCapabilityConsentReview({
      pluginId: "demo",
      manifest: { name: "Demo", contracts: { tools: ["demo.write"] } },
      record: { source: "npm", spec: "@example/demo" },
      config: {},
    });
    let acknowledgment: unknown = "not reviewed";
    runDoctorRepairSequenceMock.mockImplementation(
      async (params: { state: unknown; onCapabilityConsent?: PluginCapabilityConsentHandler }) => {
        acknowledgment = await expectDefined(
          params.onCapabilityConsent,
          "doctor capability handler",
        )(review);
        return {
          state: params.state,
          changeNotes: [],
          warningNotes: [],
          authProfilesRepaired: false,
        };
      },
    );
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { repair: true, yes: true, nonInteractive: true },
    });
    const confirm = vi.spyOn(prompter, "confirmRuntimeRepair");
    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: (params) => loadAndMaybeMigrateDoctorConfig({ ...params, prompter }),
    });

    expect(acknowledgment).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ requiresInteractiveConfirmation: true, initialValue: false }),
    );
    expect(terminalNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("demo.write"),
      "Plugin capabilities",
    );
  });

  it("collects plugin blocker previews from the pre-auto-enable config", async () => {
    await runDoctorConfigWithInput({
      config: {
        plugins: {
          allow: ["existing-plugin"],
        },
        tools: {
          alsoAllow: ["browser"],
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(collectDoctorPreviewNotesParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["existing-plugin", "browser"],
          }),
        }),
        activationSourceConfig: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["existing-plugin"],
          }),
        }),
      }),
    );
  });

  it("reloads gateway secrets and refreshes auth status after auth profile repairs", async () => {
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ["Migrated 1 sidecar-backed Codex OAuth profile."],
      warningNotes: [],
      authProfilesRepaired: true,
    }));

    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "secrets.reload",
      params: {},
      timeoutMs: 3000,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  });

  it("keeps the Codex session auth migration plan outside persisted config", async () => {
    const openAICodexAuthProfileIdMap = new Map([
      ["openai-codex:default", "openai:chatgpt-default"],
    ]);
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: [],
      warningNotes: [],
      authProfilesRepaired: false,
      openAICodexAuthProfileIdMap,
    }));

    const result = await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.openAICodexAuthProfileIdMap).toBe(openAICodexAuthProfileIdMap);
    expect(result.cfg).not.toHaveProperty("openAICodexAuthProfileIdMap");
  });

  it("does not refresh gateway before writing a config-only auth repair", async () => {
    runDoctorRepairSequenceMock.mockImplementation(
      async (params: {
        state: { cfg: Record<string, unknown>; candidate: Record<string, unknown> };
      }) => {
        const repaired = { ...params.state.candidate, auth: { order: {} } };
        return {
          state: {
            ...params.state,
            cfg: repaired,
            candidate: repaired,
            pendingChanges: true,
          },
          changeNotes: ["Removed a stale configured auth order."],
          warningNotes: [],
          authProfilesRepaired: false,
        };
      },
    );

    const result = await runDoctorConfigWithInput({
      config: { auth: { order: { anthropic: ["anthropic:missing"] } } },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.auth?.order).toEqual({});
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("keeps doctor repair silent when gateway secrets reload fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ["Removed stale OAuth auth profile shadow openai-codex."],
      warningNotes: [],
      authProfilesRepaired: true,
    }));

    await expect(
      runDoctorConfigWithInput({
        config: {},
        repair: true,
        run: loadAndMaybeMigrateDoctorConfig,
      }),
    ).resolves.toBeTruthy();

    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "secrets.reload",
      params: {},
      timeoutMs: 3000,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  });

  it("emits warning-only stale channel cleanup without changing config", async () => {
    const input = {
      agents: { entries: { ops: {} } },
      channels: { matrix: { enabled: true } },
    };
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    vi.mocked(channelDoctor.collectChannelDoctorStaleConfigMutations).mockResolvedValueOnce([
      {
        config: { ...input, channels: { matrix: { enabled: false } } },
        changes: [],
        warnings: ["- matrix stale cleanup warning"],
      },
    ]);
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: [],
      warningNotes: [],
      authProfilesRepaired: false,
    }));

    const result = await runDoctorConfigWithInput({
      config: input,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(terminalNoteMock).toHaveBeenCalledWith(
      "- matrix stale cleanup warning",
      "Doctor warnings",
    );
    expect(result.cfg).toEqual(input);
    expect(result.shouldWriteConfig).toBe(false);
  });

  it("previews and repairs hooks token reuse of gateway auth", async () => {
    const config = {
      gateway: {
        auth: {
          mode: "token",
          token: "shared-gateway-token-1234567890",
        },
      },
      hooks: {
        enabled: true,
        token: "shared-gateway-token-1234567890",
      },
    };
    const previewNotes = resetTerminalNoteMock();
    const preview = await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(preview.shouldWriteConfig).toBe(false);
    expect(preview.cfg.hooks?.token).toBe("shared-gateway-token-1234567890");
    expect(
      previewNotes.mock.calls.some(
        ([message, title]) =>
          title === "Doctor changes preview" &&
          message.includes("Rotated hooks.token because it reused active Gateway"),
      ),
    ).toBe(true);
    expect(
      previewNotes.mock.calls.some(
        ([message, title]) =>
          title === "Doctor" &&
          message.includes("openclaw doctor --fix") &&
          message.includes("rotate hooks.token"),
      ),
    ).toBe(true);

    const repair = await runDoctorConfigWithInput({
      config,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(repair.shouldWriteConfig).toBe(true);
    expect(repair.cfg.hooks?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(repair.cfg.hooks?.token).not.toBe("shared-gateway-token-1234567890");
  });

  it("emits implicit fallback clobber warnings from the loaded config", async () => {
    collectImplicitFallbackClobberWarningsMock.mockReturnValueOnce([
      '- agents.list[0].model (id=ops) is "openai/gpt-5.3", a bare string with no fallbacks. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
    ]);
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        entries: { ops: { default: true, model: "openai/gpt-5.3" } },
      },
    };

    await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(noteImplicitFallbackClobberWarningsMock).toHaveBeenCalledTimes(1);
    const [warningParams] = expectDefined(
      (
        noteImplicitFallbackClobberWarningsMock.mock.calls as unknown as Array<
          [{ agents?: unknown }]
        >
      )[0],
      "(noteImplicitFallbackClobberWarningsMock.mock.calls as unknown as Array<\n        [{ agents?: unknown }]\n      >)[0] test invariant",
    );
    expect(warningParams.agents).toStrictEqual(config.agents);
    const doctorWarnings = terminalNoteMock.mock.calls
      .filter(([, title]) => title === "Doctor warnings")
      .map(([message]) => message);
    expect(doctorWarnings.join("\n")).toContain("clobbers agents.defaults.model.fallbacks");
  });

  it.each([false, true])(
    "reports invalid CLI media models without repairing them (repair=%s)",
    async (repair) => {
      const models = [
        { provider: "fixture-provider", capabilities: ["audio"] },
        { type: "cli", capabilities: ["audio"] },
        { type: "cli", command: "fixture-transcribe", capabilities: ["audio"] },
        { type: "cli", command: "fixture-transcribe", args: ["{{AttachmentPath}}"] },
        { command: "fixture-transcribe", args: ["/synthetic/audio.wav"] },
      ] satisfies MediaUnderstandingModelConfig[];
      const config: OpenClawConfig = { plugins: { enabled: false }, tools: { media: { models } } };
      config.agents = { entries: { main: {} } };
      const result = await runDoctorConfigWithInput({
        config,
        repair,
        run: loadAndMaybeMigrateDoctorConfig,
      });
      const warnings = terminalNoteMock.mock.calls
        .filter(([, title]) => title === "Doctor warnings")
        .map(([message]) => message)
        .join("\n");
      expect(warnings).toContain("tools.media.models[1].command");
      expect(warnings).toContain("tools.media.models[2].args");
      expect(warnings).toContain("{{AttachmentPath}}");
      expect(warnings).toContain("Doctor cannot choose");
      expect(warnings).not.toMatch(/tools\.media\.models\[(?:0|3|4)\]/);
      expect(result.cfg.tools?.media).toEqual(config.tools?.media);
      expect(result.shouldWriteConfig, result.pendingChangePanels?.join("\n")).toBe(false);
    },
  );

  it("warns when internal hook entries include unsupported loader keys", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      hooks: {
        internal: {
          entries: {
            "custom-hook": {
              enabled: true,
              handler: "./hooks/custom.ts",
              extraDirs: ["./hooks"],
              env: { OPENCLAW_CUSTOM_HOOK: "1" },
            },
            "valid-hook": {
              enabled: true,
              paths: ["./tracked"],
            },
            "null-hook": null,
          },
        },
      },
    });

    const warning = doctorWarnings.join("\n");
    expect(warning).toContain("hooks.internal.entries.custom-hook:");
    expect(warning).toContain(
      "unsupported loader keys handler, extraDirs will not load hook modules",
    );
    expect(warning).toContain("bootstrap-extra-files for session bootstrap content");
    expect(warning).toContain("Doctor cannot rewrite this automatically");
    expect(warning).not.toContain("hooks.internal.entries.valid-hook");
    expect(warning).not.toContain("hooks.internal.entries.null-hook");
  });

  it("repairs generic legacy config surfaces in one pass", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        bridge: { bind: "auto" },
        gateway: { auth: { mode: "token", token: "ok", extra: true } },
        agents: { entries: { openclaw: { default: true } } },
        session: {
          maintenance: {
            rotateBytes: "10mb",
          },
        },
        browser: {
          relayBindHost: "0.0.0.0",
          profiles: {
            chromeLive: {
              driver: "extension",
              color: "#00AA00",
            },
          },
        },
        tools: {
          alsoAllow: ["browser"],
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as Record<string, unknown>;
    expect(cfg.bridge).toBeUndefined();
    expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
      mode: "token",
      token: "ok",
    });
    const browser = (result.cfg as { browser?: Record<string, unknown> }).browser ?? {};
    expect(browser.relayBindHost).toBeUndefined();
    // driver "extension" is the live Chrome extension relay driver; repair keeps it.
    expect(
      ((browser.profiles as Record<string, { driver?: string }>)?.chromeLive ?? {}).driver,
    ).toBe("extension");
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "browser", "codex"]);
    expect(result.cfg.plugins?.entries?.browser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("removes retired commitments config on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        commitments: {
          enabled: true,
          maxPerDay: 2,
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg).not.toHaveProperty("commitments");
  }, 300_000);

  it("sanitizes config-derived doctor warnings and changes before logging", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  botToken: "tok",
                  allowFrom: ["@\u001b[31mtestuser"],
                },
              },
            },
            slack: {
              accounts: {
                work: {
                  allowFrom: ["alice\u001b[31m\nforged"],
                },
                "ops\u001b[31m\nopen": {
                  dmPolicy: "open",
                },
              },
            },
            whatsapp: {
              accounts: {
                "ops\u001b[31m\nempty": {
                  groupPolicy: "allowlist",
                },
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      // Repair-mode change panels defer to the write runner; sanitized change
      // text travels through pendingChangePanels instead of immediate notes.
      const outputs = [
        ...noteSpy.mock.calls
          .filter((call) => call[1] === "Doctor warnings" || call[1] === "Doctor changes")
          .map((call) => call[0]),
        ...(result.pendingChangePanels ?? []),
      ];
      const joinedOutputs = outputs.join("\n");
      expect(outputs.some((line) => line.includes("\u001b"))).toBe(false);
      expect(outputs.some((line) => line.includes("\nforged"))).toBe(false);
      expect(joinedOutputs).toContain('channels.slack.accounts.opsopen.allowFrom: set to ["*"]');
      expect(joinedOutputs).toContain('required by dmPolicy="open"');
      expect(
        outputs.some(
          (line) =>
            line.includes('channels.whatsapp.accounts.opsempty.groupPolicy is "allowlist"') &&
            line.includes("groupAllowFrom"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("forwards channel repair warnings without changing the channel config", async () => {
    const config = { channels: { telegram: { accounts: { inactive: { enabled: false } } } } };
    const { collectChannelDoctorRepairMutations } =
      await import("./doctor/shared/channel-doctor.js");
    vi.mocked(collectChannelDoctorRepairMutations).mockResolvedValueOnce([
      { config, changes: [], warnings: ["Telegram account inactive: token unavailable"] },
    ]);

    const result = await runDoctorConfigWithInput({
      config,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg.channels).toEqual(config.channels);
    expect(terminalNoteMock).toHaveBeenCalledWith(
      "Telegram account inactive: token unavailable",
      "Doctor warnings",
    );
  });

  it("applies channel repair mutations and queues their change notes", async () => {
    const config = { channels: { discord: { accounts: { default: { allowFrom: [123] } } } } };
    const repaired = { channels: { discord: { accounts: { default: { allowFrom: ["123"] } } } } };
    const { collectChannelDoctorRepairMutations } =
      await import("./doctor/shared/channel-doctor.js");
    vi.mocked(collectChannelDoctorRepairMutations).mockResolvedValueOnce([
      { config: repaired, changes: ["Discord allowlist ids normalized to strings."] },
    ]);

    const result = await runDoctorConfigWithInput({
      config,
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg.channels).toEqual(repaired.channels);
    expect(result.shouldWriteConfig).toBe(true);
    expect(result.pendingChangePanels).toContain("Discord allowlist ids normalized to strings.");
  });

  it("does not restore top-level allowFrom when config is intentionally default-account scoped", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            accounts: {
              default: { token: "discord-default-token", allowFrom: ["123"] },
              work: { token: "discord-work-token" },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          allowFrom?: string[];
          accounts: Record<string, { allowFrom?: string[] }>;
        };
      };
    };

    expect(cfg.channels.discord.allowFrom).toBeUndefined();
    expect(
      expectDefined(
        cfg.channels.discord.accounts.default,
        "cfg.channels.discord.accounts.default test invariant",
      ).allowFrom,
    ).toEqual(["123"]);
  });

  it("defers absent-plugin promotion instead of creating a partial default account", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          "uninstalled-demo": {
            dmPolicy: "allowlist",
            appToken: "covered-legacy-key",
            customAuth: "plugin-owned",
            accounts: {
              work: { enabled: true },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const channel = (
      result.cfg as unknown as {
        channels: Record<
          string,
          {
            dmPolicy?: string;
            appToken?: string;
            customAuth?: string;
            accounts?: Record<string, unknown>;
          }
        >;
      }
    ).channels["uninstalled-demo"];
    expect(channel?.dmPolicy).toBe("allowlist");
    expect(channel?.appToken).toBe("covered-legacy-key");
    expect(channel?.customAuth).toBe("plugin-owned");
    expect(channel?.accounts).toEqual({ work: { enabled: true } });
  });

  it("promotes covered legacy keys when an absent plugin has no declarations", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          "legacy-demo": {
            dmPolicy: "allowlist",
            appToken: "legacy-app-token",
            accounts: {
              work: { enabled: true },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const channel = (
      result.cfg as unknown as {
        channels: Record<
          string,
          { dmPolicy?: string; appToken?: string; accounts?: Record<string, unknown> }
        >;
      }
    ).channels["legacy-demo"];
    expect(channel?.dmPolicy).toBeUndefined();
    expect(channel?.appToken).toBeUndefined();
    expect(channel?.accounts?.default).toEqual({
      dmPolicy: "allowlist",
      appToken: "legacy-app-token",
    });
    expect(channel?.accounts?.work).toEqual({ enabled: true, dmPolicy: "allowlist" });
  });

  it('repairs open dmPolicy allowFrom variants with ["*"] in one pass', async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            token: "test-token",
            dmPolicy: "open",
            groupPolicy: "open",
          },
          googlechat: {
            accounts: {
              work: {
                dmPolicy: "open",
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        discord: { allowFrom: string[]; dmPolicy: string };
        googlechat: {
          accounts: {
            work: {
              dmPolicy: string;
              allowFrom: string[];
              dm?: unknown;
            };
          };
        };
      };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
    expect(cfg.channels.discord.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.accounts.work.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.accounts.work.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.accounts.work.dm).toBeUndefined();
  });

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(
      async (home) => {
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              channels: {
                telegram: {
                  botToken: "fake-token",
                  dmPolicy: "allowlist",
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );
        writeChannelPairingStateSnapshot("telegram", {
          version: 1,
          requests: [],
          allowFrom: { default: ["12345"] },
        });
        return await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });
      },
      { skipSessionCleanup: true },
    );
    closeOpenClawStateDatabaseForTest();

    const cfg = result.cfg as {
      channels: {
        telegram: {
          dmPolicy: string;
          allowFrom: string[];
        };
      };
    };
    expect(cfg.channels.telegram.dmPolicy).toBe("allowlist");
    expect(cfg.channels.telegram.allowFrom).toEqual(["12345"]);
  });

  it("migrates legacy toolsBySender keys to typed id entries on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          whatsapp: {
            groups: {
              "123@g.us": {
                toolsBySender: {
                  owner: { allow: ["exec"] },
                  alice: { deny: ["exec"] },
                  "id:owner": { deny: ["exec"] },
                  "username:@ops-bot": { allow: ["fs.read"] },
                  "*": { deny: ["exec"] },
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>;
            };
          };
        };
      };
    };
    const toolsBySender = cfg.channels.whatsapp.groups["123@g.us"].toolsBySender;
    expect(toolsBySender.owner).toBeUndefined();
    expect(toolsBySender.alice).toBeUndefined();
    expect(toolsBySender["id:owner"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["id:alice"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["username:@ops-bot"]).toEqual({ allow: ["fs.read"] });
    expect(toolsBySender["*"]).toEqual({ deny: ["exec"] });
  });

  it("warns clearly about legacy config surfaces and points to doctor --fix", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        config: {
          memorySearch: {
            provider: "local",
            fallback: "none",
          },
          gateway: {
            bind: "localhost",
          },
          channels: {
            telegram: {
              groupMentionsOnly: true,
            },
          },
          tools: {
            web: {
              x_search: {
                apiKey: "test-key",
              },
            },
          },
          hooks: {
            internal: {
              handlers: [{ event: "command:new", module: "hooks/legacy-handler.js" }],
            },
          },
          session: {
            maintenance: {
              rotateBytes: "10mb",
            },
          },
          talk: {
            voiceId: "voice-1",
            modelId: "eleven_v3",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const legacyMessages = noteSpy.mock.calls
        .filter(([, title]) => title === "Legacy config keys detected")
        .map(([message]) => message)
        .join("\n");

      expect(legacyMessages).toContain("memorySearch:");
      expect(legacyMessages).toContain("use memory.search");
      expect(legacyMessages).toContain("gateway.bind:");
      expect(legacyMessages).toContain("gateway.bind host aliases");
      expect(legacyMessages).toContain("channels.telegram.groupMentionsOnly:");
      expect(legacyMessages).toContain("channels.telegram.groups");
      expect(legacyMessages).toContain("tools.web.x_search.apiKey:");
      expect(legacyMessages).toContain("plugins.entries.xai.config.webSearch.apiKey");
      expect(legacyMessages).toContain("hooks.internal.handlers:");
      expect(legacyMessages).toContain("HOOK.md + handler file");
      expect(legacyMessages).toContain("before running");
      expect(legacyMessages).toContain("does not materialize executable files");
      expect(legacyMessages).toContain("session.maintenance.rotateBytes");
      expect(legacyMessages).toContain("deprecated and ignored");
      expect(legacyMessages).toContain("talk:");
      expect(legacyMessages).toContain(
        "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
      );
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            message.includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockClear();
    }
  });

  it.each([
    [false, false],
    [true, true],
  ] as const)(
    "previews and repairs retired internal hook registrations (repair=%s)",
    async (repair, shouldWriteConfig) => {
      const noteSpy = resetTerminalNoteMock();
      try {
        const result = await runDoctorConfigWithInput({
          config: {
            hooks: {
              internal: {
                enabled: true,
                handlers: [{ event: "command:new", module: "hooks/legacy-handler.js" }],
              },
            },
          },
          repair,
          run: loadAndMaybeMigrateDoctorConfig,
        });

        expect(
          (result.cfg.hooks?.internal as Record<string, unknown> | undefined)?.handlers,
        ).toBeUndefined();
        expect(result.cfg.hooks?.internal?.enabled).toBeUndefined();
        expect(result.shouldWriteConfig).toBe(shouldWriteConfig);
        const removalLine = "Removed retired hooks.internal.handlers registrations";
        if (repair) {
          // Repair panels defer until the atomic write commits.
          expect(
            (result.pendingChangePanels ?? []).some((panel) => panel.includes(removalLine)),
          ).toBe(true);
          expect(noteSpy.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
        } else {
          expect(
            noteSpy.mock.calls.some(
              ([message, title]) =>
                title === "Doctor changes preview" && message.includes(removalLine),
            ),
          ).toBe(true);
        }
      } finally {
        noteSpy.mockClear();
      }
    },
  );

  it("titles the legacy migration panel as a preview when --fix is not passed (#80817)", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      await runDoctorConfigWithInput({
        config: {
          gateway: { bind: "localhost" },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });
      const changeTitles = noteSpy.mock.calls.map(([, title]) => title);
      expect(changeTitles).toContain("Doctor changes preview");
      expect(changeTitles).not.toContain("Doctor changes");
      const previewPanel = noteSpy.mock.calls.find(
        ([message, title]) =>
          title === "Doctor changes preview" && message.includes("Normalized gateway.bind"),
      );
      expect(previewPanel).toBeDefined();
    } finally {
      noteSpy.mockClear();
    }
  });

  it("defers the applied panel to the config write when --fix is passed (#80817)", async () => {
    const noteSpy = resetTerminalNoteMock();
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          gateway: { bind: "localhost" },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });
      const changeTitles = noteSpy.mock.calls.map(([, title]) => title);
      // The flow itself prints nothing as applied; the write runner reports
      // "Doctor changes" only after the atomic write commits.
      expect(changeTitles).not.toContain("Doctor changes");
      expect(changeTitles).not.toContain("Doctor changes preview");
      expect(result.pendingChangePanels?.length).toBeGreaterThan(0);
    } finally {
      noteSpy.mockClear();
    }
  });

  it("preserves valid googlechat top-level DM policy and allowFrom", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          googlechat: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const cfg = result.cfg as {
      channels: {
        googlechat: {
          dmPolicy: string;
          allowFrom: string[];
          dm?: unknown;
        };
      };
    };
    expect(cfg.channels.googlechat.dmPolicy).toBe("open");
    expect(cfg.channels.googlechat.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.dm).toBeUndefined();
  });

  it("does not report repeat talk provider normalization on consecutive repair runs", async () => {
    await withTempHome(
      async (home) => {
        const providerId = "acme-speech";
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              talk: {
                interruptOnSpeech: true,
                silenceTimeoutMs: 1500,
                provider: providerId,
                providers: {
                  [providerId]: {
                    apiKey: "secret-key",
                    voiceId: "voice-123",
                    modelId: "eleven_v3",
                  },
                },
                realtime: {
                  provider: "openai",
                  providers: {
                    openai: {
                      model: "gpt-realtime",
                    },
                  },
                  model: "gpt-realtime",
                  speakerVoice: "cedar",
                  mode: "realtime",
                  transport: "gateway-relay",
                  brain: "agent-consult",
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const noteSpy = resetTerminalNoteMock();
        try {
          await loadAndMaybeMigrateDoctorConfig({
            options: { nonInteractive: true, repair: true },
            confirm: async () => false,
          });
          noteSpy.mockClear();

          const secondRun = await loadAndMaybeMigrateDoctorConfig({
            options: { nonInteractive: true, repair: true },
            confirm: async () => false,
          });
          const secondRunTalkNormalizationLines = [
            ...noteSpy.mock.calls
              .filter((call) => call[1] === "Doctor changes")
              .map((call) => call[0]),
            ...(secondRun.pendingChangePanels ?? []),
          ].filter((line) => line.includes("Normalized talk.provider/providers shape"));
          expect(secondRunTalkNormalizationLines).toStrictEqual([]);
        } finally {
          noteSpy.mockClear();
        }
      },
      { skipSessionCleanup: true },
    );
  });

  it("sets skipPluginValidationOnWrite when legacy migration is only partially valid (#76800)", async () => {
    legacyConfigMigrationForTest.setPartiallyValidOverride(true);
    try {
      const result = await runDoctorConfigWithInput({
        config: {
          gateway: { bind: "localhost" },
          tools: { web: { search: { provider: "brave" } } },
        },
        repair: true,
        preflightMode: "compat",
        run: ({ options, confirm }) =>
          loadAndMaybeMigrateDoctorConfig({ options, confirm: async () => confirm() }),
      });
      expect(result.skipPluginValidationOnWrite).toBe(true);
    } finally {
      legacyConfigMigrationForTest.setPartiallyValidOverride(undefined);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
