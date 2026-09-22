import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PluginEntryConfig } from "./types.plugins.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: {
    safeParse: (raw: unknown) => ({ success: true, data: raw }),
  },
}));

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

function createDmPolicyRegistry(params: {
  channelId: string;
  doctorCapabilities?: {
    dmAllowFromMode?: "topOnly" | "topOrNested" | "nestedOnly";
    openDmRequiresAllowFromWildcard?: boolean;
  };
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecordFixture({
        id: params.channelId,
        channels: [params.channelId],
        packageChannel: {
          id: params.channelId,
          doctorCapabilities: params.doctorCapabilities,
        },
      }),
    ],
  };
}

describe("validateConfigObjectWithPlugins DM policy warnings", () => {
  const ownerCases: Array<{
    name: string;
    entries: Record<string, PluginEntryConfig>;
    allow?: string[];
    deny?: string[];
    plusOrigin?: PluginManifestRecord["origin"];
    expected: "plus" | "core" | "first";
    disabledConfigWarning?: boolean;
  }> = [
    { name: "preferred owner", entries: { plus: { enabled: true } }, expected: "plus" },
    {
      name: "disabled closer replacement",
      entries: { plus: { enabled: false }, core: { enabled: true } },
      plusOrigin: "config",
      expected: "core",
    },
    {
      name: "denied replacement",
      entries: { plus: { enabled: true }, core: { enabled: true } },
      deny: ["plus"],
      expected: "core",
    },
    {
      name: "ineligible workspace replacement",
      entries: { core: { enabled: true } },
      plusOrigin: "workspace",
      expected: "core",
    },
    {
      name: "untrusted material config",
      entries: { plus: { config: {} }, core: { enabled: true } },
      allow: ["core"],
      expected: "core",
      disabledConfigWarning: true,
    },
    {
      name: "same-origin dual selection",
      entries: { plus: { enabled: true }, core: { enabled: true } },
      expected: "first",
    },
  ];
  it.each(
    ownerCases.flatMap((scenario) =>
      (["plus", "core"] as const).flatMap((first) =>
        [true, false].map((requiresWildcard) => ({ scenario, first, requiresWildcard })),
      ),
    ),
  )(
    "uses $scenario.name DM capability with $first first and requiresWildcard=$requiresWildcard",
    ({ scenario, first, requiresWildcard }) => {
      const owner = scenario.expected === "first" ? first : scenario.expected;
      const order = first === "plus" ? ["plus", "core"] : ["core", "plus"];
      const registry: PluginManifestRegistry = {
        diagnostics: [],
        plugins: order.map((id) =>
          createPluginManifestRecordFixture({
            id,
            origin: id === "plus" ? (scenario.plusOrigin ?? "global") : "global",
            channels: ["proofchat"],
            configSchema: { type: "object", additionalProperties: true },
            packageChannel: {
              id: "proofchat",
              doctorCapabilities: {
                openDmRequiresAllowFromWildcard:
                  id === owner ? requiresWildcard : !requiresWildcard,
              },
            },
            channelConfigs: {
              proofchat: {
                ...(id === "plus" ? { preferOver: ["core"] } : {}),
                schema: {
                  type: "object",
                  properties: { [id]: { type: "string" } },
                  required: [id],
                  additionalProperties: true,
                },
              },
            },
          }),
        ),
      };
      const result = validateConfigObjectWithPlugins(
        {
          plugins: { entries: scenario.entries, allow: scenario.allow, deny: scenario.deny },
          channels: {
            proofchat: {
              [owner]: "selected schema",
              dmPolicy: "open",
              allowFrom: ["123"],
              accounts: {
                ops: { dmPolicy: "open", allowFrom: ["456"] },
                empty: { dmPolicy: "allowlist", allowFrom: [] },
              },
            },
          },
        },
        { pluginMetadataSnapshot: { manifestRegistry: registry } },
      );

      expect(result.ok).toBe(true);
      expect(
        result.warnings
          .filter((warning) => warning.path.startsWith("channels.proofchat"))
          .map((warning) => warning.path),
      ).toEqual(
        requiresWildcard
          ? [
              "channels.proofchat.allowFrom",
              "channels.proofchat.accounts.ops.allowFrom",
              "channels.proofchat.accounts.empty.allowFrom",
            ]
          : ["channels.proofchat.accounts.empty.allowFrom"],
      );
      if (scenario.disabledConfigWarning) {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            path: "plugins.entries.plus",
            message: expect.stringContaining("plugin disabled"),
          }),
        );
      }
    },
  );

  it("respects channel metadata that open DMs do not require a wildcard", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          qqbot: {
            dmPolicy: "open",
            allowFrom: ["openclaw:approval-disabled"],
            accounts: {
              ops: {
                dmPolicy: "open",
                allowFrom: ["openclaw:approval-disabled"],
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createDmPolicyRegistry({
            channelId: "qqbot",
            doctorCapabilities: { openDmRequiresAllowFromWildcard: false },
          }),
        },
      },
    );

    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it("uses manifest metadata to skip nested-only DM config shapes", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          matrix: {
            dm: {
              policy: "open",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createDmPolicyRegistry({
            channelId: "matrix",
            doctorCapabilities: { dmAllowFromMode: "nestedOnly" },
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.matrix")),
      ).toEqual([]);
    }
  });

  it("does not warn for disabled channels or accounts", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          mattermost: {
            enabled: false,
            dmPolicy: "open",
            accounts: {
              team: {
                dmPolicy: "open",
              },
            },
          },
          slack: {
            accounts: {
              work: {
                enabled: false,
                dmPolicy: "open",
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              ...createDmPolicyRegistry({ channelId: "mattermost" }).plugins,
              ...createDmPolicyRegistry({ channelId: "slack" }).plugins,
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.mattermost")),
      ).toEqual([]);
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.slack")),
      ).toEqual([]);
    }
  });

  it("does not suggest channel allowFrom as sufficient when account allowFrom overrides it", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          mattermost: {
            allowFrom: ["*"],
            accounts: {
              team: {
                dmPolicy: "open",
                allowFrom: [],
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createDmPolicyRegistry({ channelId: "mattermost" }),
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const warning = result.warnings.find(
        (entry) => entry.path === "channels.mattermost.accounts.team.allowFrom",
      );
      expect(warning?.message).toContain(
        "remove channels.mattermost.accounts.team.allowFrom to inherit channels.mattermost.allowFrom",
      );
      expect(warning?.message).not.toContain("(or channels.mattermost.allowFrom)");
    }
  });
});
