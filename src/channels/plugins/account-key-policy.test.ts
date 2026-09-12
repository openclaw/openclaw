import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { repairUnownedChannelAccountBindings } from "../../commands/doctor/shared/legacy-config-binding-repair.js";
import { createDoctorPluginMetadataSnapshotScope } from "../../commands/doctor/shared/plugin-metadata-snapshot-scope.js";
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
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: `@example/${channel}`,
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"], channel: { id: channel } },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: channel,
      channels: [channel],
      configSchema: { type: "object", properties: {} },
      channelAccountKeyPolicies: { [channel]: accountKeyPolicy },
      channelConfigs: {
        [channel]: {
          schema: { type: "object", additionalProperties: true },
          label: "Account policy fixture",
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    'throw new Error("runtime must stay unloaded");',
  );
  return {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    plugins: { allow: [channel], load: { paths: [pluginDir] } },
    channels: { [channel]: { token: "root-token", name: "Root", mediaMaxMb: 1, accounts } },
    bindings: [{ agentId: "ops", match: { channel, accountId: "work-phone", guildId: "room-a" } }],
  };
}

afterEach(() => resetPluginLoaderTestStateForTest());
afterAll(() => cleanupPluginLoaderFixturesForTest());

describe("prepared channel account policy entry points", () => {
  it.each([undefined, "named-token"])(
    "channels.status manifest adapter retains its declared account rule outside metadata scope (token=%s)",
    (token) => {
      const cfg = createPolicyConfig({ "Work Phone": { token, name: "Named", enabled: false } });
      const plugin = expectDefined(
        listReadOnlyChannelPluginsForConfig(cfg, { includePersistedAuthState: false }).find(
          (entry) => entry.id === channel,
        ),
        "manifest channel adapter",
      );
      expect(plugin.config.resolveAccount(cfg, "work-phone")).toMatchObject({
        accountId: "work-phone",
        name: token ? "Named" : "Root",
        config: { token: token ?? "root-token" },
      });
    },
  );

  it.each([undefined, "named-token"])(
    "Doctor binding repair honors its scoped account rule (token=%s)",
    (token) => {
      const cfg = createPolicyConfig({ "Work Phone": { token, enabled: false } });
      const scope = createDoctorPluginMetadataSnapshotScope({});
      const repaired = scope.run({ config: cfg }, () => repairUnownedChannelAccountBindings(cfg));
      const expectedBindings = token
        ? cfg.bindings
        : [
            ...(cfg.bindings ?? []),
            { agentId: "ops", match: { channel, accountId: "work-phone" } },
          ];
      expect(repaired.config.bindings).toEqual(expectedBindings);
      expect(
        scope.run({ config: repaired.config }, () =>
          repairUnownedChannelAccountBindings(repaired.config),
        ).changes,
      ).toEqual([]);
    },
  );

  it.each(["Work Phone", "work-phone"])(
    "outbound media limits select the canonical collision winner for %s",
    (accountId) => {
      const cfg = createPolicyConfig({
        "Work Phone": { token: "alias-token", mediaMaxMb: 2 },
        "work-phone": { token: "winner-token", mediaMaxMb: 3 },
      });
      const scope = createDoctorPluginMetadataSnapshotScope({});
      const bytes = scope.run({ config: cfg }, () =>
        resolveOutboundMediaMaxBytes({ cfg, channel, accountId }),
      );
      expect(bytes).toBe(3 * 1024 * 1024);
    },
  );

  it("channels.status manifest adapter does not admit an inherited credential field", () => {
    const account = Object.create({ token: "inherited-token" }) as Record<string, unknown>;
    account.name = "Named";
    const cfg = createPolicyConfig({ "Work Phone": account });
    const plugin = expectDefined(
      listReadOnlyChannelPluginsForConfig(cfg, { includePersistedAuthState: false }).find(
        (entry) => entry.id === channel,
      ),
      "manifest channel adapter",
    );
    expect(plugin.config.resolveAccount(cfg, "work-phone")).toMatchObject({ name: "Root" });
  });

  it("the Plugin SDK account merge accepts an explicit policy without a channel or normalizer", () => {
    expect(
      resolveMergedAccountConfig({
        channelConfig: { token: "root-token", name: "Root" },
        accounts: { "Work Phone": { token: "named-token", name: "Named" } },
        accountId: "work-phone",
        accountKeyPolicy,
      }),
    ).toEqual({ token: "named-token", name: "Named" });
  });
});
