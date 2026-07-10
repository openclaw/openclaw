import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthHealthSummary } from "../../../agents/auth-health.js";
import { testing as externalAuthTesting } from "../../../agents/auth-profiles/external-auth.js";
import { resolveAuthProfileOrder } from "../../../agents/auth-profiles/order.js";
import { resolveLegacyAuthStorePath } from "../../../agents/auth-profiles/paths.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resetProviderAuthAliasMapCacheForTest } from "../../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectStaleConfiguredAuthOrderWarnings,
  maybeRepairStaleConfiguredAuthOrders,
  repairStaleConfiguredAuthOrders,
} from "./stale-auth-order.js";

const pluginMetadataMocks = vi.hoisted(() => {
  const snapshot = {
    plugins: [
      {
        id: "anthropic",
        origin: "bundled",
        providerAuthChoices: [
          {
            provider: "anthropic",
            method: "cli",
            choiceId: "anthropic-cli",
            deprecatedChoiceIds: ["claude-cli"],
          },
        ],
      },
    ],
    diagnostics: [],
  };
  return {
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
  };
});

vi.mock("../../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

function tokenStore(params: {
  profileId: string;
  provider?: string;
  token?: string;
  expires?: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "token",
        provider: params.provider ?? "claude-cli",
        token: params.token ?? "setup-token",
        ...(params.expires === undefined ? {} : { expires: params.expires }),
      },
    },
  };
}

function repair(
  cfg: OpenClawConfig,
  stores: AuthProfileStore[],
  runtimeProfileIds?: ReadonlySet<string>,
) {
  return repairStaleConfiguredAuthOrders({
    cfg,
    stores,
    ...(runtimeProfileIds ? { runtimeProfileIds } : {}),
  });
}

