import { beforeAll, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginOrigin } from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { canonicalizeSecretTargetCoverageId } from "./target-registry-test-helpers.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

type SecretRegistryEntry = ReturnType<typeof listSecretTargetRegistryEntries>[number];

let applyResolvedAssignments: typeof import("./runtime-shared.js").applyResolvedAssignments;
let collectAuthStoreAssignments: typeof import("./runtime-auth-collectors.js").collectAuthStoreAssignments;
let collectConfigAssignments: typeof import("./runtime-config-collectors.js").collectConfigAssignments;
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveSecretRefValues: typeof import("./resolve.js").resolveSecretRefValues;

function toConcretePathSegments(pathPattern: string, wildcardToken = "sample"): string[] {
  const segments = pathPattern.split(".").filter(Boolean);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "*") {
      out.push(wildcardToken);
      continue;
    }
    if (segment.endsWith("[]")) {
      out.push(segment.slice(0, -2), "0");
      continue;
    }
    out.push(segment);
  }
  return out;
}

function resolveCoverageEnvId(entry: SecretRegistryEntry, fallbackEnvId: string): string {
  return entry.id === "plugins.entries.firecrawl.config.webFetch.apiKey"
    ? "FIRECRAWL_API_KEY"
    : fallbackEnvId;
}

function resolveCoverageResolvedPath(entry: SecretRegistryEntry): string {
  return canonicalizeSecretTargetCoverageId(entry.id);
}

function resolveCoverageWildcardToken(index: number): string {
  return `sample-${index}`;
}

function resolveCoverageResolvedSegments(
  entry: SecretRegistryEntry,
  wildcardToken: string,
): string[] {
  return toConcretePathSegments(resolveCoverageResolvedPath(entry), wildcardToken);
}

function buildCoverageLoadablePluginOrigins(
  entries: readonly SecretRegistryEntry[],
): ReadonlyMap<string, PluginOrigin> {
  const origins = new Map<string, PluginOrigin>();
  for (const entry of entries) {
    const [scope, entriesKey, pluginId] = entry.id.split(".");
    if (scope === "plugins" && entriesKey === "entries" && pluginId) {
      origins.set(pluginId, "bundled");
    }
  }
  return origins;
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
  if (entry.id.startsWith("models.providers.")) {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "baseUrl"],
      "https://api.example/v1",
    );
    setPathCreateStrict(config, ["models", "providers", wildcardToken, "models"], []);
  }
  if (entry.id === "gateway.auth.password") {
    setPathCreateStrict(config, ["gateway", "auth", "mode"], "password");
  }
  if (entry.id === "gateway.remote.token" || entry.id === "gateway.remote.password") {
    setPathCreateStrict(config, ["gateway", "mode"], "remote");
    setPathCreateStrict(config, ["gateway", "remote", "url"], "wss://gateway.example");
  }
  if (entry.id === "channels.telegram.webhookSecret") {
    setPathCreateStrict(config, ["channels", "telegram", "webhookUrl"], "https://example.com/hook");
  }
  if (entry.id === "channels.telegram.accounts.*.webhookSecret") {
    setPathCreateStrict(
      config,
      ["channels", "telegram", "accounts", "sample", "webhookUrl"],
      "https://example.com/hook",
    );
  }
  if (entry.id === "channels.slack.signingSecret") {
    setPathCreateStrict(config, ["channels", "slack", "mode"], "http");
  }
  if (entry.id === "channels.slack.accounts.*.signingSecret") {
    setPathCreateStrict(config, ["channels", "slack", "accounts", "sample", "mode"], "http");
  }
  if (entry.id === "channels.zalo.webhookSecret") {
    setPathCreateStrict(config, ["channels", "zalo", "webhookUrl"], "https://example.com/hook");
  }
  if (entry.id === "channels.zalo.accounts.*.webhookSecret") {
    setPathCreateStrict(
      config,
      ["channels", "zalo", "accounts", "sample", "webhookUrl"],
      "https://example.com/hook",
    );
  }
  if (entry.id === "channels.feishu.verificationToken") {
    setPathCreateStrict(config, ["channels", "feishu", "connectionMode"], "webhook");
  }
  if (entry.id === "channels.feishu.encryptKey") {
    setPathCreateStrict(config, ["channels", "feishu", "connectionMode"], "webhook");
  }
  if (entry.id === "channels.feishu.accounts.*.verificationToken") {
    setPathCreateStrict(
      config,
      ["channels", "feishu", "accounts", "sample", "connectionMode"],
      "webhook",
    );
  }
  if (entry.id === "channels.feishu.accounts.*.encryptKey") {
    setPathCreateStrict(
      config,
      ["channels", "feishu", "accounts", "sample", "connectionMode"],
      "webhook",
    );
  }
  if (entry.id === "plugins.entries.brave.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "brave");
  }
  if (entry.id === "plugins.entries.google.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "gemini");
  }
  if (entry.id === "plugins.entries.xai.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "grok");
  }
  if (entry.id === "plugins.entries.moonshot.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "kimi");
  }
  if (entry.id === "plugins.entries.perplexity.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "perplexity");
  }
  if (entry.id === "plugins.entries.firecrawl.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "firecrawl");
  }
  if (entry.id === "plugins.entries.minimax.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "minimax");
  }
  if (entry.id === "plugins.entries.tavily.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "tavily");
  }
  if (entry.id === "models.providers.*.request.auth.token") {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "auth", "mode"],
      "authorization-bearer",
    );
  }
  if (entry.id === "models.providers.*.request.auth.value") {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "auth", "mode"],
      "header",
    );
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "auth", "headerName"],
      "x-api-key",
    );
  }
  if (entry.id.startsWith("models.providers.*.request.proxy.tls.")) {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "proxy", "mode"],
      "explicit-proxy",
    );
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "proxy", "url"],
      "http://proxy.example:8080",
    );
  }
}

