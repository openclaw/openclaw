import { beforeEach, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import { withEnv } from "../../test-utils/env.js";
import {
  formatProviderAuthProfileCounts,
  resolveProviderAuthOverview,
} from "./list.auth-overview.js";

const persistedStores = vi.hoisted(() => new Map<string, { profiles: Record<string, unknown> }>());

// mock-isolation: read only synthetic credential stores, never operator credentials.
vi.mock("../../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (agentDir?: string) => persistedStores.get(agentDir ?? "__main__"),
}));

// mock-isolation: synthetic display paths must not depend on the host state directory.
vi.mock("../../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePathForDisplay: (agentDir?: string) =>
    agentDir ? `${agentDir}/auth-profiles.json` : "/tmp/auth-profiles.json",
}));

// mock-isolation: select fixture profiles without loading unrelated credential state.
vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  listProfilesForProvider: (store: OverviewParams["store"], provider: string) =>
    Object.keys(store.profiles).filter((id) => store.profiles[id]?.provider === provider),
}));

type OverviewParams = Parameters<typeof resolveProviderAuthOverview>[0];
function resolveOverview(
  provider: string,
  profiles: OverviewParams["store"]["profiles"],
  cfg: OverviewParams["cfg"] = {},
  agentDir?: string,
) {
  return resolveProviderAuthOverview({
    provider,
    cfg,
    store: { version: 1, profiles },
    modelsPath: `${agentDir ?? "/tmp"}/models.json`,
    agentDir,
  });
}

function providerConfig(provider: string, entry: Omit<ModelProviderConfig, "models">) {
  return { models: { providers: { [provider]: { ...entry, models: [] } } } };
}

beforeEach(() => persistedStores.clear());

it("labels token profiles that only have tokenRef", () => {
  const result = resolveOverview("github-copilot", {
    "github-copilot:default": {
      type: "token",
      provider: "github-copilot",
      tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
    },
  });
  expect(result.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
});

it("reports an explicit provider env SecretRef ahead of stored profiles", () => {
  const cfg = providerConfig("custom", {
    apiKey: "current-provider-key",
    baseUrl: "https://models.example/v1",
  });
  const envRefs = new Map([["models.providers.custom.apiKey", "CUSTOM_PROVIDER_KEY"]]);
  setConfigResolutionFacts(cfg, createConfigResolutionFacts([], new Map(), undefined, envRefs));
  const result = withEnv({ CUSTOM_PROVIDER_KEY: "current-provider-key" }, () =>
    resolveOverview(
      "custom",
      {
        "custom:models-json": createApiKeyCredential("custom", "stale-provider-key"),
      },
      cfg,
    ),
  );

  expect(result.effective).toEqual({
    kind: "env",
    detail: expect.not.stringContaining("current-provider-key"),
  });
  expect(result.profiles.count).toBe(1);
});

it.each([
  ["api-key", "models.json"],
  [undefined, "profiles"],
] as const)("reports the credential inference selects with auth %s", (auth, kind) => {
  const result = resolveOverview(
    "ollama-2",
    {
      "ollama-2:ambient": createApiKeyCredential("ollama-2", "ambient-key"),
    },
    providerConfig("ollama-2", {
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      ...(auth ? { auth } : {}),
      apiKey: "configured-key",
    }),
  );
  expect(result.effective.kind).toBe(kind);
});

it("reports the main auth store for inherited profiles", () => {
  const profileId = "openai:peter@example.test";
  persistedStores.set("__main__", { profiles: { [profileId]: {} } });
  const result = resolveOverview(
    "openai",
    { [profileId]: createOAuthRefreshCredential() },
    {
      auth: {
        profiles: {
          [profileId]: { provider: "openai", mode: "oauth", displayName: "Work account" },
        },
      },
    },
    "/tmp/openclaw-agent-custom",
  );

  expect(result.effective).toEqual({
    kind: "profiles",
    detail: "/tmp/auth-profiles.json",
  });
  expect(result.profiles.labels).toEqual([`${profileId}=OAuth (Work account)`]);
});

const marker = "marker(oauth:openai)";
const masked = expect.not.stringMatching(/marker\(|OPENAI_API_KEY/);
it.each([
  ["oauth:openai", { kind: "models.json", detail: marker }, marker],
  ["OPENAI_API_KEY", { kind: "missing", detail: "missing" }, masked],
] as const)("displays %s without exposing credentials", (apiKey, effective, value) => {
  const result = withEnv({ OPENAI_API_KEY: undefined }, () =>
    resolveOverview(
      "openai",
      {},
      providerConfig("openai", {
        apiKey,
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
      }),
    ),
  );
  expect(result.effective).toEqual(effective);
  expect(result.modelsJson).toMatchObject({ value });
});

it("renders the exact profile count line and survives console secret redaction", async () => {
  const { redactSensitiveText } = await import("../../logging/redact.js");
  const line = formatProviderAuthProfileCounts({ count: 2, oauth: 1, token: 1, apiKey: 0 });
  expect(line).toBe("2 (1 oauth, 1 token, 0 api-key)");
  // key=value counts used to be mistaken for credentials by the console redactor.
  expect(redactSensitiveText(`profiles=${line}`)).toBe(`profiles=${line}`);
});
