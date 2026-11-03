import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { waitForPluginCacheRetirement } from "../../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { normalizeCompatibilityConfigValues } from "./legacy-config-core-migrate.js";
import { seedMissingDefaultAccountsFromSingleAccountBase } from "./legacy-config-core-normalizers.js";

let state: OpenClawTestState | undefined;

async function createColdState(label: string) {
  state = await createOpenClawTestState({ label, applyEnv: true });
  const bundledDir = state.path("empty-bundled");
  await fs.mkdir(bundledDir);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  return state;
}

async function installChannel(
  testState: OpenClawTestState,
  id: string,
  channel: string,
  openclaw: Record<string, unknown> = {},
  setup?: string,
  name = `@example/${id}`,
) {
  const pluginDir = testState.statePath("extensions", id);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    "throw new Error('Doctor must not execute the channel runtime');\n",
  );
  if (setup) {
    await fs.writeFile(path.join(pluginDir, "setup-entry.js"), setup);
  }
  const writeJson = (file: string, value: unknown) =>
    fs.writeFile(path.join(pluginDir, file), JSON.stringify(value));
  await writeJson("package.json", {
    name,
    version: id === "openclaw-qqbot" ? "2.0.3" : "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"], channel: { id: channel }, ...openclaw },
  });
  const schema = { type: "object", ...(channel === "qqbot" ? { additionalProperties: true } : {}) };
  await writeJson("openclaw.plugin.json", {
    id,
    channels: [channel],
    configSchema: { type: "object" },
    channelConfigs: { [channel]: { schema } },
  });
}

function channelConfig(
  channel: string,
  value: unknown,
  plugin?: string,
  enabled = true,
): OpenClawConfig {
  return {
    meta: { migrations: { webhookListeners: true } },
    ...(plugin ? { plugins: { allow: [plugin], entries: { [plugin]: { enabled } } } } : {}),
    channels: { [channel]: value },
  };
}

function normalizeAndRepeat(cfg: OpenClawConfig) {
  const before = structuredClone(cfg);
  const first = normalizeCompatibilityConfigValues(cfg);
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  expect(normalizeCompatibilityConfigValues(first.config)).toEqual(first);
  expect(cfg).toEqual(before);
  return first;
}

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  const { failures } = await waitForPluginCacheRetirement();
  expect(failures).toEqual([]);
  vi.unstubAllEnvs();
  await state?.cleanup();
  state = undefined;
});

it.each([
  { enabled: true, configPromotion: true, declared: true },
  { enabled: false, configPromotion: true, declared: true },
  { enabled: true, configPromotion: "preserve-root", declared: false },
  { enabled: false, configPromotion: "preserve-root", declared: false },
  { enabled: true, configPromotion: true, declared: false },
  { enabled: true, configPromotion: false, declared: false },
  { enabled: true, configPromotion: undefined, declared: false },
])(
  "honors cold installed channel promotion without loading runtime: %j",
  async ({ enabled, configPromotion, declared }) => {
    await installChannel(
      await createColdState("doctor-installed-promotion"),
      "promotion",
      "promotion-chat",
      {
        ...(declared ? { setupEntry: "./setup-entry.js" } : {}),
        setupFeatures: { configPromotion },
      },
      declared
        ? `export default { plugin: {
        id: "promotion-chat",
        setupContract: {
          singleAccountKeysToMove: ["connectionUrl"],
          namedAccountPromotionKeys: ["connectionUrl", "botToken"]
        }
      } };\n`
        : undefined,
    );
    const root = declared
      ? {
          botToken: "root-token",
          connectionUrl: "https://root.example.com",
          dmPolicy: "pairing",
        }
      : { name: "Environment-backed root", groupPolicy: "allowlist", groupAllowFrom: [] };
    const channelFlags = declared ? { enabled: true } : {};
    const cfg = channelConfig(
      "promotion-chat",
      { ...channelFlags, ...root, accounts: {} },
      "promotion",
      enabled,
    );
    const before = structuredClone(cfg);
    for (let run = 0; run < 2; run++) {
      clearPluginMetadataLifecycleCaches();
      resetPluginRuntimeStateForTest();
      const changes: string[] = [];
      const result = seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes);
      if (configPromotion === "preserve-root") {
        expect(result).toEqual(before);
        expect(changes).toEqual([]);
      } else {
        expect(result.channels?.["promotion-chat"]).toEqual({
          ...channelFlags,
          accounts: { default: root },
        });
        expect(changes).toHaveLength(1);
      }
      const repeatedChanges: string[] = [];
      expect(seedMissingDefaultAccountsFromSingleAccountBase(result, repeatedChanges)).toEqual(
        result,
      );
      expect(repeatedChanges).toEqual([]);
    }
    expect(cfg).toEqual(before);
  },
);

it.each([
  { state: "installed", enabled: true },
  { state: "disabled", enabled: false },
  { state: "cold", enabled: undefined },
])("preserves the official QQBot root through $state discovery", async ({ enabled }) => {
  const testState = await createColdState("doctor-qqbot-promotion");

  if (enabled !== undefined) {
    await installChannel(
      testState,
      "openclaw-qqbot",
      "qqbot",
      { plugin: { id: "openclaw-qqbot" } },
      undefined,
      "@tencent-connect/openclaw-qqbot",
    );
  }

  const cfg = channelConfig(
    "qqbot",
    {
      allowFrom: ["ROOT-OWNER"],
      accounts: {
        ops: { appId: "ops-app", clientSecret: "ops-secret", allowFrom: ["OPS-OWNER"] },
        qa: { appId: "qa-app", clientSecret: "qa-secret", allowFrom: ["QA-OWNER"] },
      },
    },
    enabled === undefined ? undefined : "openclaw-qqbot",
    enabled,
  );
  const before = structuredClone(cfg);
  const first = normalizeAndRepeat(cfg);
  expect(first.config).toEqual(before);
  expect(first.changes).toEqual([]);
});

it.each([false, true])(
  "preserves WhatsApp accounts and returns warning-only results (existing default=%s)",
  async (existingDefault) => {
    state = await createOpenClawTestState({ label: "doctor-whatsapp-routing", applyEnv: true });
    vi.stubEnv("OPENCLAW_OAUTH_DIR", state.statePath("credentials"));
    const root = {
      dmPolicy: "allowlist" as const,
      allowFrom: ["+15550001111"],
      groupPolicy: "disabled" as const,
    };
    const cfg = channelConfig("whatsapp", {
      ...root,
      accounts: {
        work: { authDir: "/synthetic/work" },
        ...(existingDefault ? { default: root } : {}),
      },
    });
    const before = structuredClone(cfg);
    const first = normalizeAndRepeat(cfg);
    expect(first.config).toEqual(before);
    expect(first.changes).toEqual([]);
    if (existingDefault) {
      expect(first.warnings).toEqual([
        expect.stringContaining('Unqualified WhatsApp operations currently select "default"'),
      ]);
    } else {
      expect(first.warnings).toBeUndefined();
    }
  },
);

it("honors WhatsApp root preservation from the cold official catalog", async () => {
  await createColdState("doctor-whatsapp-cold");
  const cfg = channelConfig("whatsapp", {
    dmPolicy: "allowlist",
    allowFrom: ["+15550001111"],
    accounts: {},
  });
  const changes: string[] = [];
  expect(seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes)).toEqual(cfg);
  expect(changes).toEqual([]);
});
