import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { widenOfficialExternalChannelSecretSchema } from "../../../config/official-external-channel-secret-schema.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { waitForPluginCacheRetirement } from "../../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import { validateJsonSchemaValue } from "../../../plugins/schema-validator.js";
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
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name,
      version: id === "openclaw-qqbot" ? "2.0.3" : "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"], channel: { id: channel }, ...openclaw },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      channels: [channel],
      configSchema: { type: "object" },
      channelConfigs: {
        [channel]: {
          schema: {
            type: "object",
            ...(channel === "qqbot" ? { additionalProperties: true } : {}),
          },
        },
      },
    }),
  );
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

it.each([true, false])(
  "promotes installed channel credentials without loading runtime (enabled=%s)",
  async (enabled) => {
    await installChannel(
      await createColdState("doctor-installed-promotion"),
      "promotion",
      "promotion-chat",
      { setupEntry: "./setup-entry.js", setupFeatures: { configPromotion: true } },
      `export default { plugin: {
        id: "promotion-chat",
        setupContract: {
          singleAccountKeysToMove: ["connectionUrl"],
          namedAccountPromotionKeys: ["connectionUrl", "botToken"]
        }
      } };\n`,
    );
    const root = {
      botToken: "root-token",
      connectionUrl: "https://root.example.com",
      dmPolicy: "pairing",
    };
    const cfg: OpenClawConfig = {
      plugins: { allow: ["promotion"], entries: { promotion: { enabled } } },
      channels: { "promotion-chat": { enabled: true, ...root, accounts: {} } },
    };
    const before = structuredClone(cfg);
    const changes: string[] = [];
    const first = seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes);
    expect(first.channels?.["promotion-chat"]).toEqual({
      enabled: true,
      accounts: { default: root },
    });
    expect(changes).toHaveLength(1);
    expect(cfg).toEqual(before);
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
    const repeatedChanges: string[] = [];
    expect(seedMissingDefaultAccountsFromSingleAccountBase(first, repeatedChanges)).toEqual(first);
    expect(repeatedChanges).toEqual([]);
  },
);

it.each([
  { enabled: true, configPromotion: "preserve-root" },
  { enabled: false, configPromotion: "preserve-root" },
  { enabled: true, configPromotion: true },
  { enabled: true, configPromotion: false },
  { enabled: true, configPromotion: undefined },
])(
  "honors cold installed plugin promotion metadata without loading runtime: %j",
  async ({ enabled, configPromotion }) => {
    await installChannel(
      await createColdState("doctor-preserved-account"),
      "preserved",
      "preserved-chat",
      { setupFeatures: { configPromotion } },
    );
    // Only generic fields: undeclared-key deferral cannot hide a missing static contract.
    const root = { name: "Environment-backed root", groupPolicy: "allowlist", groupAllowFrom: [] };
    const cfg: OpenClawConfig = {
      plugins: { allow: ["preserved"], entries: { preserved: { enabled } } },
      channels: { "preserved-chat": { ...root, accounts: {} } },
    };
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
        expect(result.channels?.["preserved-chat"]).toEqual({
          accounts: { default: root },
        });
        expect(changes).toHaveLength(1);
      }
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

  const cfg: OpenClawConfig = {
    meta: { migrations: { webhookListeners: true } },
    ...(enabled === undefined
      ? {}
      : {
          plugins: {
            allow: ["openclaw-qqbot"],
            entries: { "openclaw-qqbot": { enabled } },
          },
        }),
    channels: {
      qqbot: {
        allowFrom: ["ROOT-OWNER"],
        accounts: {
          ops: { appId: "ops-app", clientSecret: "ops-secret", allowFrom: ["OPS-OWNER"] },
          qa: { appId: "qa-app", clientSecret: "qa-secret", allowFrom: ["QA-OWNER"] },
        },
      },
    },
  };
  const schema = widenOfficialExternalChannelSecretSchema({
    channelId: "qqbot",
    schema: { type: "object", additionalProperties: true },
  });
  const before = structuredClone(cfg);
  const first = normalizeCompatibilityConfigValues(cfg);
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  const second = normalizeCompatibilityConfigValues(first.config);

  expect(
    validateJsonSchemaValue({
      cacheKey: `qqbot-promotion-${String(enabled)}`,
      schema: schema ?? {},
      value: cfg.channels?.qqbot,
    }).ok,
  ).toBe(true);
  expect(first.config).toEqual(before);
  expect(first.changes).toEqual([]);
  expect(second.config).toEqual(first.config);
  expect(second.changes).toEqual([]);
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
    const cfg: OpenClawConfig = {
      meta: { migrations: { webhookListeners: true } },
      channels: {
        whatsapp: {
          ...root,
          accounts: {
            work: { authDir: "/synthetic/work" },
            ...(existingDefault ? { default: root } : {}),
          },
        },
      },
    };
    const before = structuredClone(cfg);
    const first = normalizeCompatibilityConfigValues(cfg);
    expect(Object.keys(first.config.channels?.whatsapp?.accounts ?? {})).toEqual(
      existingDefault ? ["work", "default"] : ["work"],
    );
    expect(first.config).toEqual(before);
    expect(first.changes).toEqual([]);
    if (existingDefault) {
      expect(first.warnings).toEqual([
        expect.stringContaining('Unqualified WhatsApp operations currently select "default"'),
      ]);
    } else {
      expect(first.warnings).toBeUndefined();
    }
    expect(normalizeCompatibilityConfigValues(first.config)).toEqual(first);
  },
);

it("honors WhatsApp root preservation from the cold official catalog", async () => {
  await createColdState("doctor-whatsapp-cold");
  const cfg: OpenClawConfig = {
    channels: {
      whatsapp: {
        dmPolicy: "allowlist",
        allowFrom: ["+15550001111"],
        accounts: {},
      },
    },
  };
  const changes: string[] = [];
  expect(seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes)).toEqual(cfg);
  expect(changes).toEqual([]);
});
