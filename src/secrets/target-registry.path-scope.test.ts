import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), channel: vi.fn(), channelRecord: vi.fn() }));

// mock-isolation: Keep filesystem discovery and process-wide metadata outside this owner test.
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: mocks.metadata,
}));
// mock-isolation: Supply fixed contract artifacts without executing installed plugins.
vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi: mocks.channel,
  loadChannelSecretContractApiForRecord: mocks.channelRecord,
}));

function target(id: string): SecretTargetRegistryEntry {
  return {
    id,
    targetType: id,
    configFile: "openclaw.json",
    pathPattern: id,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  };
}
const contract = (...ids: string[]) => ({ secretTargetRegistryEntries: ids.map(target) });

function plugin(id: string, channels: string[] = []): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    channels,
    origin: "config",
    rootDir: `/plugins/${id}`,
    configContracts: { secretInputs: { paths: [{ path: "token" }, { path: "token" }] } },
  });
}

let query: typeof import("./target-registry-query.js");

function expectUndiscovered(...sources: unknown[]) {
  for (const source of sources) {
    expect(source).not.toHaveBeenCalled();
  }
}

function expectPath(path: string) {
  expect(resolvePath(path.split("."))?.entry.id).toBe(path);
}

const resolvePath = (segments: string[]) => query.resolveConfigSecretTargetByPath(segments);
const resolvePlan = (type: string, pathSegments: string[]) =>
  query.resolvePlanTargetAgainstRegistry({ type, pathSegments });
const resolveCore = (configFile: "openclaw.json" | "auth-profile-store", path: string[]) =>
  query.resolveSecretPlanTargetByPathCore({ configFile, pathSegments: path });

function discover(...args: Parameters<typeof query.discoverConfigSecretTargets>) {
  return query.discoverConfigSecretTargets(...args).map(({ entry }) => entry.id);
}

function discoverSelected(...args: Parameters<typeof query.discoverConfigSecretTargetsByIds>) {
  return query.discoverConfigSecretTargetsByIds(...args).map(({ entry }) => entry.id);
}
const channelConfig = (id: string, ...fields: string[]) => ({
  channels: { [id]: Object.fromEntries(fields.map((field) => [field, "synthetic-token"])) },
});

beforeEach(async () => {
  vi.resetModules();
  mocks.metadata.mockReset().mockReturnValue({
    plugins: [
      plugin("example.plugin"),
      {
        ...plugin("web"),
        configContracts: undefined,
        contracts: { webSearchProviders: ["web"] },
        configUiHints: { "webSearch.apiKey": { sensitive: true } },
      },
      { ...plugin("owner", ["external"]), configContracts: undefined },
      plugin("other", ["external"]),
      plugin("extension", ["bundled", "empty"]),
    ],
  });
  mocks.channel.mockReset().mockImplementation(({ channelId, bundledOnly }) => {
    if (channelId === "empty") {
      return {};
    }
    if (channelId === "bundled") {
      return contract("channels.bundled.token");
    }
    if (channelId === "external" && !bundledOnly) {
      return contract("channels.external.primary");
    }
    return undefined;
  });
  const contracts: Record<string, string[]> = {
    owner: ["channels.external.primary", "plugins.entries.owner.config.extraToken"],
    other: ["channels.external.secondary"],
    extension: ["channels.bundled.extraToken", "channels.empty.extraToken"],
  };
  mocks.channelRecord
    .mockReset()
    .mockImplementation((record: PluginManifestRecord) =>
      contract(...(contracts[record.id] ?? [])),
    );
  query = await import("./target-registry-query.js");
});