describe("repairStaleConfiguredAuthOrders", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(() => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  });

  it("removes a stale Claude OAuth order so the live setup-token profile becomes effective", () => {
    const store = tokenStore({ profileId: "claude-cli:setup-token" });
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:claude-cli"] },
      },
    } satisfies OpenClawConfig;
    const before = buildAuthHealthSummary({ cfg, store });
    const result = repair(cfg, [store]);
    const after = buildAuthHealthSummary({ cfg: result.config, store });

    expect(before.providers).toEqual([
      expect.objectContaining({ provider: "claude-cli", status: "missing", effectiveProfiles: [] }),
    ]);
    expect(result.config.auth?.order?.anthropic).toBeUndefined();
    expect(after.providers).toEqual([
      expect.objectContaining({
        provider: "claude-cli",
        status: "ok",
        effectiveProfiles: [expect.objectContaining({ profileId: "claude-cli:setup-token" })],
      }),
    ]);
    expect(
      resolveAuthProfileOrder({
        cfg: result.config,
        store,
        provider: "claude-cli",
      }),
    ).toEqual(["claude-cli:setup-token"]);
    expect(result.changes).toEqual([
      "auth.order.anthropic: removed 1 missing profile reference to restore automatic per-agent auth selection.",
    ]);
  });

  it("preserves an explicit empty order", () => {
    const cfg = { auth: { order: { anthropic: [] } } } satisfies OpenClawConfig;

    const result = repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it.each([null, "anthropic:missing", { profile: "anthropic:missing" }])(
    "leaves malformed auth-order entries to config validation",
    (orderEntry) => {
      const cfg = {
        auth: { order: { anthropic: orderEntry } },
      } as unknown as OpenClawConfig;

      expect(repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })])).toEqual({
        config: cfg,
        changes: [],
      });
      expect(
        collectStaleConfiguredAuthOrderWarnings({
          cfg,
          doctorFixCommand: "openclaw doctor --fix",
        }),
      ).toEqual([]);
    },
  );

  it("leaves malformed auth profile metadata to config validation", () => {
    const cfg = {
      auth: {
        profiles: { broken: null },
        order: { anthropic: ["anthropic:missing"] },
      },
    } as unknown as OpenClawConfig;

    expect(repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })])).toEqual({
      config: cfg,
      changes: [],
    });
    expect(
      collectStaleConfiguredAuthOrderWarnings({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([]);
  });

  it("preserves an order with surviving config metadata", () => {
    const cfg = {
      auth: {
        profiles: {
          "anthropic:pending": { provider: "anthropic", mode: "oauth" },
        },
        order: { anthropic: ["anthropic:removed", "anthropic:pending"] },
      },
    } satisfies OpenClawConfig;

    const result = repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("preserves an order with a surviving persisted profile", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:removed", "anthropic:existing"] },
      },
    } satisfies OpenClawConfig;
    const store = tokenStore({
      profileId: "anthropic:existing",
      provider: "anthropic",
    });

    const result = repair(cfg, [store]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("does not use a stored profile from another provider", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const store = tokenStore({
      profileId: "openai:manual",
      provider: "openai",
    });

    const result = repair(cfg, [store]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("does not remove an order when the only fallback credential is expired", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const store = tokenStore({
      profileId: "claude-cli:expired",
      expires: Date.now() - 1,
    });

    const result = repair(cfg, [store]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("preserves a stale config order when the agent's stored order has no usable fallback", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:expired": {
          type: "token",
          provider: "anthropic",
          token: "expired",
          expires: Date.now() - 1,
        },
        "claude-cli:setup-token": {
          type: "token",
          provider: "claude-cli",
          token: "setup-token",
        },
      },
      order: { anthropic: ["anthropic:expired"] },
    };

    expect(repair(cfg, [store])).toEqual({ config: cfg, changes: [] });
  });

  it("removes stale aliases together and restores each agent's automatic selection", () => {
    const cfg = {
      auth: {
        order: {
          anthropic: ["anthropic:removed"],
          "claude-cli": ["claude-cli:removed"],
        },
      },
    } satisfies OpenClawConfig;
    const mainStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const childStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "claude-cli:token": {
          type: "token",
          provider: "claude-cli",
          token: "setup-token",
        },
      },
    };

    const result = repair(cfg, [mainStore, childStore]);

    expect(result.config.auth?.order).toEqual({});
    expect(
      resolveAuthProfileOrder({ cfg: result.config, store: mainStore, provider: "anthropic" }),
    ).toEqual(["anthropic:oauth"]);
    expect(
      resolveAuthProfileOrder({ cfg: result.config, store: childStore, provider: "claude-cli" }),
    ).toEqual(["claude-cli:token"]);
  });

  it("includes inherited main credentials when main is not a configured agent", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-auth-order-"));
    try {
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:setup-token" }),
        mainAgentDir,
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:removed"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "preserves profiles in the %s-selected auth store",
    async (envKey) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-auth-order-"));
      try {
        const selectedAgentDir = path.join(stateDir, "selected-agent");
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:selected-token" }),
          selectedAgentDir,
        );
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const cfg = {
          auth: { order: { anthropic: ["claude-cli:selected-token"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({
          cfg,
          env: {
            OPENCLAW_STATE_DIR: stateDir,
            [envKey]: selectedAgentDir,
          },
        });

        expect(result).toEqual({ config: cfg, changes: [] });
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("preserves an order that selects a runtime-only external profile", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { openai: ["openai:runtime-only"] } },
      } satisfies OpenClawConfig;
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:main-seed": {
              type: "api_key",
              provider: "openai",
              key: "api-key",
            },
          },
        },
        path.join(stateDir, "agents", "main", "agent"),
      );
      externalAuthTesting.setResolveExternalAuthProfilesForTest((params) =>
        params.context.agentDir === workAgentDir &&
        params.context.store.profiles["openai:main-seed"]
          ? [
              {
                profileId: "openai:runtime-only",
                credential: {
                  type: "oauth",
                  provider: "openai",
                  access: "access",
                  refresh: "refresh",
                  expires: Date.now() + 60_000,
                },
                persistence: "runtime-only",
              },
            ]
          : [],
      );

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("warns and does not repair when an active auth database is unreadable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-unreadable-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.writeFile(resolveAuthProfileDatabasePath(workAgentDir), "not-a-sqlite-database");
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
      expect(
        collectStaleConfiguredAuthOrderWarnings({
          cfg,
          doctorFixCommand: "openclaw doctor --fix",
          env: { OPENCLAW_STATE_DIR: stateDir },
        }).join("\n"),
      ).toContain("SQLite auth profile store is unreadable");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("warns and preserves an ordered profile dropped by store coercion", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-invalid-auth-order-"));
    try {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "anthropic:old": { type: "invalid", provider: "anthropic" },
            "claude-cli:setup-token": {
              type: "token",
              provider: "claude-cli",
              token: "setup-token",
            },
          },
        },
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        auth: { order: { anthropic: ["anthropic:old"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("contains invalid credentials");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("repairs when an active agent database has no auth-profile row", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-empty-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writePersistedAuthProfileStateRaw({ version: 1 }, workAgentDir);
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not repair while an invalid legacy auth source remains", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.writeFile(resolveLegacyAuthStorePath(workAgentDir), "not-json", "utf8");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
