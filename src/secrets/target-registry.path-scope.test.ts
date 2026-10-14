import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  channel: vi.fn(),
  channelRecord: vi.fn(),
}));

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
  return {
    id,
    channels,
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "config",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}/index.js`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    configContracts: { secretInputs: { paths: [{ path: "token" }] } },
  };
}

let query: typeof import("./target-registry-query.js");
beforeEach(async () => {
  vi.resetModules();
  mocks.metadata.mockReset().mockReturnValue({
    plugins: [
      plugin("example.plugin"),
      {
        ...plugin("web-plugin"),
        configContracts: undefined,
        contracts: { webSearchProviders: ["web"] },
        configUiHints: { "webSearch.apiKey": { sensitive: true } },
      },
      { ...plugin("external-owner", ["external"]), configContracts: undefined },
      plugin("second-owner", ["external"]),
      plugin("bundled-extension", ["bundled", "empty"]),
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
      record.id === "external-owner"
        ? [
            target("channels.external.primary"),
            target("plugins.entries.external-owner.config.contractToken"),
          ]
        : record.id === "second-owner"
          ? [target("channels.external.secondary")]
          : record.id === "bundled-extension"
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
    expect(query.resolveConfigSecretTargetByPath(segments)).toBeNull();
    expect(
      query.resolvePlanTargetAgainstRegistry({ type: "unknown", pathSegments: segments }),
    ).toBeNull();
    query.listSecretTargetRegistryEntries({ configPath: segments });
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expect(mocks.channel).toHaveBeenCalledTimes(0);
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it("resolves core and auth-profile paths without plugin metadata", () => {
    expect(query.resolveConfigSecretTargetByPath(["gateway", "auth", "token"])?.entry.id).toBe(
      "gateway.auth.token",
    );
    expect(
      query.resolveSecretPlanTargetByPathCore({
        configFile: "auth-profile-store",
        pathSegments: ["profiles", "example", "key"],
      })?.entry.id,
    ).toBe("auth-profiles.api_key.key");
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expect(mocks.channel).toHaveBeenCalledTimes(0);
  });

  it("loads only the selected plugin's manifest targets, preserving literal IDs", () => {
    const segments = ["plugins", "entries", "example.plugin", "config", "token"];
    expect(query.resolveConfigSecretTargetByPath(segments)?.pathSegments).toEqual(segments);
    expect(
      query
        .listSecretTargetRegistryEntries({ configPath: segments })
        .filter(({ id }) => id.startsWith("plugins.entries"))
        .map(({ id }) => id),
    ).toEqual(['plugins.entries["example.plugin"].config.token']);
    expect(mocks.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIds: ["example.plugin"] }),
    );
    expect(mocks.channel).toHaveBeenCalledTimes(0);
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it("resolves manifest web-provider targets without unrelated channel contracts", () => {
    expect(
      query.resolveConfigSecretTargetByPath([
        "plugins",
        "entries",
        "web-plugin",
        "config",
        "webSearch",
        "apiKey",
      ])?.entry.id,
    ).toBe("plugins.entries.web-plugin.config.webSearch.apiKey");
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it("resolves an external channel's own plugin config target on a manifest miss", () => {
    const segments = ["plugins", "entries", "external-owner", "config", "contractToken"];
    expect(query.resolveConfigSecretTargetByPath(segments)?.pathSegments).toEqual(segments);
    expect(
      query.resolvePlanTargetAgainstRegistry({
        type: "plugins.entries.external-owner.config.contractToken",
        pathSegments: segments,
      })?.pathSegments,
    ).toEqual(segments);
    expect(mocks.channelRecord.mock.calls.map(([record]) => record.id)).toEqual(["external-owner"]);
  });

  it("tries the owner's contract when a manifest target type matches but its path misses", () => {
    mocks.metadata.mockReturnValue({ plugins: [plugin("family-owner", ["family"])] });
    mocks.channelRecord.mockReturnValue({
      secretTargetRegistryEntries: [
        {
          ...target("plugins.entries.family-owner.config.alternateToken"),
          targetType: "plugins.entries.family-owner.config.token",
        },
      ],
    });
    const segments = ["plugins", "entries", "family-owner", "config", "alternateToken"];
    expect(
      query.resolvePlanTargetAgainstRegistry({
        type: "plugins.entries.family-owner.config.token",
        pathSegments: segments,
      })?.pathSegments,
    ).toEqual(segments);
  });

  it.each([false, true])(
    "discovers disabled channel-plugin config targets without a channel subtree (prepared=%s)",
    (prepared) => {
      const config = {
        plugins: {
          enabled: false,
          entries: {
            "external-owner": { enabled: false, config: { contractToken: "synthetic-token" } },
          },
        },
      };
      expect(
        query
          .discoverConfigSecretTargets(
            config,
            prepared
              ? {
                  manifestRegistry: {
                    plugins: [
                      { ...plugin("external-owner", ["external"]), configContracts: undefined },
                      plugin("second-owner", ["external"]),
                    ],
                  },
                }
              : undefined,
          )
          .map(({ entry }) => entry.id),
      ).toEqual(["plugins.entries.external-owner.config.contractToken"]);
      expect(mocks.channelRecord.mock.calls.map(([record]) => record.id)).toEqual([
        "external-owner",
      ]);
    },
  );

  it("resolves bundled channel hits without metadata discovery", () => {
    expect(query.resolveConfigSecretTargetByPath(["channels", "bundled", "token"])?.entry.id).toBe(
      "channels.bundled.token",
    );
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it("retains external targets extending bundled and empty channel contracts", () => {
    expect(
      query.resolveConfigSecretTargetByPath(["channels", "bundled", "extraToken"])?.entry.id,
    ).toBe("channels.bundled.extraToken");
    expect(
      query.resolveConfigSecretTargetByPath(["channels", "empty", "extraToken"])?.entry.id,
    ).toBe("channels.empty.extraToken");
    expect(query.resolveConfigSecretTargetByPath(["channels", "bundled", "unknown"])).toBeNull();
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("retains all external channel owners and unknown-channel misses", () => {
    expect(
      query.resolveConfigSecretTargetByPath(["channels", "external", "primary"])?.entry.id,
    ).toBe("channels.external.primary");
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expect(
      query.resolveConfigSecretTargetByPath(["channels", "external", "secondary"])?.entry.id,
    ).toBe("channels.external.secondary");
    expect(query.resolveConfigSecretTargetByPath(["channels", "unknown", "token"])).toBeNull();
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("uses broader discovery when a selected target is absent from the bundled contract", () => {
    expect(
      query
        .discoverConfigSecretTargetsByIds(
          { channels: { bundled: { extraToken: "synthetic-token" } } },
          ["channels.bundled.extraToken"],
        )
        .map(({ entry }) => entry.id),
    ).toEqual(["channels.bundled.extraToken"]);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("ignores unconfigured plugin target IDs without metadata discovery", () => {
    expect(
      query
        .discoverConfigSecretTargetsByIds(
          {
            cron: { webhookToken: "synthetic-token" },
            channels: {},
            plugins: { entries: {} },
          },
          [
            "cron.webhookToken",
            "channels.external.primary",
            "plugins.entries.web-plugin.config.webSearch.apiKey",
          ],
        )
        .map(({ entry }) => entry.id),
    ).toEqual(["cron.webhookToken"]);
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expect(mocks.channel).toHaveBeenCalledTimes(0);
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it("discovers every configured external channel owner", () => {
    expect(
      query
        .discoverConfigSecretTargets({
          channels: {
            external: { primary: "synthetic-primary", secondary: "synthetic-secondary" },
          },
        })
        .map(({ entry }) => entry.id),
    ).toEqual(["channels.external.primary", "channels.external.secondary"]);
  });

  it("discovers disabled plugin targets without loading unrelated channel contracts", () => {
    const config = {
      plugins: {
        enabled: false,
        entries: { "example.plugin": { enabled: false, config: { token: "synthetic-token" } } },
      },
    };
    expect(
      query.discoverConfigSecretTargets(config).map(({ pathSegments }) => pathSegments),
    ).toEqual([["plugins", "entries", "example.plugin", "config", "token"]]);
    expect(mocks.channel).toHaveBeenCalledTimes(0);
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });

  it("uses prepared manifests without loading contracts for absent channel subtrees", () => {
    expect(
      query
        .discoverConfigSecretTargets(
          { cron: { webhookToken: "synthetic-token" } },
          { manifestRegistry: { plugins: [plugin("external-owner", ["external"])] } },
        )
        .map(({ entry }) => entry.id),
    ).toEqual(["cron.webhookToken"]);
    expect(mocks.metadata).toHaveBeenCalledTimes(0);
    expect(mocks.channel).toHaveBeenCalledTimes(0);
    expect(mocks.channelRecord).toHaveBeenCalledTimes(0);
  });
});
