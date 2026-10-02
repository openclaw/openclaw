// Legacy runtime agent config migrations for memory, sandbox, and runtime policy keys.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeToolProviderPolicyKey,
  resolveProviderToolPolicy,
} from "../../../agents/provider-tool-policy.js";
import { DEFAULT_SANDBOX_BROWSER_NETWORK } from "../../../agents/sandbox/browser-network.js";
import { isKnownCoreToolId } from "../../../agents/tool-catalog.js";
import { isToolAllowedByPolicyName } from "../../../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../../../agents/tool-policy-shared.js";
import { expandToolGroups, mergeAlsoAllowPolicy } from "../../../agents/tool-policy.js";
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { mergeMissing } from "../../../config/merge-missing.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import { someAgentEntry, visitAgentEntries } from "./legacy-config-record-shared.js";

const LEGACY_MEMORY_SEARCH_FIELD_MAPPINGS = [
  { legacyKey: "chunkSize", parentKey: "chunking", canonicalKey: "tokens" },
  { legacyKey: "chunkOverlap", parentKey: "chunking", canonicalKey: "overlap" },
  { legacyKey: "maxResults", parentKey: "query", canonicalKey: "maxResults" },
] as const;

const MEMORY_SEARCH_RULE: LegacyConfigRule = {
  path: ["memorySearch"],
  message:
    'top-level memorySearch was moved; use memory.search instead. Run "openclaw doctor --fix".',
};

const AGENT_MEMORY_SEARCH_OWNER_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "memorySearch"],
    message: 'agents.defaults.memorySearch moved to memory.search. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.memorySearch moved to agents.entries.*.memory.search. Run "openclaw doctor --fix".',
    match: (value) => someAgentEntry(value, (agent) => agent.memorySearch !== undefined),
  },
];

const LEGACY_MEMORY_SEARCH_AUTO_PROVIDER_RULES: LegacyConfigRule[] = [
  {
    path: ["memorySearch", "provider"],
    message:
      'memorySearch.provider = "auto" is legacy; use "openai" explicitly. Run "openclaw doctor --fix".',
    match: isLegacyMemorySearchAutoProvider,
  },
  {
    path: ["memory", "search", "provider"],
    message:
      'memory.search.provider = "auto" is legacy; use "openai" explicitly. Run "openclaw doctor --fix".',
    match: isLegacyMemorySearchAutoProvider,
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.memorySearch.provider = "auto" is legacy; use "openai" explicitly. Run "openclaw doctor --fix".',
    match: (value) =>
      someAgentEntry(value, (agent) =>
        isLegacyMemorySearchAutoProvider(getAgentMemorySearchRecord(agent)?.provider),
      ),
  },
];

const LEGACY_MEMORY_SEARCH_FLAT_KEY_RULES: LegacyConfigRule[] = [
  {
    path: ["memory", "search"],
    message:
      'memory.search uses legacy flat chunkSize, chunkOverlap, or maxResults fields. Run "openclaw doctor --fix".',
    match: hasLegacyMemorySearchFlatKeys,
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.memorySearch uses legacy flat chunkSize, chunkOverlap, or maxResults fields. Run "openclaw doctor --fix".',
    match: (value) =>
      someAgentEntry(value, (agent) =>
        hasLegacyMemorySearchFlatKeys(getAgentMemorySearchRecord(agent)),
      ),
  },
];

function hasLegacyMemorySearchFlatKeys(value: unknown): boolean {
  const memorySearch = getRecord(value);
  return Boolean(
    memorySearch &&
    LEGACY_MEMORY_SEARCH_FIELD_MAPPINGS.some(({ legacyKey }) =>
      Object.hasOwn(memorySearch, legacyKey),
    ),
  );
}

function getAgentMemorySearchRecord(
  agent: Record<string, unknown>,
): Record<string, unknown> | null {
  return getRecord(agent.memorySearch) ?? getRecord(getRecord(agent.memory)?.search);
}

const UNSUPPORTED_SANDBOX_BROWSER_NETWORK_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "sandbox", "browser", "network"],
    message:
      'agents.defaults.sandbox.browser.network = "none" cannot expose the browser control port. Run "openclaw doctor --fix" to disable the sidecar and restore the dedicated browser network.',
    match: isUnsupportedSandboxBrowserNetwork,
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.sandbox.browser.network = "none" cannot expose the browser control port. Run "openclaw doctor --fix" to disable the affected sidecar and restore the dedicated browser network.',
    match: (value) =>
      someAgentEntry(value, (agent) =>
        isUnsupportedSandboxBrowserNetwork(getSandboxBrowserConfig(agent)?.network),
      ),
  },
];

