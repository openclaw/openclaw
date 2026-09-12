// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

describe("Doctor health during configured-plugin repair deferral", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", undefined);
    mocks.config.mockReset().mockReturnValue({});
    mocks.packageRoot.mockReset().mockReturnValue(undefined);
    mocks.service.mockReset();
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
    mocks.writeUpdatePostInstallDoctorResult.mockClear();
  });

  it.each(
    ["explicit", "writable-parent"].flatMap((parent) =>
      [false, true].flatMap((resultChannel) =>
        [false, true].map((unreadableState) => ({ parent, resultChannel, unreadableState })),
      ),
    ),
  )(
    "defers before stale plugin hooks or state work ($parent, IPC=$resultChannel, unreadable=$unreadableState)",
    async ({ parent, resultChannel, unreadableState }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv(
          parent === "explicit"
            ? "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR"
            : "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
          "1",
        );
        const resultPath = state.path("doctor-result.json");
        if (resultChannel) {
          vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
        }
        await state.writeConfig({
          agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
          plugins: { entries: { telegram: { enabled: true } } },
        });
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        fs.writeFileSync(
          sourcePath,
          JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
        );
        const configBefore = fs.readFileSync(state.configPath);
        const sourceBefore = fs.readFileSync(sourcePath);
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const coordinatorPath = resolveStateDatabaseCoordinatorPath({
          databasePath,
          runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
          uid: process.getuid?.(),
        });
        const unreadableBytes = Buffer.from("unreadable state database fixture\n");
        if (unreadableState) {
          fs.mkdirSync(path.dirname(databasePath), { recursive: true });
          fs.writeFileSync(databasePath, unreadableBytes);
        }
        // Retained plugin Doctor hooks can import APIs removed by the new core.
        // The health entrypoint must not reach config discovery before convergence.
        mocks.config.mockImplementation(() => {
          throw new Error("Cannot find module 'openclaw/plugin-sdk/retired-api'");
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.service).not.toHaveBeenCalled();
        expect(fs.existsSync(coordinatorPath)).toBe(false);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
        expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
        if (unreadableState) {
          expect(fs.readFileSync(databasePath)).toEqual(unreadableBytes);
        } else {
          // No database means no migration receipts or config observations were written.
          expect(fs.existsSync(databasePath)).toBe(false);
        }
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.error).not.toHaveBeenCalled();
        if (resultChannel) {
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledExactlyOnceWith({
            resultPath,
            result: {
              status: "advisory",
              advisory: {
                kind: "package-post-install-doctor",
                message: expect.any(String),
                reason: "deferred-configured-plugin-repair",
                details: expect.arrayContaining([expect.stringMatching(/defer|post-core/i)]),
              },
              configHash: "unchanged",
            },
          });
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledBefore(runtime.exit);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(86);
        } else {
          expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          expect([...runtime.log.mock.calls, ...mocks.outro.mock.calls].flat().join("\n")).toMatch(
            /deferred.*post-core|post-core.*deferred/is,
          );
        }
      });
    },
  );

  it.each([false, true])(
    "repairs independent config aliases while plugin work is deferred (plugin=%s)",
    async (withPlugin) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
        const pluginRoot = state.statePath("extensions", "fixture");
        const runtimeMarker = state.path("stale-doctor-loaded");
        fs.mkdirSync(pluginRoot, { recursive: true });
        fs.writeFileSync(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/stale",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        fs.writeFileSync(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id: "fixture",
            doctorContract: { configRepair: true, stateMigrations: true },
            configSchema: { type: "object" },
          }),
        );
        const pluginSource = `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded"); throw new Error("stale plugin API");`;
        fs.writeFileSync(path.join(pluginRoot, "index.js"), pluginSource);
        fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.js"), pluginSource);
        await state.writeConfig({
          session: { idleMinutes: 45 },
          agents: { entries: {}, defaults: { pdfMaxBytesMb: 5 } },
          tools: { exec: { security: "deny", ask: "off" } },
          plugins: withPlugin
            ? {
                allow: ["fixture"],
                entries: { fixture: { enabled: true } },
                load: { paths: [pluginRoot] },
              }
            : { enabled: false },
        });
        mocks.config.mockImplementation(() => {
          throw new Error("full config flow must wait");
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        const after = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "0" }, async () => {
          expect(validateConfigObjectWithPlugins(after).ok).toBe(true);
        });
        expect(after.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
        expect(after.agents.defaults).toMatchObject({ pdfMaxMb: 5 });
        expect(after.agents.defaults).not.toHaveProperty("pdfMaxBytesMb");
        expect(after.tools.exec).toEqual({ mode: "deny" });
        expect(fs.existsSync(runtimeMarker)).toBe(false);
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.config).not.toHaveBeenCalled();
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("deferred until post-core"),
        );
      });
    },
  );

  it.each(["standalone", "post-core"])(
    "still performs real state repair and records its receipt in %s Doctor",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        if (phase === "post-core") {
          vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
          vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
          vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
          vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");
        }
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        };
        await state.writeConfig(cfg);
        mocks.config.mockReturnValue(cfg);
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        const completedAt = "2026-07-15T00:00:00.000Z";
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, setupCompletedAt: completedAt }));
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyWorkspaceState({
            stateDir: state.stateDir,
            env: state.env,
            detected: await detectLegacyWorkspaceState({
              cfg: ctx.cfg,
              stateDir: state.stateDir,
              env: state.env,
              homedir: () => state.home,
              doctorOnlyStateMigrations: true,
            }),
          });
          expect(result.warnings).toEqual([]);
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

        expect(mocks.config).toHaveBeenCalledOnce();
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt).toBe(
          completedAt,
        );
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT removed_source FROM migration_sources WHERE source_path = ?")
            .get(sourcePath),
        ).toEqual({ removed_source: 1 });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );
});
