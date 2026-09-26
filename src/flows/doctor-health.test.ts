// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "../state/openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "../state/openclaw-agent-session-participants-schema.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const support = await import("./doctor-health.test-support.js");
const { mocks, registerDoctorConfigReceiptTests, postInstallAdvisory } = support;

describe("runDoctorHealthFlow", () => {
  const { materializeSharedStateDatabase, openHistoricalAgentDatabase } = useDoctorHealthFixture();

  it.each(support.doctorServiceInspectionCases)(
    "admits state repair without claiming unavailable service authority: $kind (update=$updateParent)",
    async ({ kind, updateParent }) => {
      if (updateParent) {
        for (const [key, value] of Object.entries(
          buildUpdateDoctorEnv({
            allowGatewayServiceRepair: true,
            allowGatewayActivation: false,
          }),
        )) {
          vi.stubEnv(key, value);
        }
      }
      if (kind === "absent-busy-port" || kind === "absent-unknown-port") {
        mocks.probePortUsage.mockResolvedValue(kind === "absent-busy-port" ? "busy" : "unknown");
      }
      const windows = kind.startsWith("windows");
      mocks.emulateNativeInstall = kind !== "runtime-only";
      mocks.servicePlatform = windows ? "win32" : undefined;
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const inspectionUnavailable =
          kind.startsWith("unresolved") ||
          [
            "inspection-failed",
            "owned-unknown",
            "foreign-unknown",
            "absent-unknown",
            "absent-busy-port",
            "absent-unknown-port",
          ].includes(kind) ||
          (kind === "foreign-respawning" && process.platform === "linux");
        const resultPath = state.path("doctor-result.json");
        if (updateParent) {
          vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
        }
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        };
        await state.writeConfig(cfg);
        fs.mkdirSync(state.workspaceDir, { recursive: true });
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        const completedAt = "2026-07-15T00:00:00.000Z";
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, setupCompletedAt: completedAt }));
        const sourceBefore = fs.readFileSync(sourcePath);
        const configBefore = fs.readFileSync(state.configPath);
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const coordinatorPath = resolveStateDatabaseCoordinatorPath({
          databasePath,
          runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
          uid: process.getuid?.(),
        });
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(fs.existsSync(coordinatorPath)).toBe(false);

        const foreign = kind.startsWith("foreign") || windows;
        const foreignRoot = state.path("foreign-install");
        if (foreign) {
          fs.mkdirSync(foreignRoot);
          fs.writeFileSync(path.join(foreignRoot, "package.json"), '{"name":"openclaw"}');
        }
        const entrypoint = kind.startsWith("unresolved")
          ? "operator-wrapper"
          : path.join(foreign ? foreignRoot : process.cwd(), "openclaw.mjs");
        const stop = vi.fn();
        const restart = vi.fn();
        mocks.packageRoot.mockReturnValue(process.cwd());
        mocks.config.mockClear().mockReturnValue(cfg);
        mocks.service.mockReturnValue({
          readCommand: async () => {
            if (kind === "inspection-failed") {
              throw new Error("synthetic manager inspection failure");
            }
            return kind.startsWith("absent")
              ? null
              : {
                  programArguments: [process.execPath, entrypoint, "gateway"],
                  environment: {
                    OPENCLAW_STATE_DIR: foreign ? state.path("foreign-state") : state.stateDir,
                    OPENCLAW_CONFIG_PATH: foreign ? state.path("foreign.json") : state.configPath,
                  },
                };
          },
          readRuntime: async () => ({
            status:
              (kind.endsWith("unknown") && !kind.endsWith("loaded-unknown") && !windows) ||
              (kind.endsWith("respawning") && process.platform === "linux")
                ? "unknown"
                : kind.endsWith("running") && !windows
                  ? "running"
                  : "stopped",
            systemd: { managerUid: process.getuid?.() ?? 2001 },
            ...(kind.startsWith("absent") ? { missingUnit: true } : {}),
          }),
          isLoaded: async () => {
            if (kind === "absent-unknown") {
              throw new Error("synthetic manager unavailable");
            }
            return (
              windows ||
              kind.includes("stopped-loaded") ||
              kind.endsWith("running") ||
              kind.endsWith("loaded") ||
              kind.endsWith("respawning")
            );
          },
          isEnabled: async () => {
            if (kind.endsWith("loaded-unknown")) {
              throw new Error("synthetic enabled-state inspection failure");
            }
            return !kind.endsWith("loaded-disabled");
          },
          stop,
          restart,
        });
        mocks.taskDefinitelyStopped.mockReturnValue(
          windows ? kind === "windows-ready" : !kind.endsWith("respawning"),
        );
        if (kind === "windows-startup-stopped") {
          mocks.startupFallbackRuntime.mockResolvedValue({ status: "stopped" });
        } else if (kind === "windows-startup-unknown") {
          mocks.startupFallbackRuntime.mockRejectedValue(
            new Error("synthetic task inspection failure"),
          );
        }
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
        const run = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        if (
          inspectionUnavailable ||
          kind === "runtime-only" ||
          kind.endsWith("stopped") ||
          (kind.includes("stopped-loaded") && process.platform !== "darwin") ||
          kind === "absent" ||
          kind === "windows-ready" ||
          (kind.endsWith("loaded-disabled") && process.platform !== "darwin")
        ) {
          await run;
          expect(
            (await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt,
          ).toBe(completedAt);
          expect(fs.existsSync(sourcePath)).toBe(false);
          expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          if (inspectionUnavailable) {
            const action = "Restart the Gateway you launched manually after the update.";
            expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(action));
            if (updateParent) {
              expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
                resultPath,
                result: expect.objectContaining({
                  status: "ok",
                  warnings: expect.arrayContaining([expect.stringContaining(action)]),
                }),
              });
            }
          } else if (kind !== "absent" && kind !== "runtime-only") {
            expect(runtime.log).toHaveBeenCalledWith(
              expect.stringContaining("stopped Gateway service was left unchanged"),
            );
          }
        } else {
          await expect(run).rejects.toThrow("Doctor could not enter maintenance");
          await expect(run).rejects.toThrow("gateway status --deep");
          await expect(run).rejects.toThrow("openclaw doctor --fix");
          await expect(run).rejects.not.toThrow(/--no-restart|before the update/);
          expect(mocks.config).not.toHaveBeenCalled();
          expect(mocks.runContributions).not.toHaveBeenCalled();
          expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
          expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
          expect(fs.existsSync(databasePath)).toBe(false);
          expect(fs.existsSync(coordinatorPath)).toBe(false);
          expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        }
        if (kind === "absent" || kind === "absent-busy-port" || kind === "absent-unknown-port") {
          expect(mocks.probePortUsage).toHaveBeenCalledOnce();
        }
        if (windows) {
          expect(mocks.taskDefinitelyStopped).toHaveBeenCalled();
          if (kind.startsWith("windows-startup")) {
            expect(mocks.startupFallbackRuntime).toHaveBeenCalled();
          }
        }
        if (kind === "runtime-only") {
          expect(mocks.service).not.toHaveBeenCalled();
        }
        expect(stop).not.toHaveBeenCalled();
        expect(restart).not.toHaveBeenCalled();
      });
    },
  );

  registerDoctorConfigReceiptTests(runDoctorHealthFlow);

  it.each([{ repair: true }, { yes: true }])(
    "refuses blocked required migration for %j, then completes after the writer releases",
    async (options) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const initial = openHistoricalAgentDatabase({ agentId: "main", env: state.env });
        initial.db.close();
        closeOpenClawAgentDatabasesForTest();
        const before = fs.readFileSync(initial.path);
        const leaseId = claimOpenClawAgentDatabaseLease({
          agentId: "main",
          path: initial.path,
          env: state.env,
        });
        const maintenanceOutcome = support.seedMaintenanceStartupFailure(() =>
          openOpenClawStateDatabase({ env: state.env }),
        );
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyMediaPersistence();
          ctx.runtime.log(result.warnings.join("\n"));
          if (result.warnings.length > 0 && (ctx.options.repair || ctx.options.yes)) {
            ctx.postInstallDoctorResult = postInstallAdvisory;
          }
        });
        try {
          // Diagnostic-only Doctor retains advisory behavior while the writer is live.
          await runDoctorHealthFlow(runtime, { nonInteractive: true });
          expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          mocks.outro.mockClear();
          vi.stubEnv(
            "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
            state.path("advisory.json"),
          );
          await runCommandWithRuntime(runtime, () =>
            runDoctorHealthFlow(runtime, { ...options, nonInteractive: true }),
          );
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(runtime.error).toHaveBeenCalledWith(
            "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.",
          );
          expect(maintenanceOutcome()).toEqual({ outcome: "startup_failed" });
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
            resultPath: state.path("advisory.json"),
            result: {
              status: "error",
              configHash: "unchanged",
              failureFacts: [
                {
                  check: "doctor",
                  code: "agent-database-lease-active",
                  message:
                    "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.",
                },
              ],
            },
          });
          expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          expect(fs.readFileSync(initial.path)).toEqual(before);
          expect(
            openOpenClawStateDatabase({ env: state.env })
              .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
              .get(leaseId),
          ).toEqual({ lease_id: leaseId });
        } finally {
          vi.unstubAllEnvs();
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        }
        runtime.exit.mockClear();
        await runDoctorHealthFlow(runtime, { ...options, nonInteractive: true });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          reopened.db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(maintenanceOutcome()).toEqual({ outcome: "startup_failure_repaired" });
      });
    },
  );

  it.each(["default", "configured"])(
    "refuses failed migration of an unregistered %s store",
    async (layout) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath =
          layout === "configured" ? state.path("custom", "sessions.json") : undefined;
        const cfg: OpenClawConfig = storePath ? { session: { store: storePath } } : {};
        mocks.config.mockReturnValue(cfg);
        const configuredPath = storePath
          ? resolveSqliteTargetFromSessionStorePath(storePath, {
              agentId: "main",
              defaultAgentId: "main",
              env: state.env,
            }).path
          : undefined;
        const initial = openHistoricalAgentDatabase({
          agentId: "main",
          env: state.env,
          ...(configuredPath ? { path: configuredPath } : {}),
        });
        initial.db.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
        initial.db.exec(
          "CREATE INDEX unknown_participant_dependency ON session_participants(actor_id);",
        );
        initial.db.close();
        closeOpenClawAgentDatabasesForTest();
        unregisterOpenClawAgentDatabase({ agentId: "main", path: initial.path, env: state.env });
        const before = fs.readFileSync(initial.path);
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyMediaPersistence({
            configuredAgentDatabaseTargets: configuredPath
              ? [{ agentId: "main", path: configuredPath }]
              : [],
          });
          ctx.runtime.log(result.warnings.join("\n"));
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("unknown indexes, views, or triggers"),
        );
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          [
            "Doctor could not complete repair because persisted database readiness could not be verified:",
            `agent ${initial.path}: OpenClaw agent database ${initial.path} uses schema version 17; run openclaw doctor --fix before compacting it.`,
            "Stop OpenClaw processes, then restore the affected database from a verified backup.",
          ].join("\n"),
        );
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(fs.readFileSync(initial.path)).toEqual(before);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT * FROM agent_databases")
            .all(),
        ).toEqual([]);
      });
    },
  );

  it("keeps archive repair failures advisory after required database migration succeeds", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      materializeSharedStateDatabase(state.env);
      openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      closeOpenClawAgentDatabasesForTest();
      const archive = await state.writeText(
        "agents/main/sessions/corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z",
        "invalid JSON\n",
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      mocks.runContributions.mockImplementation(async (ctx) => {
        const result = await migrateLegacyMediaPersistence();
        ctx.runtime.log(result.warnings.join("\n"));
      });
      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Skipped archived transcript media migration"),
      );
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(fs.readFileSync(archive, "utf8")).toBe("invalid JSON\n");
    });
  });

  it.each(["default", "configured"] as const)(
    "fails repair when a startup-blocking %s legacy session store remains",
    async (layout) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath =
          layout === "configured"
            ? state.path("custom", "sessions.json")
            : state.statePath("agents", "main", "sessions", "sessions.json");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, '{"agent:main:legacy":');
        mocks.config.mockReturnValue(
          layout === "configured" ? { session: { store: storePath } } : {},
        );
        const before = fs.readFileSync(storePath);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );

        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Legacy session store requires migration"),
        );
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(fs.readFileSync(storePath)).toEqual(before);
      });
    },
  );

  it("fails public repair after the Gateway lock skips session import", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = await state.writeText(
        "agents/main/sessions/sessions.json",
        JSON.stringify({
          "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 },
        }),
      );
      const before = fs.readFileSync(storePath);
      const gatewayLock = await acquireGatewayLock({
        allowInTests: true,
        env: state.env,
        port: 19566,
      });
      if (!gatewayLock) {
        throw new Error("expected Gateway lock");
      }
      mocks.runContributions.mockImplementation(async (ctx) => {
        await noteSessionTranscriptHealth({
          cfg: ctx.cfg,
          env: state.env,
          shouldRepair: true,
        });
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      try {
        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );
      } finally {
        await gatewayLock.release();
      }

      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Legacy session store requires migration"),
      );
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      expect(fs.readFileSync(storePath)).toEqual(before);
    });
  });

  it.each(["configured", "sandbox"] as const)(
    "refuses incomplete %s workspace cleanup with current SQLite schemas, then completes on retry",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const workspaceDir = state.statePath("secondary-workspace");
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              primary: { workspace: state.workspaceDir },
              secondary:
                kind === "configured"
                  ? { workspace: workspaceDir }
                  : {
                      workspace: state.path("secondary-host-workspace"),
                      sandbox: {
                        mode: "all",
                        scope: "shared",
                        workspaceRoot: workspaceDir,
                        workspaceAccess: "none",
                      },
                    },
            },
          },
        };
        mocks.config.mockReturnValue(cfg);
        const sourcePath = await state.writeJson(
          "secondary-workspace/openclaw-workspace-state.json",
          {
            version: 1,
            setupCompletedAt: "2026-07-15T00:00:00.000Z",
          },
        );
        materializeSharedStateDatabase(state.env);
        openOpenClawStateDatabase({ env: state.env });
        let failCleanup = true;
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
            ...(failCleanup
              ? {
                  removeSource: () => {
                    throw new Error("simulated unlink failure");
                  },
                }
              : {}),
          });
          ctx.runtime.log(result.warnings.join("\n"));
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );
        expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("legacy cleanup failed"));
        expect((await readWorkspaceStateSnapshot(workspaceDir)).setup.setupCompletedAt).toBe(
          "2026-07-15T00:00:00.000Z",
        );
        expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
        expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir })).toThrow(
          /requires migration/,
        );
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringMatching(/workspace.*requires migration/),
        );
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");

        failCleanup = false;
        runtime.exit.mockClear();
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
        expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir })).not.toThrow();
      });
    },
  );

  it.each(["missing-state", "missing-agent", "current"])(
    "accepts %s databases without creating or repairing them",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        let agentPath: string | undefined;
        if (scenario !== "missing-state") {
          materializeSharedStateDatabase(state.env);
          agentPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
          closeOpenClawAgentDatabasesForTest();
          if (scenario === "missing-agent") {
            fs.unlinkSync(agentPath);
          }
        }
        const before =
          agentPath && fs.existsSync(agentPath) ? fs.readFileSync(agentPath) : undefined;
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.exit).not.toHaveBeenCalled();
        if (agentPath && before) {
          expect(fs.readFileSync(agentPath)).toEqual(before);
        } else {
          expect(fs.existsSync(agentPath ?? resolveOpenClawStateSqlitePath(state.env))).toBe(false);
        }
      });
    },
  );
});
