import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../../version.js";
import {
  isStartupConfigRepairResult,
  planAutomaticConfigRepair,
  resolveStartupConfigSnapshot,
  repairDoctorConfigBeforePluginConvergence,
} from "./automatic-startup-config-repair.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

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
        migrations: { modelPolicyAllowlist: true },
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
      name: "an unresolved plugin validation failure",
      config: {
        session: { idleMinutes: 45 },
        plugins: { load: { paths: ["/nonexistent-startup-plugin"] } },
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

describe("config repair before plugin convergence", () => {
  it.each([
    {
      name: "legacy session idle timeout",
      config: { session: { idleMinutes: 45 } },
      expected: { session: { reset: { mode: "idle", idleMinutes: 45 } } },
    },
    {
      name: "explicit nested session reset precedence",
      config: {
        session: { idleMinutes: 45, reset: { mode: "daily", atHour: 4, idleMinutes: 90 } },
      },
      expected: { session: { reset: { mode: "daily", atHour: 4, idleMinutes: 90 } } },
    },
    {
      name: "existing session reset mode",
      config: { session: { idleMinutes: 45, reset: { mode: "daily", atHour: 4 } } },
      expected: { session: { reset: { mode: "daily", atHour: 4, idleMinutes: 45 } } },
    },
    {
      name: "enabled wide-area discovery",
      config: { discovery: { wideArea: { enabled: true, domain: "discovery.example" } } },
      expected: { discovery: { wideArea: { domain: "discovery.example" } } },
    },
    {
      name: "disabled wide-area discovery",
      config: { discovery: { wideArea: { enabled: false, domain: "discovery.example" } } },
      expected: { discovery: { wideArea: {} } },
    },
  ])("repairs $name through the strict writer", async ({ config, expected }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({ ...config, plugins: { enabled: false } });
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
        },
        async () => {
          await repairDoctorConfigBeforePluginConvergence();
          const after = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "0" }, async () => {
            expect(validateConfigObjectWithPlugins(after).ok).toBe(true);
          });
          expect(after).toMatchObject(expected);
          expect(after.session ?? {}).not.toHaveProperty("idleMinutes");
          expect(after.discovery?.wideArea ?? {}).not.toHaveProperty("enabled");
          expect(await repairDoctorConfigBeforePluginConvergence()).toEqual([]);
        },
      );
    });
  });

  it("normalizes pure aliases without mutating input or consuming deferred migration inputs", () => {
    const raw = {
      session: { idleMinutes: 45 },
      agents: { list: [{ id: "alpha", default: true }, { id: "beta" }] },
      cron: { store: "/retained/cron.json" },
      tts: { prefsPath: "/retained/tts.json" },
      memory: { search: { store: { path: "/retained/memory.sqlite" } } },
      channels: { signal: { httpHost: "localhost", httpPort: 8080 } },
      web: { enabled: false },
    };
    const before = structuredClone(raw);
    const result = applyLegacyDoctorMigrations(raw, undefined, {
      pluginContracts: false,
      beforePluginConvergence: true,
    });
    expect(result.next).toEqual({
      ...before,
      session: { reset: { mode: "idle", idleMinutes: 45 } },
    });
    expect(raw).toEqual(before);
  });

  it("does not overwrite an invalid explicit nested reset to admit an early write", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        session: { idleMinutes: 45, reset: { idleMinutes: "invalid" } },
        plugins: { enabled: false },
      });
      const before = await fs.readFile(state.configPath);
      expect(await repairDoctorConfigBeforePluginConvergence()).toEqual([]);
      expect(await fs.readFile(state.configPath)).toEqual(before);
    });
  });

  it.each(["absent", "empty"])(
    "initializes an %s ordinary roster while repairing core aliases",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: { ...(kind === "empty" ? { entries: {} } : {}), defaults: { pdfMaxBytesMb: 5 } },
          tools: { exec: { security: "deny", ask: "off" } },
          plugins: { enabled: false },
        });
        expect(await repairDoctorConfigBeforePluginConvergence()).not.toEqual([]);
        const after = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(after.agents.entries).toEqual({ main: {} });
        expect(after.agents.defaults.pdfMaxMb).toBe(5);
        expect(after.agents.defaults).not.toHaveProperty("pdfMaxBytesMb");
        expect(after.agents.defaults).not.toHaveProperty("systemAgent");
        expect(after.tools.exec).toEqual({ mode: "deny" });
      });
    },
  );
  it.each(["locators", "include", "invalid", "roster", "keyed-roster", "records", "empty-records"])(
    "retains %s inputs when independent repairs cannot form a valid write",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const legacy = {
          session: { idleMinutes: 45 },
          agents: { entries: {}, defaults: { pdfMaxBytesMb: 5 } },
          tools: { exec: { security: "deny", ask: "off" } },
        };
        await state.writeConfig({
          ...legacy,
          ...(kind === "roster"
            ? {
                agents: {
                  defaults: legacy.agents.defaults,
                  list: [{ id: "alpha", default: true }, { id: "beta" }],
                },
              }
            : {}),
          ...(kind === "keyed-roster"
            ? {
                agents: {
                  defaults: legacy.agents.defaults,
                  entries: { alpha: { default: true }, beta: {} },
                },
              }
            : {}),
          ...(kind === "locators"
            ? {
                cron: { store: state.path("retained-cron.sqlite") },
                tts: { prefsPath: state.path("retained-tts.json") },
                memory: { search: { store: { path: state.path("retained-memory.sqlite") } } },
              }
            : {}),
          ...(kind === "records" || kind === "empty-records"
            ? {
                plugins: {
                  enabled: false,
                  installs:
                    kind === "empty-records"
                      ? {}
                      : { fixture: { source: "path", installPath: state.path("plugin") } },
                },
              }
            : {}),
          ...(kind === "invalid" ? { gateway: { port: "not-a-port" } } : {}),
          ...(kind === "include" ? { $include: "./included.json" } : {}),
        });
        if (kind === "include") {
          await fs.writeFile(
            state.statePath("included.json"),
            JSON.stringify({ gateway: { mode: "local" } }),
          );
        }
        const before = await fs.readFile(state.configPath);
        expect(await repairDoctorConfigBeforePluginConvergence()).toEqual([]);
        expect(await fs.readFile(state.configPath)).toEqual(before);
      });
    },
  );
});
