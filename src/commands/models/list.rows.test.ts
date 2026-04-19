import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  shouldSuppressBuiltInModel: vi.fn(() => {
    throw new Error("runtime model suppression should be skipped");
  }),
  loadProviderCatalogModelsForList: vi.fn().mockResolvedValue([
    {
      id: "gpt-5.5",
      name: "gpt-5.5",
      provider: "codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
    },
  ]),
  listProfilesForProvider: vi.fn().mockReturnValue(["codex:synthetic"]),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: mocks.shouldSuppressBuiltInModel,
}));

vi.mock("./list.provider-catalog.js", () => ({
  loadProviderCatalogModelsForList: mocks.loadProviderCatalogModelsForList,
}));

vi.mock("../../agents/auth-profiles/profile-list.js", () => ({
  listProfilesForProvider: mocks.listProfilesForProvider,
}));

vi.mock("../../agents/model-auth.js", () => ({
  resolveAwsSdkEnvVarName: vi.fn().mockReturnValue(undefined),
  resolveEnvApiKey: vi.fn().mockReturnValue(null),
  hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
}));

vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: vi.fn().mockReturnValue([]),
}));

let appendDiscoveredRows: typeof import("./list.rows.js").appendDiscoveredRows;
let appendProviderCatalogRows: typeof import("./list.rows.js").appendProviderCatalogRows;

beforeAll(async () => {
  ({ appendDiscoveredRows, appendProviderCatalogRows } = await import("./list.rows.js"));
});

describe("appendProviderCatalogRows", () => {
  it("can skip runtime model-suppression hooks for provider-catalog fast paths", async () => {
    const rows: ModelRow[] = [];
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "codex:synthetic": {
          type: "token",
          provider: "codex",
          token: "codex-app-server",
        },
      },
      order: {},
    };

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authStore,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "codex", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(rows).toMatchObject([
      {
        key: "codex/gpt-5.5",
        available: true,
        missing: false,
      },
    ]);
  });
});

type StubModel = {
  provider: string;
  id: string;
  name: string;
  input: string[];
  baseUrl?: string;
  api?: string;
  contextWindow?: number;
};

function model(provider: string, id: string): StubModel {
  return { provider, id, name: `${provider}/${id}`, input: ["text"], api: "openai" };
}

function buildContext() {
  return {
    cfg: { models: { providers: {} } },
    authStore: { version: 1, profiles: {}, order: {} },
    configuredByKey: new Map(),
    discoveredKeys: new Set<string>(),
    filter: {},
    skipRuntimeModelSuppression: true,
  };
}

describe("appendDiscoveredRows sort behavior", () => {
  it("sorts by provider then id by default", async () => {
    const rows: Array<{ key: string }> = [];
    const models = [
      model("zulu", "m2"),
      model("alpha", "b"),
      model("alpha", "a"),
      model("mike", "x"),
    ];
    await appendDiscoveredRows({
      rows: rows as never,
      models: models as never,
      context: buildContext() as never,
    });
    expect(rows.map((r) => r.key)).toEqual(["alpha/a", "alpha/b", "mike/x", "zulu/m2"]);
  });

  it("preserves input order when sortByName is false", async () => {
    const rows: Array<{ key: string }> = [];
    const models = [
      model("deepinfra", "curated-top"),
      model("deepinfra", "another"),
      model("deepinfra", "aardvark-last"),
    ];
    await appendDiscoveredRows({
      rows: rows as never,
      models: models as never,
      context: buildContext() as never,
      sortByName: false,
    });
    expect(rows.map((r) => r.key)).toEqual([
      "deepinfra/curated-top",
      "deepinfra/another",
      "deepinfra/aardvark-last",
    ]);
  });

  it("sorts when sortByName is true", async () => {
    const rows: Array<{ key: string }> = [];
    const models = [model("deepinfra", "c"), model("deepinfra", "a"), model("deepinfra", "b")];
    await appendDiscoveredRows({
      rows: rows as never,
      models: models as never,
      context: buildContext() as never,
      sortByName: true,
    });
    expect(rows.map((r) => r.key)).toEqual(["deepinfra/a", "deepinfra/b", "deepinfra/c"]);
  });

  it("preserves discovery order per-provider while still sorting other providers", async () => {
    const rows: Array<{ key: string }> = [];
    const models = [
      model("deepinfra", "z-curated-first"),
      model("deepinfra", "a-second"),
      model("deepinfra", "m-third"),
      model("openai", "gpt-5.4-pro"),
      model("openai", "gpt-5.4"),
    ];
    await appendDiscoveredRows({
      rows: rows as never,
      models: models as never,
      context: buildContext() as never,
      preserveDiscoveryOrderProviders: new Set(["deepinfra"]),
    });
    expect(rows.map((r) => r.key)).toEqual([
      "deepinfra/z-curated-first",
      "deepinfra/a-second",
      "deepinfra/m-third",
      "openai/gpt-5.4",
      "openai/gpt-5.4-pro",
    ]);
  });
});
