import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { resolveUpdateCandidatePluginPath } from "../../../infra/update-candidate-paths.js";
import { buildUpdateRehearsalPathEnv } from "../../../infra/update-rehearsal-paths.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { buildPluginCapabilityConsentReview } from "../../../plugins/capability-summary.js";
import { commitPluginInstallRecordsOnly } from "../../../plugins/install-record-commit.js";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../../../plugins/install-root-context.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { convergeDoctorMigrationPlugins } from "./migration-plugin-convergence.js";

const mocks = vi.hoisted(() => ({
  converge:
    vi.fn<
      typeof import("../../doctor-config-preflight-plugin-verification.js").runStartupUpgradeConvergence
    >(),
}));

vi.mock("../../doctor-config-preflight-plugin-verification.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../doctor-config-preflight-plugin-verification.js")
  >()),
  runStartupUpgradeConvergence: mocks.converge,
}));

async function seedLegacyPluginConfig(state: OpenClawTestState) {
  const pluginId = "migration-fixture";
  const installPath = state.statePath("plugins", pluginId);
  const legacyStorePath = state.path("legacy-memory.sqlite");
  const runtimeMarker = state.path("stale-runtime-loaded");
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(
    path.join(installPath, "package.json"),
    JSON.stringify({
      name: "@fixture/migration-fixture",
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  fs.writeFileSync(
    path.join(installPath, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      doctorContract: { stateMigrations: true },
      configSchema: { type: "object" },
    }),
  );
  fs.writeFileSync(
    path.join(installPath, "index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded");\nthrow new Error("stale plugin API");\n`,
  );
  fs.writeFileSync(legacyStorePath, "legacy memory source bytes\n");
  const record: PluginInstallRecord = {
    source: "npm",
    spec: "@fixture/migration-fixture@1.0.0",
    installPath,
    version: "1.0.0",
  };
  const config = {
    agents: {
      entries: { main: {} },
      defaults: { memorySearch: { store: { path: legacyStorePath } } },
    },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true } },
      installs: { [pluginId]: record },
    },
  };
  await state.writeConfig(config);
  return {
    config,
    record,
    pluginId,
    runtimeMarker,
    legacyStorePath,
    configBefore: fs.readFileSync(state.configPath),
    legacyBefore: fs.readFileSync(legacyStorePath),
  };
}

describe("Doctor migration plugin generation", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
    mocks.converge.mockReset();
  });

  it.each(["legacy-parent", "read-only", "future"] as const)(
    "preserves install authority before convergence for %s config",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = await seedLegacyPluginConfig(state);
        if (mode === "future") {
          await state.writeConfig({ ...fixture.config, meta: { lastTouchedVersion: "9999.1.0" } });
        }
        const before = fs.readFileSync(state.configPath);
        const records = readPersistedInstalledPluginIndexInstallRecords({ env: state.env });
        const env = {
          ...state.env,
          ...(mode === "legacy-parent"
            ? {
                OPENCLAW_UPDATE_IN_PROGRESS: "1",
                OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "0",
              }
            : {}),
          ...(mode === "read-only" ? { OPENCLAW_CONFIG_READONLY: "1" } : {}),
        };
        mocks.converge.mockResolvedValue({ blockingDiagnostic: null, quarantinedPlugins: [] });
        const outcome = await convergeDoctorMigrationPlugins({ env }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          records,
        );
        expect(fs.readFileSync(state.configPath)).toEqual(before);
        expect(fs.readFileSync(fixture.legacyStorePath)).toEqual(fixture.legacyBefore);
        expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
        expect(mocks.converge).not.toHaveBeenCalled();
        if (mode === "legacy-parent") {
          expect(outcome).toEqual({ value: false });
        } else {
          expect(outcome).toMatchObject({
            error: expect.objectContaining({
              message: expect.stringContaining(
                mode === "read-only" ? "immutable" : "older than the config",
              ),
            }),
          });
        }
      });
    },
  );

  it("completes copied plugin dependencies before convergence inspects them", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await seedLegacyPluginConfig(state);
      const original = state.path("original-plugins", "demo");
      const shared = state.path("original-plugins", "shared");
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.cpSync(fixture.record.installPath!, original, { recursive: true });
      fs.mkdirSync(shared);
      const entry = 'module.exports = require("../shared/value.cjs");';
      fs.writeFileSync(path.join(original, "index.js"), entry);
      fs.writeFileSync(path.join(shared, "package.json"), '{"name":"fixture-shared"}');
      fs.writeFileSync(path.join(shared, "value.cjs"), 'module.exports = "copied-ready";');
      const copied = resolveUpdateCandidatePluginPath(
        state.path("serving-state"),
        state.stateDir,
        original,
      );
      const copiedShared = resolveUpdateCandidatePluginPath(
        state.path("serving-state"),
        state.stateDir,
        shared,
      );
      fs.mkdirSync(path.dirname(copied), { recursive: true });
      fs.cpSync(original, copied, { recursive: true });
      fixture.record.installPath = copied;
      await state.writeConfig(fixture.config);
      const before = fs.readFileSync(state.configPath);
      const env = {
        ...state.env,
        ...buildUpdateRehearsalPathEnv(state.stateDir),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      };
      expect(fs.existsSync(copiedShared)).toBe(false);
      mocks.converge.mockImplementation(async () => {
        expect(fs.readFileSync(path.join(copiedShared, "value.cjs"), "utf8")).toBe(
          'module.exports = "copied-ready";',
        );
        expect(fs.readFileSync(path.join(copied, "index.js"), "utf8")).toBe(entry);
        return { blockingDiagnostic: null, quarantinedPlugins: [] };
      });
      await withEnvAsync(env, async () => {
        await expect(convergeDoctorMigrationPlugins({ env: process.env })).resolves.toBe(true);
      });
      expect(mocks.converge).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(original, "index.js"), "utf8")).toBe(entry);
      expect(fs.readFileSync(state.configPath)).toEqual(before);
      expect(fs.readFileSync(fixture.legacyStorePath)).toEqual(fixture.legacyBefore);
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
    });
  });

  it.each([
    "private",
    "pinned-outside",
    "symlink",
    "database-symlink",
    "env-only",
    "cache-symlink",
  ] as const)("keeps rehearsal convergence on its actual private roots (%s)", async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await seedLegacyPluginConfig(state);
      const outside = state.path("serving-plugin-root");
      fs.mkdirSync(outside);
      const marker = path.join(outside, "preserved");
      fs.writeFileSync(marker, "original plugin root");
      const env = {
        ...state.env,
        ...buildUpdateRehearsalPathEnv(state.stateDir),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        npm_config_cache: state.path("parent-cache"),
      };
      const roots = resolvePluginInstallRoots(env);
      if (kind === "symlink") {
        fs.symlinkSync(outside, roots.npmDir, "junction");
      }
      if (kind === "database-symlink") {
        fs.mkdirSync(path.dirname(resolveOpenClawStateSqlitePath(env)), { recursive: true });
        fs.symlinkSync(marker, resolveOpenClawStateSqlitePath(env));
      }
      if (kind === "cache-symlink") {
        fs.mkdirSync(path.join(state.stateDir, "cache"), { recursive: true });
        fs.symlinkSync(outside, path.join(state.stateDir, "cache", "npm"), "junction");
      }
      const selected = kind === "pinned-outside" ? { ...roots, npmDir: outside } : roots;
      mocks.converge.mockImplementation(async ({ env: derived, beforePersistentEffect }) => {
        expect(derived.npm_config_cache).toBe(env.npm_config_cache);
        expect(process.env.npm_config_cache).toBe(env.npm_config_cache);
        expect(beforePersistentEffect).toBeTypeOf("function");
        beforePersistentEffect?.();
        // A context change while convergence waits must not authorize a write there.
        await withPluginInstallRoots({ ...roots, extensionsDir: outside }, async () => {
          expect(() => beforePersistentEffect?.()).toThrow("escapes the update rehearsal");
        });
        return { blockingDiagnostic: null, quarantinedPlugins: [] };
      });
      await withEnvAsync(kind === "env-only" ? {} : env, async () => {
        await withPluginInstallRoots(selected, async () => {
          const outcome = convergeDoctorMigrationPlugins({
            env: kind === "env-only" ? env : process.env,
          });
          if (kind === "private") {
            await expect(outcome).resolves.toBe(true);
            expect(mocks.converge).toHaveBeenCalledOnce();
          } else {
            await expect(outcome).rejects.toThrow(
              kind === "env-only" ? "authority changed" : "escapes the update rehearsal",
            );
            expect(mocks.converge).not.toHaveBeenCalled();
            if (kind !== "database-symlink") {
              expect(
                readPersistedInstalledPluginIndexInstallRecords({ env: process.env }),
              ).toBeNull();
            }
          }
        });
      });
      expect(fs.readFileSync(marker, "utf8")).toBe("original plugin root");
      expect(fs.readFileSync(state.configPath)).toEqual(fixture.configBefore);
      expect(fs.readFileSync(fixture.legacyStorePath)).toEqual(fixture.legacyBefore);
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
    });
  });

  it("imports retired package records before repair without consuming legacy migration inputs", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await seedLegacyPluginConfig(state);
      const nextRecord = { ...fixture.record, version: "2.0.0" };
      const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
        reviewToken: review.reviewToken,
      }));
      mocks.converge.mockImplementation(async ({ cfg, env, onCapabilityConsent: consent }) => {
        expect(cfg).toEqual(fixture.config);
        expect(env).toBe(state.env);
        expect(consent).toBe(onCapabilityConsent);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual({
          [fixture.pluginId]: fixture.record,
        });
        expect(fs.readFileSync(state.configPath)).toEqual(fixture.configBefore);
        const review = buildPluginCapabilityConsentReview({
          pluginId: fixture.pluginId,
          manifest: { name: "Migration fixture", version: "2.0.0", hooks: ["before_agent_start"] },
          record: nextRecord,
          config: cfg,
        });
        expect(await consent?.(review)).toEqual({ reviewToken: review.reviewToken });
        await commitPluginInstallRecordsOnly({
          nextInstallRecords: { [fixture.pluginId]: nextRecord },
          nextConfig: cfg,
        });
        return { blockingDiagnostic: null, quarantinedPlugins: [] };
      });

      await convergeDoctorMigrationPlugins({ env: state.env, onCapabilityConsent });

      expect(onCapabilityConsent).toHaveBeenCalledOnce();
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({
        [fixture.pluginId]: nextRecord,
      });
      expect(fs.readFileSync(state.configPath)).toEqual(fixture.configBefore);
      expect(fs.readFileSync(fixture.legacyStorePath)).toEqual(fixture.legacyBefore);
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT count(*) AS count FROM migration_sources")
          .get(),
      ).toEqual({ count: 0 });
    });
  });

  it.each(["warning", "quarantine", "throw"] as const)(
    "refuses unavailable migration plugins without normalizing source config (%s)",
    async (failure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = await seedLegacyPluginConfig(state);
        const diagnostic = "Migration fixture needs capability consent before upgrade";
        mocks.converge.mockImplementation(async () => {
          if (failure === "throw") {
            throw new Error(diagnostic);
          }
          return {
            blockingDiagnostic:
              failure === "warning"
                ? { kind: "plugin-verification", messages: [diagnostic] }
                : null,
            quarantinedPlugins:
              failure === "quarantine"
                ? [
                    {
                      pluginId: fixture.pluginId,
                      state: "configured-unavailable",
                      diagnostic: {
                        kind: "plugin-verification",
                        reason: "missing-extension-entry",
                        detail: "Migration entrypoint is missing",
                        installPath: fixture.record.installPath,
                      },
                    },
                  ]
                : [],
          };
        });

        await expect(convergeDoctorMigrationPlugins({ env: state.env })).rejects.toThrow(
          failure === "quarantine" ? "before migrating state" : diagnostic,
        );

        expect(fs.readFileSync(state.configPath)).toEqual(fixture.configBefore);
        expect(fs.readFileSync(fixture.legacyStorePath)).toEqual(fixture.legacyBefore);
        expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({
          [fixture.pluginId]: fixture.record,
        });
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT count(*) AS count FROM migration_sources")
            .get(),
        ).toEqual({ count: 0 });
      });
    },
  );

  it("does not block independent repairs for a quarantined plugin with no Doctor contract", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await seedLegacyPluginConfig(state);
      fs.writeFileSync(
        path.join(fixture.record.installPath!, "openclaw.plugin.json"),
        JSON.stringify({
          id: fixture.pluginId,
          doctorContract: {},
          configSchema: { type: "object" },
        }),
      );
      mocks.converge.mockResolvedValue({
        blockingDiagnostic: null,
        quarantinedPlugins: [
          {
            pluginId: fixture.pluginId,
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "missing-extension-entry",
              detail: "Unrelated runtime entry is missing",
              installPath: fixture.record.installPath,
            },
          },
        ],
      });
      await expect(convergeDoctorMigrationPlugins({ env: state.env })).resolves.toBe(true);
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      expect(fs.readFileSync(state.configPath)).toEqual(fixture.configBefore);
    });
  });

  it.each(["legacy-channel", "route-owner"])(
    "retains unavailable %s migration contracts",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = await seedLegacyPluginConfig(state);
        const installPath = fixture.record.installPath!;
        fs.writeFileSync(
          path.join(installPath, "openclaw.plugin.json"),
          JSON.stringify({
            id: fixture.pluginId,
            ...(kind === "legacy-channel" ? { channels: [fixture.pluginId] } : {}),
            doctorContract: kind === "legacy-channel" ? {} : { sessionRouteStateOwners: true },
            configSchema: { type: "object" },
          }),
        );
        fs.writeFileSync(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@fixture/migration-fixture",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"], setupEntry: "./setup-entry.js" },
          }),
        );
        fs.writeFileSync(
          path.join(installPath, "setup-entry.js"),
          "throw new Error('unavailable legacy setup must not run');",
        );
        mocks.converge.mockResolvedValue({
          blockingDiagnostic: null,
          quarantinedPlugins: [
            {
              pluginId: fixture.pluginId,
              state: "configured-unavailable",
              diagnostic: {
                kind: "plugin-verification",
                reason: "missing-extension-entry",
                detail: "Unavailable package",
                installPath,
              },
            },
          ],
        });
        await expect(convergeDoctorMigrationPlugins({ env: state.env })).rejects.toThrow(
          "before migrating state",
        );
        expect(fs.readFileSync(state.configPath)).toEqual(fixture.configBefore);
        expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      });
    },
  );

  it("refuses invalid retired package records before invoking plugin repair", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        agents: { defaults: { memorySearch: { store: { path: state.path("legacy.sqlite") } } } },
        plugins: { installs: { fixture: { source: "invalid" } } },
      });
      const before = fs.readFileSync(state.configPath);

      await expect(convergeDoctorMigrationPlugins({ env: state.env })).rejects.toThrow(
        "plugins.installs contains invalid records",
      );

      expect(mocks.converge).not.toHaveBeenCalled();
      expect(fs.readFileSync(state.configPath)).toEqual(before);
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toBeNull();
    });
  });
});