const PROFILE_CONFIGURED_TOOL_SECTION_RULES: LegacyConfigRule[] = [
  {
    path: ["tools"],
    message:
      'tools.profile filters explicit configured-section tool grants; run "openclaw doctor --fix" to rewrite the explicit grants into a valid allowlist.',
    match: (value) => toolProfileConfiguredSectionsNeedExplicitRepair(value),
  },
  {
    path: ["agents"],
    message:
      'agents.entries.*.tools.profile filters explicit configured-section tool grants; run "openclaw doctor --fix" to rewrite the explicit grants into a valid allowlist.',
    match: (value, root) => {
      const globalTools = getRecord(root.tools);
      const inheritedProfile =
        typeof globalTools?.profile === "string" ? globalTools.profile : undefined;
      const inheritedAlsoAllow = readToolPolicyGrantList(globalTools, "alsoAllow");
      return someAgentEntry(value, (agent) => {
        const agentTools = getRecord(agent.tools);
        return toolProfileConfiguredSectionsNeedExplicitRepair(
          agentTools,
          inheritedProfile,
          inheritedAlsoAllow,
          collectEffectiveConfiguredToolSectionGrants(globalTools, agentTools),
          getRecord(globalTools?.byProvider),
        );
      });
    },
  },
];

const SILENT_REPLY_LEGACY_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "silentReply"],
    message:
      'agents.defaults.silentReply.internal was removed; only channel groups may use NO_REPLY. Run "openclaw doctor --fix" to remove it.',
    match: (value) => hasOwnRecordProperty(value, "internal"),
  },
  {
    path: ["surfaces"],
    message:
      'surfaces.*.silentReply.internal was removed; only channel groups may use NO_REPLY. Run "openclaw doctor --fix" to remove it.',
    match: (value) => hasSurfaceLegacySilentReplyPolicy(value),
  },
];

function isLegacyMemorySearchAutoProvider(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "auto";
}

function migrateLegacyMemorySearchFlatKeys(
  memorySearch: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): void {
  if (!memorySearch) {
    return;
  }
  for (const { legacyKey, parentKey, canonicalKey } of LEGACY_MEMORY_SEARCH_FIELD_MAPPINGS) {
    if (!Object.hasOwn(memorySearch, legacyKey)) {
      continue;
    }
    const legacyValue = memorySearch[legacyKey];
    if (memorySearch[parentKey] === undefined) {
      memorySearch[parentKey] = { [canonicalKey]: legacyValue };
      changes.push(`Moved ${pathLabel}.${legacyKey} → ${pathLabel}.${parentKey}.${canonicalKey}.`);
      delete memorySearch[legacyKey];
      continue;
    }
    const canonicalParent = getRecord(memorySearch[parentKey]);
    if (!canonicalParent) {
      changes.push(`Removed ${pathLabel}.${legacyKey} (${pathLabel}.${parentKey} already set).`);
    } else if (canonicalParent[canonicalKey] === undefined) {
      canonicalParent[canonicalKey] = legacyValue;
      changes.push(`Moved ${pathLabel}.${legacyKey} → ${pathLabel}.${parentKey}.${canonicalKey}.`);
    } else {
      changes.push(
        `Removed ${pathLabel}.${legacyKey} (${pathLabel}.${parentKey}.${canonicalKey} already set).`,
      );
    }
    delete memorySearch[legacyKey];
  }
}

function rewriteLegacyMemorySearchAutoProvider(
  memorySearch: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): void {
  if (!memorySearch || !isLegacyMemorySearchAutoProvider(memorySearch.provider)) {
    return;
  }
  memorySearch.provider = "openai";
  changes.push(`Moved ${pathLabel}.provider from legacy "auto" to "openai".`);
}

function migrateCanonicalMemorySearches(
  raw: Record<string, unknown>,
  changes: string[],
  migrateMemorySearch: (
    memorySearch: Record<string, unknown> | null,
    pathLabel: string,
    changes: string[],
  ) => void,
): void {
  migrateMemorySearch(getRecord(getRecord(raw.memory)?.search), "memory.search", changes);
  visitAgentEntries(raw, (agent, path) => {
    migrateMemorySearch(
      getRecord(getRecord(agent.memory)?.search),
      `${path}.memory.search`,
      changes,
    );
  });
}

