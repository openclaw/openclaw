import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginOrigin,
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
/** Coverage tests for secrets runtime collector breadth and target surfaces. */
import { resolveSecretRefValues } from "./resolve.js";

const COVERAGE_WEB_PROVIDER_PLUGIN_IDS = vi.hoisted(() => ({
  search: ["brave", "exa", "firecrawl"],
  fetch: ["firecrawl"],
}));
const COVERAGE_CHANNEL_CONTRACTS = vi.hoisted(() => new Map<string, object>());

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => ({}),
}));

vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi: ({ channelId }: { channelId: string }) =>
    COVERAGE_CHANNEL_CONTRACTS.get(channelId),
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  resolveManifestContractPluginIds: ({ contract }: { contract: string }) => {
    if (contract === "webSearchProviders") {
      return [...COVERAGE_WEB_PROVIDER_PLUGIN_IDS.search];
    }
    if (contract === "webFetchProviders") {
      return [...COVERAGE_WEB_PROVIDER_PLUGIN_IDS.fetch];
    }
    return [];
  },
}));

function createCoverageWebProvider(params: {
  pluginId: string;
  id: string;
  envVar: string;
  order: number;
  kind: "webSearch" | "webFetch";
}): PluginWebSearchProviderEntry & PluginWebFetchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.${params.kind}.apiKey`;
  const readConfiguredCredential = (config?: OpenClawConfig): unknown =>
    (
      config?.plugins?.entries?.[params.pluginId]?.config as Partial<
        Record<typeof params.kind, { apiKey?: unknown }>
      >
    )?.[params.kind]?.apiKey;
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} coverage ${params.kind === "webFetch" ? "fetch " : ""}provider`,
    envVars: [params.envVar],
    placeholder: `${params.id}-key`,
    signupUrl: `https://example.com/${params.id}`,
    autoDetectOrder: params.order,
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: readConfiguredCredential,
    setConfiguredCredentialValue: (configTarget, value) => {
      setPathCreateStrict(
        configTarget,
        ["plugins", "entries", params.pluginId, "config", params.kind, "apiKey"],
        value,
      );
    },
    createTool: () => null,
  };
}

const COVERAGE_WEB_SEARCH_PROVIDERS = new Map<string, PluginWebSearchProviderEntry>(
  (
    [
      ["brave", "brave", "BRAVE_API_KEY", 10],
      ["firecrawl", "firecrawl", "FIRECRAWL_API_KEY", 60],
      ["exa", "exa", "EXA_API_KEY", 65],
    ] as const
  ).map(([pluginId, id, envVar, order]) => [
    pluginId,
    createCoverageWebProvider({ pluginId, id, envVar, order, kind: "webSearch" }),
  ]),
);

const COVERAGE_WEB_FETCH_PROVIDERS = new Map(
  [
    createCoverageWebProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      envVar: "FIRECRAWL_API_KEY",
      order: 10,
      kind: "webFetch",
    }),
  ].map((provider) => [provider.pluginId, provider]),
);

// mock-isolation: secret traversal uses the fixed provider inventory below, not installed plugins.
vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: ({
    onlyPluginIds,
  }: {
    onlyPluginIds: readonly string[];
  }) => selectProviders(COVERAGE_WEB_FETCH_PROVIDERS, onlyPluginIds),
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: ({
    onlyPluginIds,
  }: {
    onlyPluginIds: readonly string[];
  }) => selectProviders(COVERAGE_WEB_SEARCH_PROVIDERS, onlyPluginIds),
}));

function selectProviders<T>(catalog: ReadonlyMap<string, T>, ids: readonly string[]) {
  const providers = ids.map((id) => catalog.get(id));
  return providers.every((provider): provider is T => provider !== undefined) ? providers : null;
}

type SecretRegistryEntry = {
  id: string;
  configFile: "openclaw.json" | "auth-profile-store";
  pathPattern: string;
  refPathPattern?: string;
  secretShape: "secret_input" | "sibling_ref";
};

type SecretRefCredentialMatrix = {
  entries: Array<{
    id: string;
    configFile: "openclaw.json" | "auth-profile-store";
    path: string;
    refPath?: string;
    secretShape: SecretRegistryEntry["secretShape"];
  }>;
};

function loadCoverageRegistryEntries(): SecretRegistryEntry[] {
  const matrixPath = path.join(
    process.cwd(),
    "docs/reference/secretref-user-supplied-credentials-matrix.json",
  );
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as SecretRefCredentialMatrix;
  return matrix.entries.map(({ id, configFile, path: pathPattern, refPath, secretShape }) =>
    Object.assign(
      { id, configFile, pathPattern, secretShape },
      refPath ? { refPathPattern: refPath } : {},
    ),
  );
}

