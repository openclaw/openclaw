import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../../../config/config.js";
import { writeOpenClawConfig } from "../../../config/test-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { withEnvAsync } from "../../../test-utils/env.js";
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