function getSandboxBrowserConfig(container: unknown): Record<string, unknown> | null {
  return getRecord(getRecord(getRecord(container)?.sandbox)?.browser);
}

function isUnsupportedSandboxBrowserNetwork(value: unknown): boolean {
  return normalizeOptionalLowercaseString(value) === "none";
}

function migrateExplicitUnsupportedSandboxBrowserNetwork(
  browser: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (!isUnsupportedSandboxBrowserNetwork(browser.network)) {
    return;
  }
  browser.enabled = false;
  browser.network = DEFAULT_SANDBOX_BROWSER_NETWORK;
  changes.push(
    `Disabled ${pathLabel} and moved its unsupported network "none" → "${DEFAULT_SANDBOX_BROWSER_NETWORK}".`,
  );
}

function migrateAgentBrowserInheritedFromUnsupportedDefault(params: {
  agent: unknown;
  pathLabel: string;
  defaultBrowserEnabled: boolean;
  changes: string[];
}): void {
  const browser = getSandboxBrowserConfig(params.agent);
  if (!browser) {
    return;
  }
  const hasExplicitNetwork = typeof browser.network === "string";
  const network = normalizeOptionalLowercaseString(browser.network);
  if (network === "none") {
    migrateExplicitUnsupportedSandboxBrowserNetwork(browser, params.pathLabel, params.changes);
    return;
  }
  if (!hasExplicitNetwork && browser.enabled === true) {
    browser.enabled = false;
    params.changes.push(
      `Disabled ${params.pathLabel} because it inherited unsupported browser network "none".`,
    );
    return;
  }
  if (hasExplicitNetwork && browser.enabled === undefined && params.defaultBrowserEnabled) {
    browser.enabled = true;
    params.changes.push(
      `Set ${params.pathLabel}.enabled to true to preserve its explicit supported network while disabling the unsupported default browser network.`,
    );
  }
}

function migrateUnsupportedSandboxBrowserNetworks(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  const defaultBrowser = getSandboxBrowserConfig(defaults);
  const defaultNetworkUnsupported = isUnsupportedSandboxBrowserNetwork(defaultBrowser?.network);
  const defaultBrowserEnabled = defaultBrowser?.enabled === true;
  visitAgentEntries(raw, (agent, path) => {
    const pathLabel = `${path}.sandbox.browser`;
    if (defaultNetworkUnsupported) {
      migrateAgentBrowserInheritedFromUnsupportedDefault({
        agent,
        pathLabel,
        defaultBrowserEnabled,
        changes,
      });
      return;
    }
    const browser = getSandboxBrowserConfig(agent);
    if (browser) {
      migrateExplicitUnsupportedSandboxBrowserNetwork(browser, pathLabel, changes);
    }
  });

  if (defaultBrowser) {
    migrateExplicitUnsupportedSandboxBrowserNetwork(
      defaultBrowser,
      "agents.defaults.sandbox.browser",
      changes,
    );
  }
}

function hasOwnRecordProperty(value: unknown, key: string): boolean {
  const record = getRecord(value);
  return Boolean(record && Object.hasOwn(record, key));
}

function hasSurfaceLegacySilentReplyPolicy(value: unknown): boolean {
  const surfaces = getRecord(value);
  if (!surfaces) {
    return false;
  }
  return Object.entries(surfaces).some(
    ([surfaceId, surface]) =>
      !isBlockedObjectKey(surfaceId) &&
      hasOwnRecordProperty(getRecord(surface)?.silentReply, "internal"),
  );
}

function removeLegacySilentReplyConfig(raw: Record<string, unknown>, changes: string[]): void {
  const scopes: Array<[string, unknown]> = [["agents.defaults", getRecord(raw.agents)?.defaults]];
  for (const [surfaceId, surface] of Object.entries(getRecord(raw.surfaces) ?? {})) {
    if (!isBlockedObjectKey(surfaceId)) {
      scopes.push([`surfaces.${surfaceId}`, surface]);
    }
  }
  for (const [path, value] of scopes) {
    const container = getRecord(value);
    if (!container) {
      continue;
    }
    const silentReply = getRecord(container.silentReply);
    if (silentReply && Object.hasOwn(silentReply, "internal")) {
      delete silentReply.internal;
      changes.push(`Removed ${path}.silentReply.internal; internal sessions never use NO_REPLY.`);
    }
  }
}

