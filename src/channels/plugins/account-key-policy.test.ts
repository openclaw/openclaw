import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it } from "vitest";
import { repairUnownedChannelAccountBindings } from "../../commands/doctor/shared/legacy-config-binding-repair.js";
import { createDoctorPluginMetadataSnapshotScope } from "../../commands/doctor/shared/plugin-metadata-snapshot-scope.js";
import type { OpenClawConfigWithLegacyRoster } from "../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../../plugins/loader.test-fixtures.js";
import { resolveMergedAccountConfig } from "./account-helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "./read-only.js";

const channel = "account-policy-fixture";
const accountKeyPolicy = { canonicalAliasesRequireOwnField: "token" };

function createPolicyConfig(accounts: Record<string, Record<string, unknown>>): OpenClawConfig {
  useNoBundledPlugins();
  const pluginDir = makePluginLoaderTempDir();
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(pluginDir, name), JSON.stringify(value));
  writeJson("package.json", {
    name: `@example/${channel}`,
    version: "1.0.0",
    openclaw: { extensions: ["./index.js"], channel: { id: channel } },
  });
  const schema = { type: "object", additionalProperties: true };
  writeJson("openclaw.plugin.json", {
    id: channel,
    channels: [channel],
    configSchema: { type: "object", properties: {} },
    channelAccountKeyPolicies: { [channel]: accountKeyPolicy },
    channelConfigs: { [channel]: { schema, label: "Fixture" } },
  });
  fs.writeFileSync(path.join(pluginDir, "index.js"), 'throw new Error("unexpected runtime load");');
  return {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    plugins: { allow: [channel], load: { paths: [pluginDir] } },
    channels: { [channel]: { token: "root-token", name: "Root", mediaMaxMb: 1, accounts } },
    bindings: [
      { agentId: "ops", match: { channel, accountId: "default" } },
      { agentId: "ops", match: { channel, accountId: "work-phone", guildId: "room-a" } },
    ],
  };
}

function resolveManifestAccount(cfg: OpenClawConfig) {
  const plugins = listReadOnlyChannelPluginsForConfig(cfg, { includePersistedAuthState: false });
  const plugin = expectDefined(
    plugins.find((entry) => entry.id === channel),
    "manifest channel adapter",
  );
  return plugin.config.resolveAccount(cfg, "work-phone");
}

afterEach(() => resetPluginLoaderTestStateForTest());
afterAll(() => cleanupPluginLoaderFixturesForTest());

it.each([
  [{ token: undefined }, "Root", "root-token"],
  [{ token: "named-token" }, "Named", "named-token"],
  [Object.create({ token: "inherited-token" }) as Record<string, unknown>, "Root", "root-token"],
] as const)("manifest account policy: %j", (entry, name, token) => {
  const account = Object.assign(entry, { name: "Named", enabled: false });
  const cfg = createPolicyConfig({ "Work Phone": account });
  const resolved = resolveManifestAccount(cfg);
  expect(resolved).toMatchObject({ accountId: "work-phone", name, config: { token } });
});

it.each([undefined, "named-token"])("Doctor scoped account policy: token=%s", (token) => {
  const cfg = createPolicyConfig({ "Work Phone": { token, enabled: false } });
  const scope = createDoctorPluginMetadataSnapshotScope({});
  const sourceConfigBeforeMigrations = {
    agents: { list: [{ id: "ops" }, { id: "research" }] },
  } satisfies OpenClawConfigWithLegacyRoster;
  const repair = (config: OpenClawConfig) =>
    scope.run({ config }, () =>
      repairUnownedChannelAccountBindings({ config, sourceConfigBeforeMigrations }),
    );
  const repaired = repair(cfg);
  const expectedBindings = token
    ? cfg.bindings
    : [...(cfg.bindings ?? []), { agentId: "ops", match: { channel, accountId: "work-phone" } }];
  expect(repaired.config.bindings).toEqual(expectedBindings);
  expect(repair(repaired.config).changes).toEqual([]);
});

it("outbound media limits select the canonical collision winner for a spaced alias", () => {
  const cfg = createPolicyConfig({
    "Work Phone": { token: "alias-token", mediaMaxMb: 2 },
    "work-phone": { token: "winner-token", mediaMaxMb: 3 },
  });
  const scope = createDoctorPluginMetadataSnapshotScope({});
  const bytes = scope.run({ config: cfg }, () =>
    resolveOutboundMediaMaxBytes({ cfg, channel, accountId: "Work Phone" }),
  );
  expect(bytes).toBe(3 * 1024 * 1024);
});

it("the Plugin SDK account merge accepts an explicit policy without a channel or normalizer", () => {
  const merged = resolveMergedAccountConfig({
    channelConfig: { token: "root-token", name: "Root" },
    accounts: { "Work Phone": { token: "named-token", name: "Named" } },
    accountId: "work-phone",
    accountKeyPolicy,
  });
  expect(merged).toEqual({ token: "named-token", name: "Named" });
});
