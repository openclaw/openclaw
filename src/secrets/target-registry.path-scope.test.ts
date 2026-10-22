import { beforeEach, describe, expect, it, vi } from "vitest";
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

function plugin(id: string, channels: string[] = []): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    channels,
    origin: "config",
    rootDir: `/plugins/${id}`,
    configContracts: { secretInputs: { paths: [{ path: "token" }] } },
  });
}

let query: typeof import("./target-registry-query.js");

function expectUndiscovered(...sources: unknown[]) {
  for (const source of sources) {
    expect(source).not.toHaveBeenCalled();
  }
}

function expectPath(segments: string[], id: string) {
  expect(resolvePath(segments)?.entry.id).toBe(id);
}

const resolvePath = (segments: string[]) => query.resolveConfigSecretTargetByPath(segments);
const resolvePlan = (type: string, pathSegments: string[]) =>
  query.resolvePlanTargetAgainstRegistry({ type, pathSegments });

function discover(...args: Parameters<typeof query.discoverConfigSecretTargets>) {
  return query.discoverConfigSecretTargets(...args).map(({ entry }) => entry.id);
}

function discoverSelected(...args: Parameters<typeof query.discoverConfigSecretTargetsByIds>) {
  return query.discoverConfigSecretTargetsByIds(...args).map(({ entry }) => entry.id);
}

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
      return { secretTargetRegistryEntries: [target("channels.bundled.token")] };
    }
    if (channelId === "external" && !bundledOnly) {
      return { secretTargetRegistryEntries: [target("channels.external.primary")] };
    }
    return undefined;
  });
  mocks.channelRecord.mockReset().mockImplementation((record: PluginManifestRecord) => ({
    secretTargetRegistryEntries:
      record.id === "owner"
        ? [target("channels.external.primary"), target("plugins.entries.owner.config.extraToken")]
        : record.id === "other"
          ? [target("channels.external.secondary")]
          : record.id === "extension"
            ? [target("channels.bundled.extraToken"), target("channels.empty.extraToken")]
            : [],
  }));
  query = await import("./target-registry-query.js");
});

describe("secret target path ownership", () => {
  it.each([
    ["gateway", "mode"],
    ["models", "providers", "example", "baseUrl"],
    ["agents", "defaults", "workspace"],
    ["plugins", "enabled"],
    ["plugins", "entries", "example.plugin", "enabled"],
  ])("rejects non-secret path %j without plugin metadata", (...segments) => {
    expect(resolvePath(segments)).toBeNull();
    expect(resolvePlan("unknown", segments)).toBeNull();
    query.listSecretTargetRegistryEntries({ configPath: segments });
    expectUndiscovered(mocks.metadata, mocks.channel, mocks.channelRecord);
  });

  it("resolves core and auth-profile paths without plugin metadata", () => {
    expectPath(["gateway", "auth", "token"], "gateway.auth.token");
    expect(
      query.resolveSecretPlanTargetByPathCore({
        configFile: "auth-profile-store",
        pathSegments: ["profiles", "example", "key"],
      })?.entry.id,
    ).toBe("auth-profiles.api_key.key");
    expectUndiscovered(mocks.metadata, mocks.channel);
  });

  it("loads only the selected plugin's manifest targets, preserving literal IDs", () => {
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
    expectPath(
      ["plugins", "entries", "web", "config", "webSearch", "apiKey"],
      "plugins.entries.web.config.webSearch.apiKey",
    );
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
    expectPath(["channels", "bundled", "token"], "channels.bundled.token");
    expectUndiscovered(mocks.metadata, mocks.channelRecord);
  });

  it("retains external targets extending bundled and empty channel contracts", () => {
    expectPath(["channels", "bundled", "extraToken"], "channels.bundled.extraToken");
    expectPath(["channels", "empty", "extraToken"], "channels.empty.extraToken");
    expect(resolvePath(["channels", "bundled", "unknown"])).toBeNull();
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("retains all external channel owners and unknown-channel misses", () => {
    expectPath(["channels", "external", "primary"], "channels.external.primary");
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expectPath(["channels", "external", "secondary"], "channels.external.secondary");
    expect(resolvePath(["channels", "unknown", "token"])).toBeNull();
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("uses broader discovery when a selected target is absent from the bundled contract", () => {
    expect(
      discoverSelected({ channels: { bundled: { extraToken: "synthetic-token" } } }, [
        "channels.bundled.extraToken",
      ]),
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
    expect(
      discover({
        channels: {
          external: { primary: "synthetic-primary", secondary: "synthetic-secondary" },
        },
      }),
    ).toEqual(["channels.external.primary", "channels.external.secondary"]);
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