const CONFIGURED_TOOL_SECTION_GRANTS = [
  { key: "exec", grants: ["exec", "process"] },
  { key: "fs", grants: ["read", "write", "edit"] },
] as const;

function readToolPolicyGrantList(value: unknown, key: "allow" | "alsoAllow"): string[] {
  return readOwnToolPolicyGrantList(value, key) ?? [];
}

function readOwnToolPolicyGrantList(
  value: unknown,
  key: "allow" | "alsoAllow",
): string[] | undefined {
  const tools = getRecord(value);
  return Array.isArray(tools?.[key])
    ? tools[key].filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function resolveToolProfileForMigration(
  tools: Record<string, unknown>,
  inheritedProfile?: string,
): string | undefined {
  return typeof tools.profile === "string" ? tools.profile : inheritedProfile;
}

function collectProfileConfiguredSectionRepairGrants(params: {
  value: unknown;
  inheritedProfile?: string;
  inheritedAlsoAllow?: string[];
  configuredGrants: string[];
}): string[] {
  const tools = getRecord(params.value);
  if (!tools) {
    return [];
  }
  const profile = resolveToolProfileForMigration(tools, params.inheritedProfile);
  if (!profile || profile === "full") {
    return [];
  }
  const ownAllow = readToolPolicyGrantList(tools, "allow");
  if (ownAllow.length === 0) {
    return [];
  }
  const explicitAlsoAllow = readOwnToolPolicyGrantList(tools, "alsoAllow");
  const explicitPolicy = {
    allow: uniqueStrings([...ownAllow, ...(explicitAlsoAllow ?? [])]),
  };
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    explicitAlsoAllow ?? params.inheritedAlsoAllow ?? [],
  );
  return uniqueStrings(
    params.configuredGrants.filter(
      (toolName) =>
        isToolAllowedByPolicyName(toolName, explicitPolicy) &&
        (!isToolAllowedByPolicyName(toolName, profilePolicy) ||
          (explicitAlsoAllow
            ? isToolAllowedByPolicyName(toolName, { allow: explicitAlsoAllow })
            : false)),
    ),
  );
}

function toolProfileConfiguredSectionsNeedExplicitRepair(
  value: unknown,
  inheritedProfile?: string,
  inheritedAlsoAllow?: string[],
  configuredGrantsOverride?: string[],
  inheritedByProvider?: Record<string, unknown> | null,
): boolean {
  const tools = getRecord(value);
  if (!tools) {
    return false;
  }
  const configuredGrants = configuredGrantsOverride ?? collectConfiguredToolSectionGrants(tools);
  return (
    collectProfileConfiguredSectionRepairGrants({
      value,
      inheritedProfile,
      inheritedAlsoAllow,
      configuredGrants,
    }).length > 0 ||
    byProviderToolProfilesNeedConfiguredSectionMigration(
      tools,
      configuredGrants,
      readOwnToolPolicyGrantList(tools, "alsoAllow") ?? inheritedAlsoAllow,
      inheritedByProvider,
    )
  );
}

function collectConfiguredToolSectionGrants(tools: Record<string, unknown>): string[] {
  const grants: string[] = [];
  for (const section of CONFIGURED_TOOL_SECTION_GRANTS) {
    if (getRecord(tools[section.key])) {
      grants.push(...section.grants);
    }
  }
  return uniqueStrings(grants);
}

function collectEffectiveConfiguredToolSectionGrants(
  inheritedTools: Record<string, unknown> | null | undefined,
  tools: Record<string, unknown> | null | undefined,
): string[] {
  const includeInheritedSections = typeof tools?.profile !== "string";
  return uniqueStrings([
    ...(includeInheritedSections && inheritedTools
      ? collectConfiguredToolSectionGrants(inheritedTools)
      : []),
    ...(tools ? collectConfiguredToolSectionGrants(tools) : []),
  ]);
}