// Representative collector paths; channel and plugin suites own their individual contracts.
const COVERAGE_BATCH_KEYS = new Set([
  "agents.entries.*.memory.search.remote.apiKey",
  "agents.entries.*.tts.personas.*.providers.*.apiKey",
  "channels.discord.accounts",
  "channels.discord.root",
  "channels.feishu.accounts",
  "channels.googlechat.root",
  "channels.mattermost.accounts",
  "channels.msteams.root",
  "channels.nextcloud-talk.accounts",
  "channels.qqbot.accounts",
  "channels.qqbot.root",
  "channels.slack.root",
  "gateway.auth.password",
  "gateway.auth.token",
  "gateway.remote.token",
  "memory.search.remote.apiKey",
  "models.providers",
  "talk",
  "plugins.entries.brave.config.webSearch.apiKey",
  "plugins.entries.exa.config.webSearch.apiKey",
  "plugins.entries.firecrawl.config.webFetch.apiKey",
  "plugins.entries.typesafe.config.apiKey",
  "plugins.entries.voice-call.config.twilio.authToken",
]);
const COVERAGE_REGISTRY_ENTRIES = loadCoverageRegistryEntries().filter((entry) =>
  COVERAGE_BATCH_KEYS.has(resolveCoverageBatchKey(entry)),
);
const COVERAGE_BUNDLED_CHANNEL_IDS = [
  ...new Set(
    COVERAGE_REGISTRY_ENTRIES.flatMap((entry) => {
      const [scope, channelId] = entry.id.split(".");
      return scope === "channels" && channelId && channelId !== "qqbot" ? [channelId] : [];
    }),
  ),
];

const RUNTIME_COVERAGE_TEST_TIMEOUT_MS = 240_000;
const COVERAGE_CONFIG_PLUGIN_SOURCE_DIRS = new Map([
  ["voice-call", path.join(process.cwd(), "extensions", "voice-call")],
]);
const PLUGIN_OWNED_OPENCLAW_COVERAGE_EXCLUSIONS = new Set([
  "channels.googlechat.accounts.*.serviceAccount",
]);

let applyResolvedAssignments: typeof import("./runtime-shared.js").applyResolvedAssignments;
let collectConfigAssignments: typeof import("./runtime-config-collectors.js").collectConfigAssignments;
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;
const coverageEnv = (
  [
    ["OPENCLAW_BUNDLED_PLUGINS_DIR", "extensions"],
    ["OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1"],
  ] as const
).map(([key, fallback]) => {
  const previous = process.env[key];
  process.env[key] ??= fallback;
  return { key, previous };
});

