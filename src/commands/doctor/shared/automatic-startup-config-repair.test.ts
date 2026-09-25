import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readConfigFileSnapshot } from "../../../config/config.js";
import { createConfigIoContext } from "../../../config/io.context.js";
import { createConfigIO } from "../../../config/io.factory.js";
import { readConfigFileSnapshotFromContext } from "../../../config/io.snapshot.js";
import {
  collectEnvSecretRefIds,
  copyConfigResolutionFactsThroughRewrite,
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../../../config/resolution-facts.js";
import { writeOpenClawConfig } from "../../../config/test-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { isPathInside } from "../../../infra/path-guards.js";
import * as pluginModuleLoader from "../../../plugins/plugin-module-loader-cache.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../../version.js";
import { withDoctorConfigPreflightHome } from "../../doctor-config-preflight.test-support.js";
import {
  commitAutomaticConfigRepair,
  isStartupConfigRepairResult,
  planAutomaticConfigRepair,
  resolveStartupConfigSnapshot,
} from "./automatic-startup-config-repair.js";

function invalidSnapshot(params: {
  config: OpenClawConfig;
  issuePaths: string[];
  includedPaths?: string[];
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: params.includedPaths ?? [],
    exists: true,
    raw: JSON.stringify(params.config),
    parsed: params.config,
    sourceConfig: params.config,
    resolved: params.config,
    valid: false,
    runtimeConfig: params.config,
    config: params.config,
    issues: params.issuePaths.map((issuePath) => ({ path: issuePath, message: "retired" })),
    warnings: [],
    legacyIssues: [{ path: "", message: "retired" }],
  };
}

describe("automatic startup config repair", () => {
  it("preserves a resolved legacy channel owner in the same repair as the explicit roster", async () => {
    const coreSourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const loadModule = pluginModuleLoader.getCachedPluginModuleLoader;
    const nativeRepair = vi
      .spyOn(pluginModuleLoader, "getCachedPluginModuleLoader")
      .mockImplementation((options) => {
        if (isPathInside(coreSourceRoot, options.modulePath)) {
          throw new Error("Host core must retain its native module graph during binding repair");
        }
        return loadModule(options);
      });
    onTestFinished(() => nativeRepair.mockRestore());
    await withOpenClawTestState({ prefix: "openclaw-channel-owner-repair-" }, async (state) => {
      await state.writeConfig({
        agents: { list: [{ id: "${LEGACY_CHANNEL_AGENT}" }, { id: "main" }] },
        channels: { telegram: { botToken: "123456:synthetic-owner" } },
        bindings: [
          { agentId: "main", match: { channel: "telegram", peer: { kind: "direct", id: "123" } } },
        ],
      });
      const snapshot = await createConfigIO({
        configPath: state.configPath,
        env: { ...state.env, LEGACY_CHANNEL_AGENT: "ops" },
        observe: false,
      }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      const plan = planAutomaticConfigRepair(snapshot);
      expect(plan?.snapshot.valid).toBe(true);
      expect(plan?.config.agents?.ownership).toBe("explicit");
      expect(plan?.config.bindings).toContainEqual({
        agentId: "ops",
        match: { channel: "telegram", accountId: "default" },
      });
      expect(plan?.changes.join("\n")).toContain("Preserved telegram:default ownership");
    });
  });

  it.each([
    { providerId: "partner.east", refPath: 'models.providers["partner.east"].apiKey' },
    { providerId: "partner[blue]", refPath: 'models.providers["partner[blue]"].apiKey' },
    { providerId: "42", refPath: 'models.providers["42"].apiKey' },
  ])(
    "preserves real-reader env provenance for quoted provider $providerId during repair",
    async ({ providerId, refPath }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath =
          process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw", "openclaw.json");
        const raw = JSON.stringify({
          gateway: { mode: "local" },
          session: { idleMinutes: 45 },
          models: {
            providers: {
              [providerId]: {
                baseUrl: "https://provider.invalid/v1",
                api: "openai-completions",
                apiKey: "${QUOTED_REPAIR_KEY}",
                models: [{ id: "fixture-model", name: "Fixture model" }],
              },
            },
          },
        });
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, raw);
        const snapshot = await createConfigIO({
          configPath,
          env: { ...process.env, QUOTED_REPAIR_KEY: "synthetic-environment-file-value" },
          observe: false,
        }).readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        expect(snapshot.sourceConfig.session).toHaveProperty("idleMinutes", 45);
        expect(snapshot.sourceConfig.models?.providers?.[providerId]?.apiKey).toBe(
          "synthetic-environment-file-value",
        );
        expect(getResolvedConfigEnvSecretRef(snapshot.sourceConfig, refPath)?.id).toBe(
          "QUOTED_REPAIR_KEY",
        );

        const repaired = resolveStartupConfigSnapshot(snapshot);
        expect(repaired?.valid).toBe(true);
        expect(repaired?.sourceConfig.session?.reset?.idleMinutes).toBe(45);
        expect(collectEnvSecretRefIds(repaired?.sourceConfig)).toEqual(
          new Set(["QUOTED_REPAIR_KEY"]),
        );
        expect(getResolvedConfigEnvSecretRef(repaired?.sourceConfig, refPath)?.id).toBe(
          "QUOTED_REPAIR_KEY",
        );
        for (const replacement of [undefined, "changed-value"]) {
          const rewritten = structuredClone(snapshot.sourceConfig);
          const provider = rewritten.models?.providers?.[providerId];
          expect(provider).toBeDefined();
          if (provider) {
            if (replacement === undefined) {
              delete provider.apiKey;
            } else {
              provider.apiKey = replacement;
            }
          }
          copyConfigResolutionFactsThroughRewrite(snapshot.sourceConfig, rewritten);
          expect(getResolvedConfigEnvSecretRef(rewritten, refPath)).toBeNull();
          expect(collectEnvSecretRefIds(rewritten)).toEqual(new Set());
        }
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      });
    },
  );

  it("repairs an independent core alias while retaining a deferred plugin's legacy input", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw", "openclaw.json");
      const source = {
        gateway: { mode: "local" },
        tools: { exec: { timeoutSec: 45 } },
        plugins: { allow: ["pending-owner"], entries: { "pending-owner": { enabled: true } } },
        legacyPluginInput: { root: "/srv/pending-plugin-state" },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const raw = `${JSON.stringify(source, null, 2)}\n`;
      await fs.writeFile(configPath, raw);
      const pending = {
        pluginId: "pending-owner",
        reason: "The configured plugin is not installed.",
        command: "openclaw update repair",
        configPaths: [["legacyPluginInput"]],
        validationExcludedPaths: [["legacyPluginInput"]],
      };
      const snapshot = await createConfigIO({
        configPath,
        env: process.env,
        observe: false,
        deferredPluginMigrations: [pending],
      }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues.some((issue) => issue.path.startsWith("tools.exec"))).toBe(true);

      const plan = planAutomaticConfigRepair(snapshot);
      expect(plan).not.toBeNull();
      expect(plan?.config.tools?.exec?.timeoutSeconds).toBe(45);
      expect(plan?.config).not.toHaveProperty("tools.exec.timeoutSec");
      expect(plan?.config).toHaveProperty("legacyPluginInput", source.legacyPluginInput);
      expect(plan?.snapshot.sourceConfig).toHaveProperty(
        "legacyPluginInput",
        source.legacyPluginInput,
      );
      expect(plan?.snapshot.runtimeConfig).not.toHaveProperty("legacyPluginInput");
      expect(plan?.snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig).toHaveProperty("tools.exec.timeoutSec", 45);
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("preserves the admitted reference values when the environment rotates before commit", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", BROWSER_BIN: "/opt/example/browser-planning" },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            browser: { executablePath: "${BROWSER_BIN}" },
            session: { idleMinutes: 45 },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const originalBytes = await fs.readFile(configPath, "utf8");
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.valid).toBe(false);
          const plan = planAutomaticConfigRepair(snapshot);
          if (!plan) {
            throw new Error("expected a repairable session config");
          }
          await withEnvAsync({ BROWSER_BIN: "/opt/example/browser-current" }, async () => {
            await commitAutomaticConfigRepair(plan, snapshot);
            const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
            expect(saved.browser).toEqual({ executablePath: "${BROWSER_BIN}" });
            const reloaded = await readConfigFileSnapshot();
            expect(reloaded.valid).toBe(true);
            expect(reloaded.sourceConfig.browser?.executablePath).toBe(
              "/opt/example/browser-current",
            );
            expect(planAutomaticConfigRepair(reloaded)).toBeNull();
          });
          await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(originalBytes);
        },
      );
    });
  });

  it.each(["${STARTUP_MEMORY_KEY}", "$${STARTUP_MEMORY_KEY}"])(
    "accepts the committed startup repair with a moved %s reference",
    async (apiKey) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync(
          { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", STARTUP_MEMORY_KEY: "fixture-memory-key" },
          async () => {
            const configPath = await writeOpenClawConfig(home, {
              agents: { defaults: { memorySearch: { remote: { apiKey } } } },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            const originalBytes = await fs.readFile(configPath, "utf8");
            const snapshot = await readConfigFileSnapshot();
            expect(snapshot.valid).toBe(false);
            expect(resolveStartupConfigSnapshot(snapshot)?.valid).toBe(true);
            const plan = planAutomaticConfigRepair(snapshot);
            if (!plan) {
              throw new Error("expected a repairable memory config");
            }
            await commitAutomaticConfigRepair(plan, snapshot);
            const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
            expect(saved.memory.search.remote.apiKey).toBe(apiKey);
            const reloaded = await readConfigFileSnapshot();
            expect(reloaded.valid).toBe(true);
            expect(reloaded.sourceConfig.memory?.search?.remote?.apiKey).toBe(
              apiKey.startsWith("$$") ? "${STARTUP_MEMORY_KEY}" : "fixture-memory-key",
            );
            expect(isStartupConfigRepairResult(snapshot, reloaded)).toBe(true);
            expect(resolveStartupConfigSnapshot(reloaded)).toBe(reloaded);
            expect(
              isStartupConfigRepairResult(snapshot, {
                ...reloaded,
                sourceConfig: { ...reloaded.sourceConfig, gateway: { mode: "remote" } },
              }),
            ).toBe(false);
            await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(originalBytes);
          },
        );
      });
    },
  );

  it("plans a deterministic, fully valid migration of retired session keys", () => {
    const snapshot = invalidSnapshot({
      config: { session: { idleMinutes: 45 } } as OpenClawConfig,
      issuePaths: ["session.idleMinutes"],
    });

    const plan = planAutomaticConfigRepair(snapshot);

    expect(plan?.config.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(validateConfigObjectWithPlugins(plan?.config).ok).toBe(true);
    expect(planAutomaticConfigRepair(snapshot)?.config).toEqual(plan?.config);
    expect(snapshot.sourceConfig.session).toEqual({ idleMinutes: 45 });
  });

  it("plans removal of the stable-authored retired keys without changing other config", () => {
    const snapshot = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true, every: "30m" } },
          entries: { main: {} },
        },
        gateway: { mode: "local" },
      } as OpenClawConfig,
      issuePaths: ["meta", "agents.defaults.heartbeat"],
    });

    const plan = planAutomaticConfigRepair(snapshot);

    expect(plan?.config).toEqual({
      meta: { lastTouchedVersion: "2026.7.1-2" },
      agents: { defaults: { heartbeat: { every: "30m" } }, entries: { main: {} } },
      gateway: { mode: "local" },
    });
    expect(plan?.snapshot.valid).toBe(true);
    expect(plan?.snapshot.issues).toEqual([]);
    expect(snapshot.sourceConfig).toHaveProperty("meta.lastTouchedAt");
  });

  it("accepts the canonical writer metadata stamped onto the repaired stable config", () => {
    const before = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true }, workspace: "/tmp/workspace" },
          entries: { main: {} },
        },
        gateway: { mode: "local" },
      } as OpenClawConfig,
      issuePaths: ["meta", "agents.defaults.heartbeat"],
    });
    const repaired = {
      meta: {
        lastTouchedVersion: VERSION,
        migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
      },
      agents: { defaults: { workspace: "/tmp/workspace" }, entries: { main: {} } },
      gateway: { mode: "local" },
    } as OpenClawConfig;
    const after: ConfigFileSnapshot = {
      ...before,
      raw: JSON.stringify(repaired),
      parsed: repaired,
      sourceConfig: repaired,
      resolved: repaired,
      runtimeConfig: repaired,
      config: repaired,
      valid: true,
      issues: [],
      legacyIssues: [],
    };

    expect(isStartupConfigRepairResult(before, after)).toBe(true);
    expect(isStartupConfigRepairResult(before, { ...after, path: "/tmp/other.json" })).toBe(false);
    expect(
      isStartupConfigRepairResult(before, {
        ...after,
        sourceConfig: { ...repaired, gateway: { mode: "remote" } },
      }),
    ).toBe(false);
    expect(
      isStartupConfigRepairResult(before, {
        ...after,
        sourceConfig: { ...repaired, session: { reset: { mode: "idle" } } },
      }),
    ).toBe(false);
  });

  it("plans a config whose only migration is plugin-owned after state admission", () => {
    // The full planner owns plugin contracts; pre-bootstrap uses core-only selection.
    const snapshot = invalidSnapshot({
      config: {
        plugins: { entries: { "active-memory": { config: { qmd: { enabled: true } } } } },
      } as OpenClawConfig,
      issuePaths: ["plugins.entries.active-memory.config.qmd"],
    });

    const resolved = planAutomaticConfigRepair(snapshot)?.snapshot;

    expect(resolved?.valid).toBe(true);
    expect(resolved?.sourceConfig.plugins?.entries?.["active-memory"]?.config).toEqual({});
  });

  it("previews repairable snapshots without touching the shared state database", async () => {
    // Backup discovery and gateway pre-bootstrap resolve before state-database admission;
    // a broken store (here: a directory at the canonical path) must not break the preview.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-repair-preview-"));
    try {
      await fs.mkdir(path.join(root, "state", "openclaw.sqlite"), { recursive: true });
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const snapshot = invalidSnapshot({
          config: {
            session: { idleMinutes: 45 },
            meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
            agents: { list: [{ id: "work", name: "Operator" }] },
            plugins: {
              installs: { example: { source: "path", installPath: "/synthetic/plugin" } },
            },
          } as OpenClawConfig,
          issuePaths: ["session.idleMinutes"],
        });
        const resolved = resolveStartupConfigSnapshot(snapshot);
        expect(resolved?.valid).toBe(true);
        expect(resolved?.sourceConfig.session).toEqual({
          reset: { mode: "idle", idleMinutes: 45 },
        });
        expect(resolved?.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(resolved?.sourceConfig).not.toHaveProperty("plugins.installs");
        expect(resolved?.sourceConfig.agents?.entries?.work).toEqual({ name: "Operator" });
        expect(snapshot.sourceConfig).toHaveProperty("plugins.installs.example");
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("carries surviving reference facts through the repair rewrite", () => {
    const config = {
      session: { idleMinutes: 45 },
      models: {
        providers: {
          minimax: {
            baseUrl: "https://example.invalid/anthropic",
            apiKey: "substituted-not-a-real-key",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["models.providers.minimax.apiKey", "SHORTHAND_KEY"]]),
      ),
    );
    const snapshot = invalidSnapshot({ config, issuePaths: ["session.idleMinutes"] });

    const resolved = resolveStartupConfigSnapshot(snapshot);

    expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(collectEnvSecretRefIds(resolved?.sourceConfig)).toEqual(new Set(["SHORTHAND_KEY"]));
    expect(
      getResolvedConfigEnvSecretRef(resolved?.sourceConfig, "models.providers.minimax.apiKey")?.id,
    ).toBe("SHORTHAND_KEY");
  });

  it("retires a reference fact whose path the repair moved", () => {
    // The repair relocates session.idleMinutes, so a fact recorded at the authored path would
    // otherwise keep answering lookups for a value that no longer lives there.
    const config = { session: { idleMinutes: 45 } } as OpenClawConfig;
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["session.idleMinutes", "MOVED_KEY"]]),
      ),
    );
    const snapshot = invalidSnapshot({ config, issuePaths: ["session.idleMinutes"] });

    const resolved = resolveStartupConfigSnapshot(snapshot);

    expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(getResolvedConfigEnvSecretRef(resolved?.sourceConfig, "session.idleMinutes")).toBeNull();
    // The variable is still referenced by the operator's config, so pre-bootstrap cleanup reads
    // the pre-repair snapshot as well and keeps it out of the delete set.
    expect(collectEnvSecretRefIds(snapshot.sourceConfig)).toEqual(new Set(["MOVED_KEY"]));
  });

  it("keeps a real read's ${VAR} reference through a real legacy repair", async () => {
    // The other repair tests stub the facts onto a hand-built snapshot. This one records them the
    // only way production does: a real config file, read by the real reader, substituted for real.
    await withOpenClawTestState({ prefix: "openclaw-repair-real-reader-" }, async (state) => {
      await state.writeConfig({
        session: { idleMinutes: 45 },
        models: {
          providers: {
            minimax: {
              baseUrl: "https://example.invalid/anthropic",
              api: "anthropic-messages",
              apiKey: "${LEGACY_REPAIR_KEY}",
              models: [],
            },
          },
        },
      });

      const snapshot = await readConfigFileSnapshotFromContext(
        createConfigIoContext({
          configPath: state.configPath,
          env: { ...state.env, LEGACY_REPAIR_KEY: "read-substituted-not-a-real-key" },
          homedir: () => state.home,
          observe: false,
        }),
      );
      // Preconditions: substitution really happened, and the legacy key really makes it repairable.
      expect(snapshot.sourceConfig.models?.providers?.minimax?.apiKey).toBe(
        "read-substituted-not-a-real-key",
      );
      expect(collectEnvSecretRefIds(snapshot.sourceConfig)).toEqual(new Set(["LEGACY_REPAIR_KEY"]));
      expect(snapshot.valid).toBe(false);

      const resolved = resolveStartupConfigSnapshot(snapshot);

      expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
      // Without the fact transfer the repaired clone reports the substituted literal as an
      // ordinary value, so pre-bootstrap deletes the managed key the config still depends on.
      expect(collectEnvSecretRefIds(resolved?.sourceConfig)).toEqual(
        new Set(["LEGACY_REPAIR_KEY"]),
      );
    });
  });

  it("repairs core aliases while preserving an unavailable plugin and its warning", async () => {
    // The availability ruling (#150016/#150312) permits repair while preserving uninspected config.
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath =
        process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw", "openclaw.json");
      const missingPath = path.join(home, "nonexistent-startup-plugin");
      const plugins = { load: { paths: [missingPath] } };
      const raw = JSON.stringify({ session: { idleMinutes: 45 }, plugins });
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, raw);
      const snapshot = await createConfigIO({
        configPath,
        observe: false,
      }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      const plan = planAutomaticConfigRepair(snapshot);
      expect(plan?.config.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
      expect(plan?.config.plugins).toEqual(plugins);
      expect(plan?.snapshot.valid).toBe(true);
      expect(plan?.snapshot.warnings).toContainEqual(
        expect.objectContaining({
          code: "configured-plugin-path-unavailable",
          path: "plugins.load.paths",
          source: missingPath,
        }),
      );
      expect(snapshot.sourceConfig.session).toEqual({ idleMinutes: 45 });
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it.each([
    { name: "a non-legacy type error", config: { gateway: { port: "not-a-number" } } },
    {
      name: "ambiguous legacy default owners",
      config: {
        session: { idleMinutes: 45 },
        agents: { entries: { main: { default: true }, ops: { default: true } } },
      },
    },
    {
      name: "a migration with a remaining type error",
      config: { session: { idleMinutes: 45 }, gateway: { port: "not-a-number" } },
    },
    {
      name: "an included config source",
      config: { session: { idleMinutes: 45 } },
      includedPaths: ["/tmp/included.json"],
    },
    {
      name: "an include directive without recorded include paths",
      config: { $include: "included.json", session: { idleMinutes: 45 } },
    },
    {
      name: "a malformed plugin entry",
      config: {
        session: { idleMinutes: 45 },
        plugins: { entries: { broken: { enabled: "not-a-boolean" } } },
      },
    },
    {
      name: "malformed retired plugin records",
      config: { plugins: { installs: { broken: { source: "invalid" } } } },
    },
    {
      name: "another invalid key at a retired key's schema parent",
      config: { meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z", unrelatedRetiredKey: true } },
    },
  ])("refuses $name", ({ config, includedPaths }) => {
    const snapshot = invalidSnapshot({
      config: config as OpenClawConfig,
      issuePaths: [],
      includedPaths,
    });

    expect(planAutomaticConfigRepair(snapshot)).toBeNull();
    if (config.plugins && "installs" in config.plugins) {
      expect(resolveStartupConfigSnapshot(snapshot)).toBeUndefined();
    }
  });
});