function resolveProfileBoundAllowGrants(params: {
  tools: Record<string, unknown>;
  profile: string;
  allow: string[];
  inheritedAlsoAllow?: string[];
  configuredGrants: string[];
}): string[] {
  const explicitAlsoAllow = readOwnToolPolicyGrantList(params.tools, "alsoAllow");
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(params.profile),
    explicitAlsoAllow ?? params.inheritedAlsoAllow ?? [],
  );
  const profileAllow = expandToolGroups(profilePolicy?.allow);
  const coreAllow = profileAllow.includes("*")
    ? expandToolGroups(params.allow)
    : profileAllow.filter((toolName) =>
        isToolAllowedByPolicyName(toolName, { allow: params.allow }),
      );
  const pluginAllow = expandToolGroups(params.allow).filter((entry) => {
    if (entry === "*" || isKnownCoreToolId(entry)) {
      return false;
    }
    return !profileAllow.some((toolName) =>
      isToolAllowedByPolicyName(toolName, { allow: [entry] }),
    );
  });
  return uniqueStrings([...coreAllow, ...pluginAllow, ...params.configuredGrants]);
}

function byProviderToolProfilesNeedConfiguredSectionMigration(
  tools: Record<string, unknown>,
  configuredGrants: string[],
  inheritedAlsoAllow?: string[],
  inheritedByProvider?: Record<string, unknown> | null,
): boolean {
  const byProvider = getRecord(tools.byProvider);
  return Boolean(
    byProvider &&
    Object.entries(byProvider).some(([providerKey, policy]) => {
      const inheritedProviderPolicy = resolveInheritedProviderPolicy(
        inheritedByProvider,
        providerKey,
      );
      const inheritedProviderProfile =
        typeof inheritedProviderPolicy?.profile === "string"
          ? inheritedProviderPolicy.profile
          : undefined;
      const hasProviderProfile =
        typeof getRecord(policy)?.profile === "string" || Boolean(inheritedProviderProfile);
      if (!hasProviderProfile) {
        return false;
      }
      return (
        collectProfileConfiguredSectionRepairGrants({
          value: policy,
          inheritedProfile: inheritedProviderProfile,
          inheritedAlsoAllow:
            readOwnToolPolicyGrantList(inheritedProviderPolicy, "alsoAllow") ?? inheritedAlsoAllow,
          configuredGrants,
        }).length > 0
      );
    }),
  );
}

function addProfileConfiguredSectionGrants(
  value: unknown,
  pathLabel: string,
  changes: string[],
  inheritedProfile?: string,
  inheritedAlsoAllow?: string[],
  configuredGrantsOverride?: string[],
  materializeProfile = true,
): void {
  const tools = getRecord(value);
  if (!tools || !materializeProfile) {
    return;
  }
  const profile = resolveToolProfileForMigration(tools, inheritedProfile);
  if (!profile) {
    return;
  }
  const configuredGrants = configuredGrantsOverride ?? collectConfiguredToolSectionGrants(tools);
  const repairGrants = collectProfileConfiguredSectionRepairGrants({
    value: tools,
    inheritedProfile,
    inheritedAlsoAllow,
    configuredGrants,
  });
  const allow = readToolPolicyGrantList(tools, "allow");
  if (repairGrants.length === 0 || allow.length === 0 || profile === "full") {
    return;
  }
  const ownAlsoAllow = readOwnToolPolicyGrantList(tools, "alsoAllow");
  tools.allow = resolveProfileBoundAllowGrants({
    tools,
    profile,
    allow: uniqueStrings([...allow, ...(ownAlsoAllow ?? [])]),
    inheritedAlsoAllow,
    configuredGrants: repairGrants,
  });
  changes.push(
    `Replaced ${pathLabel}.allow entries with profile "${profile}" grants plus explicit configured-section grants.`,
  );
  if (ownAlsoAllow) {
    delete tools.alsoAllow;
    changes.push(`Merged ${pathLabel}.alsoAllow into ${pathLabel}.allow.`);
  }
  tools.profile = "full";
  changes.push(
    `Set ${pathLabel}.profile to "full" so ${pathLabel}.allow controls explicit configured-section grants directly.`,
  );
}