describe("secret target path ownership", () => {
  it.each([
    ["gateway", "mode"],
    ["models", "providers", "example", "baseUrl"],
    ["agents", "defaults", "workspace"],
    ["plugins", "enabled"],
    ["plugins", "entries", "example.plugin", "enabled"],
    ["gateway", "auth", "mode"],
    ["memory", "search", "remote", "headers", "Authorization"],
    ["agents", "entries", "main", "memory", "search", "remote", "headers", "Authorization"],
  ])("rejects non-secret path %j without plugin metadata", (...segments) => {
    expect(resolvePath(segments)).toBeNull();
    expect(resolvePlan("unknown", segments)).toBeNull();
    query.listSecretTargetRegistryEntries({ configPath: segments });
    expectUndiscovered(mocks.metadata, mocks.channel, mocks.channelRecord);
  });

  it("resolves core and auth-profile paths without plugin metadata", () => {
    expectPath("gateway.auth.token");
    expect(resolveCore("auth-profile-store", ["profiles", "example", "key"])?.entry).toMatchObject({
      id: "auth-profiles.api_key.key",
      targetType: "auth-profiles.api_key.key",
    });
    expectUndiscovered(mocks.metadata, mocks.channel);
    expect(resolveCore("openclaw.json", ["models", "providers", "openai", "apiKey"])).toMatchObject(
      { entry: { targetType: "models.providers.apiKey" }, providerId: "openai" },
    );
    const connection = { source: "env" as const, provider: "default", id: "DATABASE_DSN" };
    expect(
      query
        .discoverConfigSecretTargetsByIds(
          { database: { engine: "postgres", postgres: { connection } } },
          ["database.postgres.connection"],
        )
        .map(({ path, value }) => ({ path, value })),
    ).toEqual([{ path: "database.postgres.connection", value: connection }]);
    expect(resolveCore("openclaw.json", ["database", "postgres", "connection"])?.entry.id).toBe(
      "database.postgres.connection",
    );
  });

  it("preserves dotted provider header keys during discovery", () => {
    const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
    const config = {
      models: {
        providers: {
          openai: {
            headers: { "X.Trace": envRef("TRACE_HEADER") },
            request: { headers: { "X.Request.Trace": envRef("REQUEST_TRACE_HEADER") } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      query
        .discoverConfigSecretTargetsByIds(
          config,
          new Set(["models.providers.*.headers.*", "models.providers.*.request.headers.*"]),
        )
        .map(({ path }) => path)
        .toSorted(),
    ).toEqual([
      'models.providers.openai.headers["X.Trace"]',
      'models.providers.openai.request.headers["X.Request.Trace"]',
    ]);
  });

  it("deduplicates the selected plugin's manifest targets, preserving literal IDs", () => {
    const segments = ["plugins", "entries", "example.plugin", "config", "token"];
    expect(resolvePath(segments)?.pathSegments).toEqual(segments);
    expect(
      query
        .listSecretTargetRegistryEntries({ configPath: segments })
        .filter(({ id }) => id.startsWith("plugins.entries"))
        .map(({ id }) => id),
    ).toEqual(['plugins.entries["example.plugin"].config.token']);
    expect(mocks.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIds: ["example.plugin"] }),
    );
    expectUndiscovered(mocks.channel, mocks.channelRecord);
  });

  it("resolves manifest web-provider targets without unrelated channel contracts", () => {
    expectPath("plugins.entries.web.config.webSearch.apiKey");
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["owner", "extraToken", "extraToken", false],
    ["family", "alternate", "token", true],
  ] as const)("resolves %s contract after a manifest miss", (id, field, typeField, manifest) => {
    if (manifest) {
      mocks.metadata.mockReturnValue({ plugins: [plugin(id, [id])] });
    }
    const type = `plugins.entries.${id}.config.${typeField}`;
    mocks.channelRecord.mockReturnValue({
      secretTargetRegistryEntries: [
        { ...target(`plugins.entries.${id}.config.${field}`), targetType: type },
      ],
    });
    const segments = ["plugins", "entries", id, "config", field];
    if (!manifest) {
      expect(resolvePath(segments)?.pathSegments).toEqual(segments);
    }
    expect(resolvePlan(type, segments)?.pathSegments).toEqual(segments);
    expect(mocks.channelRecord.mock.calls.map(([record]) => record.id)).toEqual([id]);
  });

  it.each([
    ["owner", "extraToken", false],
    ["owner", "extraToken", true],
    ["example.plugin", "token", false],
  ] as const)("discovers disabled %s.%s (prepared=%s)", (id, key, prepared) => {
    const config = {
      plugins: {
        enabled: false,
        entries: {
          [id]: { enabled: false, config: { [key]: "synthetic-token" } },
        },
      },
    };
    const manifestRegistry = prepared
      ? {
          plugins: [
            { ...plugin("owner", ["external"]), configContracts: undefined },
            plugin("other", ["external"]),
          ],
        }
      : undefined;
    const targets = query.discoverConfigSecretTargets(config, { manifestRegistry });
    expect(targets.map(({ pathSegments }) => pathSegments)).toEqual([
      ["plugins", "entries", id, "config", key],
    ]);
    if (id === "owner") {
      expect(targets.map(({ entry }) => entry.id)).toEqual([`plugins.entries.${id}.config.${key}`]);
      expect(mocks.channelRecord.mock.calls.map(([record]) => record.id)).toEqual([id]);
    } else {
      expectUndiscovered(mocks.channel, mocks.channelRecord);
    }
  });

  it("resolves bundled channel hits without metadata discovery", () => {
    expectPath("channels.bundled.token");
    expect(resolvePath(["channels", "bundled", "token"])?.refPathSegments).toBeUndefined();
    expectUndiscovered(mocks.metadata, mocks.channelRecord);
  });

  it("discovers selected configured channel targets without plugin metadata", () => {
    expect(discoverSelected(channelConfig("bundled", "token"), ["channels.bundled.token"])).toEqual(
      ["channels.bundled.token"],
    );
    expectUndiscovered(mocks.metadata, mocks.channelRecord);
  });

  it.each([
    ["channels.bundled.token", ["channels", "bundled", "token"]],
    ["auth-profiles.api_key.key", ["profiles", "openai:default", "key"]],
  ] as const)("resolves %s plan targets without plugin metadata", (type, segments) => {
    expect(resolvePlan(type, [...segments])?.entry.id).toBe(type);
    expectUndiscovered(mocks.metadata, mocks.channelRecord);
  });

  it("retains external targets extending bundled and empty channel contracts", () => {
    expectPath("channels.bundled.extraToken");
    expectPath("channels.empty.extraToken");
    expect(resolvePath(["channels", "bundled", "unknown"])).toBeNull();
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("retains all external channel owners and unknown-channel misses", () => {
    expectPath("channels.external.primary");
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expectPath("channels.external.secondary");
    expect(resolvePath(["channels", "unknown", "token"])).toBeNull();
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("uses broader discovery when a selected target is absent from the bundled contract", () => {
    expect(
      discoverSelected(channelConfig("bundled", "extraToken"), ["channels.bundled.extraToken"]),
    ).toEqual(["channels.bundled.extraToken"]);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("ignores unconfigured plugin target IDs without metadata discovery", () => {
    expect(
      discoverSelected(
        { cron: { webhookToken: "synthetic-token" }, channels: {}, plugins: { entries: {} } },
        [
          "cron.webhookToken",
          "channels.external.primary",
          "plugins.entries.web.config.webSearch.apiKey",
        ],
      ),
    ).toEqual(["cron.webhookToken"]);
    expectUndiscovered(mocks.metadata, mocks.channel, mocks.channelRecord);
  });

  it("discovers every configured external channel owner", () => {
    expect(discover(channelConfig("external", "primary", "secondary"))).toEqual([
      "channels.external.primary",
      "channels.external.secondary",
    ]);
  });

  it("uses prepared manifests without loading contracts for absent channel subtrees", () => {
    expect(
      discover(
        { cron: { webhookToken: "synthetic-token" } },
        { manifestRegistry: { plugins: [plugin("owner", ["external"])] } },
      ),
    ).toEqual(["cron.webhookToken"]);
    expectUndiscovered(mocks.metadata, mocks.channel, mocks.channelRecord);
  });
});