function applyAuthStoreTarget(
  store: AuthProfileStore,
  entry: SecretRegistryEntry,
  envId: string,
  wildcardToken: string,
): void {
  if (entry.authProfileType === "token") {
    setPathCreateStrict(store, ["profiles", wildcardToken], {
      type: "token" as const,
      provider: "sample-provider",
      token: "legacy-token",
      tokenRef: {
        source: "env" as const,
        provider: "default",
        id: envId,
      },
    });
    return;
  }
  setPathCreateStrict(store, ["profiles", wildcardToken], {
    type: "api_key" as const,
    provider: "sample-provider",
    key: "legacy-key",
    keyRef: {
      source: "env" as const,
      provider: "default",
      id: envId,
    },
  });
}

async function prepareCoverageSnapshot(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDirs: string[];
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}) {
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: params.env,
  });

  collectConfigAssignments({
    config: resolvedConfig,
    context,
    loadablePluginOrigins: params.loadablePluginOrigins,
  });

  const authStores = params.agentDirs.map((agentDir) => {
    const store = structuredClone(params.loadAuthStore(agentDir));
    collectAuthStoreAssignments({
      store,
      context,
      agentDir,
    });
    return { agentDir, store };
  });

  if (context.assignments.length > 0) {
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  return {
    config: resolvedConfig,
    authStores,
    warnings: context.warnings,
  };
}

describe("secrets runtime target coverage", () => {
  beforeAll(async () => {
    const [sharedRuntime, authCollectors, configCollectors, resolver] = await Promise.all([
      import("./runtime-shared.js"),
      import("./runtime-auth-collectors.js"),
      import("./runtime-config-collectors.js"),
      import("./resolve.js"),
    ]);
    ({ applyResolvedAssignments, createResolverContext } = sharedRuntime);
    ({ collectAuthStoreAssignments } = authCollectors);
    ({ collectConfigAssignments } = configCollectors);
    ({ resolveSecretRefValues } = resolver);
  });

  it("handles every openclaw.json registry target when configured as active", async () => {
    const entries = listSecretTargetRegistryEntries().filter(
      (entry) => entry.configFile === "openclaw.json",
    );
    const config = {} as OpenClawConfig;
    const env: Record<string, string> = {};
    for (const [index, entry] of entries.entries()) {
      const envId = `OPENCLAW_SECRET_TARGET_${index}`;
      const runtimeEnvId = resolveCoverageEnvId(entry, envId);
      const expectedValue = `resolved-${entry.id}`;
      const wildcardToken = resolveCoverageWildcardToken(index);
      env[runtimeEnvId] = expectedValue;
      applyConfigForOpenClawTarget(config, entry, envId, wildcardToken);
    }
    const snapshot = await prepareCoverageSnapshot({
      config,
      env,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
      loadablePluginOrigins: buildCoverageLoadablePluginOrigins(entries),
    });
    for (const [index, entry] of entries.entries()) {
      const resolved = getPath(
        snapshot.config,
        resolveCoverageResolvedSegments(entry, resolveCoverageWildcardToken(index)),
      );
      if (entry.expectedResolvedValue === "string") {
        expect(resolved).toBe(`resolved-${entry.id}`);
      } else {
        expect(typeof resolved === "string" || (resolved && typeof resolved === "object")).toBe(
          true,
        );
      }
    }
  });

  it("handles every auth-profiles registry target", async () => {
    const entries = listSecretTargetRegistryEntries().filter(
      (entry) => entry.configFile === "auth-profiles.json",
    );
    const env: Record<string, string> = {};
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    for (const [index, entry] of entries.entries()) {
      const envId = `OPENCLAW_AUTH_SECRET_TARGET_${index}`;
      env[envId] = `resolved-${entry.id}`;
      applyAuthStoreTarget(authStore, entry, envId, resolveCoverageWildcardToken(index));
    }
    const snapshot = await prepareCoverageSnapshot({
      config: {} as OpenClawConfig,
      env,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => authStore,
    });
    const resolvedStore = snapshot.authStores[0]?.store;
    expect(resolvedStore).toBeDefined();
    for (const [index, entry] of entries.entries()) {
      const resolved = getPath(
        resolvedStore,
        toConcretePathSegments(entry.pathPattern, resolveCoverageWildcardToken(index)),
      );
      expect(resolved).toBe(`resolved-${entry.id}`);
    }
  });
});