function addByProviderProfileConfiguredSectionGrants(
  value: unknown,
  pathLabel: string,
  changes: string[],
  configuredGrantsOverride?: string[],
  inheritedProfile?: string,
  inheritedByProvider?: Record<string, unknown> | null,
): void {
  const tools = getRecord(value);
  if (!tools) {
    return;
  }
  const configuredGrants = configuredGrantsOverride ?? collectConfiguredToolSectionGrants(tools);
  if (configuredGrants.length === 0) {
    return;
  }
  const byProvider = getRecord(tools.byProvider);
  for (const [providerKey, providerPolicy] of Object.entries(byProvider ?? {})) {
    if (isBlockedObjectKey(providerKey)) {
      continue;
    }
    const inheritedProviderPolicy = resolveInheritedProviderPolicy(
      inheritedByProvider,
      providerKey,
    );
    const ownsProviderProfile = typeof getRecord(providerPolicy)?.profile === "string";
    const inheritedProviderProfile =
      typeof inheritedProviderPolicy?.profile === "string"
        ? inheritedProviderPolicy.profile
        : undefined;
    const providerInheritedProfile = inheritedProviderProfile ?? inheritedProfile;
    const providerInheritedAlsoAllow = readOwnToolPolicyGrantList(
      inheritedProviderPolicy,
      "alsoAllow",
    );
    addProfileConfiguredSectionGrants(
      providerPolicy,
      `${pathLabel}.byProvider.${providerKey}`,
      changes,
      providerInheritedProfile,
      providerInheritedAlsoAllow,
      configuredGrants,
      ownsProviderProfile || Boolean(inheritedProviderProfile),
    );
  }
}

function resolveInheritedProviderPolicy(
  inheritedByProvider: Record<string, unknown> | null | undefined,
  providerKey: string,
): Record<string, unknown> | null {
  const normalized = normalizeToolProviderPolicyKey(providerKey);
  const slashIndex = normalized.indexOf("/");
  const byProvider = Object.fromEntries(
    Object.entries(inheritedByProvider ?? {}).filter(([key]) => !isBlockedObjectKey(key)),
  );
  return getRecord(
    resolveProviderToolPolicy({ byProvider, modelProvider: normalized }) ??
      (slashIndex > 0
        ? resolveProviderToolPolicy({ byProvider, modelProvider: normalized.slice(0, slashIndex) })
        : undefined),
  );
}

function bindingMatchHasLegacyDmPeerKind(binding: unknown): boolean {
  const match = getRecord(getRecord(binding)?.match);
  const peer = getRecord(match?.peer);
  return peer !== null && peer.kind === "dm";
}

const BINDING_DM_PEER_KIND_RULE: LegacyConfigRule = {
  path: ["bindings"],
  message:
    'bindings[].match.peer.kind uses the retired "dm" alias; use "direct". Run "openclaw doctor --fix".',
  match: (value) =>
    Array.isArray(value) && value.some((binding) => bindingMatchHasLegacyDmPeerKind(binding)),
};

