import { beforeEach, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PluginEntryConfig } from "./types.plugins.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

// mock-isolation: Synthetic channel shapes isolate DM warning policy from schema admission.
vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));
beforeEach(clearPluginMetadataLifecycleCaches);

function warnings(raw: unknown, plugins: PluginManifestRecord[]) {
  const result = validateConfigObjectWithPlugins(raw, {
    pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins } },
  });
  expect(result.ok).toBe(true);
  return result.warnings;
}
function dmWarnings(
  channels: Record<string, unknown>,
  doctorCapabilities?: { dmAllowFromMode: "nestedOnly" },
) {
  return warnings(
    { channels },
    Object.keys(channels).map((id) =>
      createPluginManifestRecordFixture({
        id,
        channels: [id],
        packageChannel: { id, doctorCapabilities },
      }),
    ),
  );
}
const forChannel = (issues: ReturnType<typeof warnings>, channel: string) =>
  issues.filter((issue) => issue.path.startsWith(`channels.${channel}`));

type OwnerCase = [
  name: string,
  entries: Record<string, PluginEntryConfig>,
  expected: "plus" | "core" | "first",
  options?: {
    origin?: PluginManifestRecord["origin"];
    allow?: string[];
    deny?: string[];
    disabled?: boolean;
  },
];
const enabled = { enabled: true };
const disabled = { enabled: false };
const untrusted = { config: {} };
const coreOnly = { allow: ["core"], disabled: true };
const owners: OwnerCase[] = [
  ["preferred owner", { plus: enabled }, "plus"],
  ["disabled replacement", { plus: disabled, core: enabled }, "core", { origin: "config" }],
  ["denied replacement", { plus: enabled, core: enabled }, "core", { deny: ["plus"] }],
  ["ineligible workspace replacement", { core: enabled }, "core", { origin: "workspace" }],
  ["untrusted material config", { plus: untrusted, core: enabled }, "core", coreOnly],
  ["same-origin dual selection", { plus: enabled, core: enabled }, "first"],
];

it.each(
  owners.flatMap(([name, entries, expected, options = {}]) =>
    (expected === "core" ? ["plus"] : ["plus", "core"]).map((first) => ({
      name,
      entries,
      options,
      first,
      owner: expected === "first" ? first : expected,
      requiresWildcard: first === "plus",
    })),
  ),
)(
  "uses $name DM capability with $first first",
  ({ entries, options, first, owner, requiresWildcard }) => {
    const order = first === "plus" ? ["plus", "core"] : ["core", "plus"];
    const issues = warnings(
      {
        plugins: { entries, allow: options.allow, deny: options.deny },
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
      order.map((id) =>
        createPluginManifestRecordFixture({
          id,
          origin: id === "plus" ? (options.origin ?? "global") : "global",
          channels: ["proofchat"],
          configSchema: { type: "object", additionalProperties: true },
          packageChannel: {
            id: "proofchat",
            doctorCapabilities: {
              openDmRequiresAllowFromWildcard: id === owner ? requiresWildcard : !requiresWildcard,
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
    );
    const suffixes = requiresWildcard
      ? ["allowFrom", "accounts.ops.allowFrom", "accounts.empty.allowFrom"]
      : ["accounts.empty.allowFrom"];
    expect(forChannel(issues, "proofchat").map((issue) => issue.path)).toEqual(
      suffixes.map((suffix) => `channels.proofchat.${suffix}`),
    );
    if (options.disabled) {
      expect(issues).toContainEqual(
        expect.objectContaining({
          path: "plugins.entries.plus",
          message: expect.stringContaining("plugin disabled"),
        }),
      );
    }
  },
);

it.each([
  [
    "nested-only config",
    { matrix: { dm: { policy: "open", allowFrom: ["*"] } } },
    { dmAllowFromMode: "nestedOnly" },
  ],
  [
    "disabled channels/accounts",
    {
      mattermost: { enabled: false, dmPolicy: "open", accounts: { team: { dmPolicy: "open" } } },
      slack: { accounts: { work: { enabled: false, dmPolicy: "open" } } },
    },
    undefined,
  ],
] as const)("does not warn for %s", (_name, channels, capabilities) => {
  expect(
    dmWarnings(channels, capabilities).filter((issue) => issue.path.startsWith("channels.")),
  ).toEqual([]);
});

it.each([
  {
    name: "missing root wildcard inherited by an account",
    matrix: { dm: { policy: "open" }, accounts: { team: { dm: {} } } },
    paths: ["channels.matrix.dm.allowFrom", "channels.matrix.accounts.team.dm.allowFrom"],
  },
  {
    name: "empty account override of a root wildcard",
    matrix: {
      dm: { policy: "open", allowFrom: ["*"] },
      accounts: { team: { dm: { allowFrom: [] } } },
    },
    paths: ["channels.matrix.accounts.team.dm.allowFrom"],
  },
  {
    name: "explicit DM enablement overriding a disabled root",
    matrix: {
      dm: { enabled: false, policy: "open" },
      accounts: { team: { dm: { enabled: true } }, disabled: { dm: {} } },
    },
    paths: ["channels.matrix.accounts.team.dm.allowFrom"],
  },
  {
    name: "runtime-ignored account wildcard",
    matrix: {
      dm: { policy: "allowlist", allowFrom: [] },
      accounts: { team: { allowFrom: ["*"] } },
    },
    paths: ["channels.matrix.dm.allowFrom", "channels.matrix.accounts.team.dm.allowFrom"],
  },
  {
    name: "runtime-ignored account alias before inherited wildcard",
    matrix: {
      dm: { policy: "open", allowFrom: ["*"] },
      accounts: { team: { allowFrom: [] } },
    },
    paths: [],
  },
  {
    name: "runtime-ignored account policy",
    matrix: { accounts: { team: { dmPolicy: "open", dm: { allowFrom: [] } } } },
    paths: [],
  },
])("uses canonical nested DM fields for $name", ({ matrix, paths }) => {
  const issues = forChannel(dmWarnings({ matrix }, { dmAllowFromMode: "nestedOnly" }), "matrix");
  expect(issues.map((issue) => issue.path)).toEqual(paths);
  for (const issue of issues) {
    expect(issue.message).toContain(".dm.policy=");
    expect(issue.message).not.toContain(".dmPolicy");
    expect(issue.message).not.toContain("channels.matrix.allowFrom");
  }
});

it("does not suggest channel allowFrom as sufficient when account allowFrom overrides it", () => {
  const issues = dmWarnings({
    mattermost: { allowFrom: ["*"], accounts: { team: { dmPolicy: "open", allowFrom: [] } } },
  });
  const path = "channels.mattermost.accounts.team.allowFrom";
  const warning = issues.find((entry) => entry.path === path);
  expect(warning?.message).toContain(`remove ${path} to inherit channels.mattermost.allowFrom`);
  expect(warning?.message).not.toContain("(or channels.mattermost.allowFrom)");
});
