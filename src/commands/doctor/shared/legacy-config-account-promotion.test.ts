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
    state = await createOpenClawTestState({ label: "doctor-installed-promotion", applyEnv: true });
    const pluginDir = state.statePath("extensions", "promotion");
    const bundledDir = state.path("empty-bundled");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(bundledDir, { recursive: true });
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('Doctor must not execute the channel runtime');\n",
    );
    await fs.writeFile(
      path.join(pluginDir, "setup-entry.js"),
      `export default { plugin: {
        id: "promotion-chat",
        setupContract: {
          singleAccountKeysToMove: ["connectionUrl"],
          namedAccountPromotionKeys: ["connectionUrl", "botToken"]
        }
      } };\n`,
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/promotion",
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          setupEntry: "./setup-entry.js",
          setupFeatures: { configPromotion: true },
          channel: { id: "promotion-chat" },
        },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "promotion",
        channels: ["promotion-chat"],
        configSchema: { type: "object" },
        channelConfigs: { "promotion-chat": { schema: { type: "object" } } },
      }),
    );
    const cfg: OpenClawConfig = {
      plugins: { allow: ["promotion"], entries: { promotion: { enabled } } },
      channels: {
        "promotion-chat": {
          enabled: true,
          botToken: "root-token",
          connectionUrl: "https://root.example.com",
          dmPolicy: "pairing",
          accounts: {},
        },
      },
    };
    const before = structuredClone(cfg);
    const changes: string[] = [];
    const first = seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes);
    expect(first.channels?.["promotion-chat"]).toEqual({
      enabled: true,
      accounts: {
        default: {
          botToken: "root-token",
          connectionUrl: "https://root.example.com",
          dmPolicy: "pairing",
        },
      },
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
    state = await createOpenClawTestState({ label: "doctor-preserved-account", applyEnv: true });
    const pluginDir = state.statePath("extensions", "preserved");
    const bundledDir = state.path("empty-bundled");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(bundledDir, { recursive: true });
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('Doctor must not execute this plugin runtime');\n",
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/preserved",
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          channel: { id: "preserved-chat" },
          setupFeatures: { configPromotion },
        },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "preserved",
        configSchema: { type: "object" },
        channels: ["preserved-chat"],
        channelConfigs: { "preserved-chat": { schema: { type: "object" } } },
      }),
    );
    // Only generic fields: undeclared-key deferral cannot hide a missing static contract.
    const cfg: OpenClawConfig = {
      plugins: { allow: ["preserved"], entries: { preserved: { enabled } } },
      channels: {
        "preserved-chat": {
          name: "Environment-backed root",
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          accounts: {},
        },
      },
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
          accounts: {
            default: {
              name: "Environment-backed root",
              groupPolicy: "allowlist",
              groupAllowFrom: [],
            },
          },
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
  state = await createOpenClawTestState({ label: "doctor-qqbot-promotion", applyEnv: true });
  const bundledDir = state.path("empty-bundled");
  await fs.mkdir(bundledDir, { recursive: true });
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");

  if (enabled !== undefined) {
    const pluginDir = state.statePath("extensions", "openclaw-qqbot");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('Doctor must not execute the QQBot plugin runtime');\n",
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@tencent-connect/openclaw-qqbot",
        version: "2.0.3",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          plugin: { id: "openclaw-qqbot" },
          channel: { id: "qqbot" },
        },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "openclaw-qqbot",
        configSchema: { type: "object" },
        channels: ["qqbot"],
        channelConfigs: { qqbot: { schema: { type: "object", additionalProperties: true } } },
      }),
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
    const cfg: OpenClawConfig = {
      meta: { migrations: { webhookListeners: true } },
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          groupPolicy: "disabled",
          accounts: {
            work: { authDir: "/synthetic/work" },
            ...(existingDefault
              ? {
                  default: {
                    dmPolicy: "allowlist" as const,
                    allowFrom: ["+15550001111"],
                    groupPolicy: "disabled" as const,
                  },
                }
              : {}),
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
  state = await createOpenClawTestState({ label: "doctor-whatsapp-cold", applyEnv: true });
  const bundledDir = state.path("empty-bundled");
  await fs.mkdir(bundledDir);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
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