/** Legacy config migration specs for agent/runtime-owned config keys. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "bindings.match.peer.kind.dm-to-direct",
    describe: "Move deprecated bindings match.peer.kind dm values to direct",
    legacyRules: [BINDING_DM_PEER_KIND_RULE],
    apply: (raw, changes) => {
      if (!Array.isArray(raw.bindings)) {
        return;
      }
      let migrated = 0;
      for (const binding of raw.bindings) {
        const match = getRecord(getRecord(binding)?.match);
        const peer = getRecord(match?.peer);
        if (peer !== null && peer.kind === "dm") {
          peer.kind = "direct";
          migrated += 1;
        }
      }
      if (migrated > 0) {
        changes.push(
          `Moved deprecated bindings[].match.peer.kind "dm" → "direct" for ${migrated} binding${migrated === 1 ? "" : "s"}.`,
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "tools.profile-configured-sections-alsoAllow",
    describe: "Repair explicit configured-section tool grants filtered by profiles",
    legacyRules: PROFILE_CONFIGURED_TOOL_SECTION_RULES,
    apply: (raw, changes) => {
      const globalTools = getRecord(raw.tools);
      const inheritedProfile =
        typeof globalTools?.profile === "string" ? globalTools.profile : undefined;
      const inheritedAlsoAllow = readToolPolicyGrantList(globalTools, "alsoAllow");
      addProfileConfiguredSectionGrants(raw.tools, "tools", changes);
      addByProviderProfileConfiguredSectionGrants(
        raw.tools,
        "tools",
        changes,
        undefined,
        inheritedProfile,
      );
      visitAgentEntries(raw, (agent, path) => {
        const agentTools = getRecord(agent.tools);
        const configuredGrants = collectEffectiveConfiguredToolSectionGrants(
          globalTools,
          agentTools,
        );
        addProfileConfiguredSectionGrants(
          agentTools,
          `${path}.tools`,
          changes,
          inheritedProfile,
          inheritedAlsoAllow,
          configuredGrants,
        );
        addByProviderProfileConfiguredSectionGrants(
          agentTools,
          `${path}.tools`,
          changes,
          configuredGrants,
          resolveToolProfileForMigration(agentTools ?? {}, inheritedProfile),
          getRecord(globalTools?.byProvider),
        );
      });
    },
  }),
  defineLegacyConfigMigration({
    id: "silentReply.internal-removed",
    describe: "Remove legacy internal silent reply config",
    legacyRules: SILENT_REPLY_LEGACY_RULES,
    apply: removeLegacySilentReplyConfig,
  }),
  defineLegacyConfigMigration({
    id: "agents.sandbox.browser.network-none",
    describe: "Disable sandbox browser sidecars that use unsupported network mode none",
    legacyRules: UNSUPPORTED_SANDBOX_BROWSER_NETWORK_RULES,
    apply: migrateUnsupportedSandboxBrowserNetworks,
  }),
  defineLegacyConfigMigration({
    id: "memorySearch->memory.search",
    describe: "Move memory search config to its canonical memory owner",
    legacyRules: [MEMORY_SEARCH_RULE, ...AGENT_MEMORY_SEARCH_OWNER_RULES],
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      const legacyDefaults = getRecord(defaults?.memorySearch);
      const legacyTopLevel = getRecord(raw.memorySearch);
      const memory = getRecord(raw.memory);
      const canonical = getRecord(memory?.search);

      if (legacyDefaults || legacyTopLevel) {
        const target = structuredClone(canonical ?? {});
        if (legacyDefaults) {
          mergeMissing(target, legacyDefaults);
          delete defaults!.memorySearch;
        }
        if (legacyTopLevel) {
          mergeMissing(target, legacyTopLevel);
          delete raw.memorySearch;
        }
        ensureRecord(raw, "memory").search = target;
        changes.push(
          canonical
            ? "Merged legacy memorySearch defaults → memory.search (kept explicit memory.search values)."
            : "Moved legacy memorySearch defaults → memory.search.",
        );
      }

      visitAgentEntries(raw, (agent, path) => {
        const legacy = getRecord(agent.memorySearch);
        if (!legacy) {
          return;
        }
        const agentMemory = ensureRecord(agent, "memory");
        const existing = getRecord(agentMemory.search);
        const target = structuredClone(existing ?? {});
        mergeMissing(target, legacy);
        agentMemory.search = target;
        delete agent.memorySearch;
        changes.push(
          existing
            ? `Merged ${path}.memorySearch → ${path}.memory.search (kept explicit memory.search values).`
            : `Moved ${path}.memorySearch → ${path}.memory.search.`,
        );
      });
    },
  }),
  defineLegacyConfigMigration({
    id: "memorySearch.flat-fields->nested-fields",
    describe: "Move legacy flat memory search fields to canonical nested fields",
    legacyRules: LEGACY_MEMORY_SEARCH_FLAT_KEY_RULES,
    apply: (raw, changes) =>
      migrateCanonicalMemorySearches(raw, changes, migrateLegacyMemorySearchFlatKeys),
  }),
  defineLegacyConfigMigration({
    id: "memorySearch.provider-auto->openai",
    describe: 'Rewrite legacy memorySearch provider "auto" to "openai"',
    legacyRules: LEGACY_MEMORY_SEARCH_AUTO_PROVIDER_RULES,
    apply: (raw, changes) =>
      migrateCanonicalMemorySearches(raw, changes, rewriteLegacyMemorySearchAutoProvider),
  }),
  defineLegacyConfigMigration({
    id: "session.typingMode->agents.defaults.typingMode",
    describe: "Move session typing mode to agent defaults",
    legacyRules: [
      {
        path: ["session", "typingMode"],
        message:
          'session.typingMode moved to agents.defaults.typingMode. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.hasOwn(session, "typingMode")) {
        return;
      }
      const defaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
      const replacedDefault = defaults.typingMode !== undefined;
      defaults.typingMode = session.typingMode;
      changes.push(
        replacedDefault
          ? "Moved session.typingMode → agents.defaults.typingMode (replaced the previously shadowed agent default)."
          : "Moved session.typingMode → agents.defaults.typingMode.",
      );
      delete session.typingMode;
    },
  }),
];
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