afterAll(() => {
  for (const { key, previous } of coverageEnv) {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

function toConcretePathSegments(pathPattern: string, wildcardToken = "sample"): string[] {
  return pathPattern
    .split(".")
    .filter(Boolean)
    .flatMap((segment) =>
      segment === "*"
        ? [wildcardToken]
        : segment.endsWith("[]")
          ? [segment.slice(0, -2), "0"]
          : [segment],
    );
}

function resolveCoverageEnvId(entry: SecretRegistryEntry, fallbackEnvId: string): string {
  return entry.id === "plugins.entries.firecrawl.config.webFetch.apiKey"
    ? "FIRECRAWL_API_KEY"
    : fallbackEnvId;
}

function toCoverageEnvRefId(prefix: string, id: string): string {
  const normalized = id
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const name = normalized || "TARGET";
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12).toUpperCase();
  const maxNameLength = 128 - prefix.length - hash.length - 2;
  return `${prefix}_${name.slice(0, Math.max(1, maxNameLength))}_${hash}`;
}

function addCoveragePluginLoadPath(config: OpenClawConfig, pluginId: string): void {
  const loadPath = COVERAGE_CONFIG_PLUGIN_SOURCE_DIRS.get(pluginId);
  if (!loadPath) {
    return;
  }
  const existing = getPath(config, ["plugins", "load", "paths"]);
  if (Array.isArray(existing) && existing.includes(loadPath)) {
    return;
  }
  const nextIndex = Array.isArray(existing) ? existing.length : 0;
  setPathCreateStrict(config, ["plugins", "load", "paths", nextIndex], loadPath);
}

function resolveCoverageLoadablePluginOrigins(
  entries: readonly SecretRegistryEntry[],
): ReadonlyMap<string, PluginOrigin> | undefined {
  const origins = new Map<string, PluginOrigin>();
  for (const entry of entries) {
    if (!entry.id.startsWith("plugins.entries.")) {
      continue;
    }
    const pluginId = entry.id.split(".")[2];
    const origin = COVERAGE_CONFIG_PLUGIN_SOURCE_DIRS.has(pluginId ?? "") ? "config" : "bundled";
    if (pluginId && origin) {
      origins.set(pluginId, origin);
    }
  }
  return origins.size > 0 ? origins : undefined;
}

function resolveCoverageBatchKey(entry: SecretRegistryEntry): string {
  if (
    [
      "agents.defaults.",
      "agents.entries.*.",
      "gateway.auth.",
      "gateway.remote.",
      "models.providers.*.request.auth.",
    ].some((prefix) => entry.id.startsWith(prefix))
  ) {
    return entry.id;
  }
  if (entry.id.startsWith("channels.")) {
    const segments = entry.id.split(".");
    const channelId = segments[1] ?? "unknown";
    const field = segments.at(-1);
    if (
      field === "accessToken" ||
      field === "password" ||
      (channelId === "slack" &&
        ["appToken", "botToken", "signingSecret", "userToken"].includes(field ?? ""))
    ) {
      return entry.id;
    }
    const scope = segments[2] === "accounts" ? "accounts" : "root";
    return `channels.${channelId}.${scope}`;
  }
  for (const prefix of [
    "tts.providers",
    "models.providers",
    "skills.entries",
    "talk.providers",
    "talk",
  ]) {
    if (entry.id.startsWith(`${prefix}.`)) {
      return prefix;
    }
  }
  return entry.id;
}

function buildCoverageBatches(entries: readonly SecretRegistryEntry[]): SecretRegistryEntry[][] {
  const batches = new Map<string, SecretRegistryEntry[]>();
  for (const entry of entries) {
    const key = resolveCoverageBatchKey(entry);
    const batch = batches.get(key) ?? [];
    batch.push(entry);
    batches.set(key, batch);
  }
  return [...batches.values()];
}

function isRuntimeWebCredentialTarget(entry: SecretRegistryEntry): boolean {
  if (!entry.id.endsWith(".apiKey")) {
    return false;
  }
  return (
    entry.id.startsWith("tools.web.") ||
    (entry.id.startsWith("plugins.entries.") &&
      (entry.id.includes(".config.webSearch.") || entry.id.includes(".config.webFetch.")))
  );
}

function collectOpenClawCoverageEntries(options: {
  includePluginEntries: boolean;
}): SecretRegistryEntry[] {
  return COVERAGE_REGISTRY_ENTRIES.filter(
    (entry) =>
      entry.configFile === "openclaw.json" &&
      entry.id.startsWith("plugins.entries.") === options.includePluginEntries &&
      !PLUGIN_OWNED_OPENCLAW_COVERAGE_EXCLUSIONS.has(entry.id),
  );
}

function applyConfigForOpenClawTarget(
  config: OpenClawConfig,
  entry: SecretRegistryEntry,
  envId: string,
  wildcardToken: string,
): void {
  const resolvedEnvId = resolveCoverageEnvId(entry, envId);
  const refTargetPath =
    entry.secretShape === "sibling_ref" && entry.refPathPattern // pragma: allowlist secret
      ? entry.refPathPattern
      : entry.pathPattern;
  setPathCreateStrict(config, toConcretePathSegments(refTargetPath, wildcardToken), {
    source: "env",
    provider: "default",
    id: resolvedEnvId,
  });
  const set = (target: string, value: unknown) =>
    setPathCreateStrict(config, toConcretePathSegments(target, wildcardToken), value);
  if (entry.id.startsWith("models.providers.")) {
    set("models.providers.*.baseUrl", "https://api.example/v1");
    set("models.providers.*.models", []);
  }
  if (entry.id.startsWith("plugins.entries.")) {
    const pluginId = entry.id.split(".")[2];
    if (pluginId) {
      set(`plugins.entries.${pluginId}.enabled`, true);
      addCoveragePluginLoadPath(config, pluginId);
    }
  }
  if (entry.id === "memory.search.remote.apiKey") {
    set("agents.entries.sample-agent", {});
  }
  if (entry.id === "gateway.auth.password") {
    set("gateway.auth.mode", "password");
  }
  if (entry.id === "gateway.remote.token" || entry.id === "gateway.remote.password") {
    set("gateway.mode", "remote");
    set("gateway.remote.url", "wss://gateway.example");
  }
  if (entry.id === "channels.slack.relay.authToken") {
    set("channels.slack.mode", "relay");
  }
  if (entry.id === "channels.qqbot.clientSecret") {
    set("channels.qqbot.appId", "sample-app-id");
  }
  if (entry.id === "channels.qqbot.accounts.*.clientSecret") {
    set("channels.qqbot.accounts.*.appId", "sample-app-id");
  }
  if (
    [
      "channels.feishu.accounts.*.verificationToken",
      "channels.feishu.accounts.*.encryptKey",
    ].includes(entry.id)
  ) {
    set("channels.feishu.accounts.*.connectionMode", "webhook");
  }
  if (entry.id === "plugins.entries.brave.config.webSearch.apiKey") {
    set("tools.web.search.provider", "brave");
  }
  if (entry.id.startsWith("models.providers.*.request.proxy.tls.")) {
    set("models.providers.*.request.proxy.mode", "explicit-proxy");
    set("models.providers.*.request.proxy.url", "http://proxy.example:8080");
  }
}

async function expectOpenClawCoverageBatchResolved(
  batch: readonly SecretRegistryEntry[],
): Promise<void> {
  const config: OpenClawConfig = {};
  const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_TEST_HOME };
  for (const [index, entry] of batch.entries()) {
    const envId = toCoverageEnvRefId("OPENCLAW_SECRET_TARGET", entry.id);
    env[resolveCoverageEnvId(entry, envId)] = `resolved-${entry.id}`;
    applyConfigForOpenClawTarget(config, entry, envId, `sample-${index}`);
  }
  const resolvedConfig = structuredClone(config);
  const context = createResolverContext({ sourceConfig: config, env });
  if (!batch.length || !batch.every(isRuntimeWebCredentialTarget)) {
    await collectConfigAssignments({
      config: resolvedConfig,
      context,
      loadablePluginOrigins: resolveCoverageLoadablePluginOrigins(batch),
    });
  }
  if (context.assignments.length > 0) {
    const resolved = await resolveSecretRefValues(
      context.assignments.map(({ ref }) => ref),
      {
        config,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });
  }
  if (batch.some(isRuntimeWebCredentialTarget)) {
    await resolveRuntimeWebTools({ sourceConfig: config, resolvedConfig, context });
  }
  for (const [index, entry] of batch.entries()) {
    expect(getPath(resolvedConfig, toConcretePathSegments(entry.id, `sample-${index}`))).toBe(
      `resolved-${entry.id}`,
    );
  }
}

const OPENCLAW_CORE_COVERAGE_BATCHES = buildCoverageBatches(
  collectOpenClawCoverageEntries({ includePluginEntries: false }),
);
const OPENCLAW_PLUGIN_COVERAGE_BATCHES = buildCoverageBatches(
  collectOpenClawCoverageEntries({ includePluginEntries: true }),
);
function toCoverageBatchCase(batch: SecretRegistryEntry[]) {
  const firstEntry = batch[0];
  return {
    name:
      batch.length === 1 && firstEntry
        ? firstEntry.id
        : firstEntry
          ? `${resolveCoverageBatchKey(firstEntry)} (${batch.length})`
          : "empty",
    batch,
  };
}

describe("secrets runtime representative target coverage", () => {
  beforeAll(async () => {
    const [
      sharedRuntime,
      configCollectors,
      runtimeWebTools,
      channelContracts,
      officialExternalChannelContract,
    ] = await Promise.all([
      import("./runtime-shared.js"),
      import("./runtime-config-collectors.js"),
      import("./runtime-web-tools.js"),
      Promise.all(
        COVERAGE_BUNDLED_CHANNEL_IDS.map(
          async (channelId) =>
            [
              channelId,
              await loadBundledPluginFacade<object>({
                pluginId: channelId,
                artifactBasename: "secret-contract-api.js",
              }),
            ] as const,
        ),
      ),
      import("./official-external-channel-secret-contract.js"),
    ]);
    for (const [channelId, contract] of channelContracts) {
      COVERAGE_CHANNEL_CONTRACTS.set(channelId, contract);
    }
    const qqbotContract =
      officialExternalChannelContract.loadOfficialExternalChannelSecretContractApi("qqbot");
    if (!qqbotContract) {
      throw new Error("missing coverage contract for official QQBot channel");
    }
    COVERAGE_CHANNEL_CONTRACTS.set("qqbot", qqbotContract);
    ({ applyResolvedAssignments, createResolverContext } = sharedRuntime);
    ({ collectConfigAssignments } = configCollectors);
    ({ resolveRuntimeWebTools } = runtimeWebTools);
  });

  describe("openclaw.json core and channel registry targets", () => {
    test.each(OPENCLAW_CORE_COVERAGE_BATCHES.map(toCoverageBatchCase))(
      "handles $name",
      async ({ batch }) => {
        await expectOpenClawCoverageBatchResolved(batch);
      },
      RUNTIME_COVERAGE_TEST_TIMEOUT_MS,
    );
  });

  describe("openclaw.json plugin registry targets", () => {
    test.each(OPENCLAW_PLUGIN_COVERAGE_BATCHES.map(toCoverageBatchCase))(
      "handles $name",
      async ({ batch }) => {
        await expectOpenClawCoverageBatchResolved(batch);
      },
      RUNTIME_COVERAGE_TEST_TIMEOUT_MS,
    );
  });
});
