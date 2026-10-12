// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
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
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const support = await import("./doctor-health.test-support.js");
const { mocks, registerDoctorConfigReceiptTests, postInstallAdvisory } = support;

describe("runDoctorHealthFlow", () => {
  const { openHistoricalAgentDatabase } = useDoctorHealthFixture();

  it.each(
    support.doctorServiceInspectionCases.filter(
      ({ kind, updateParent }) =>
        updateParent &&
        ["unresolved-unknown", "windows-queued", "windows-startup-unknown"].includes(kind),
    ),
  )("repairs only with settled service authority: $kind", async ({ kind }) => {
    for (const [key, value] of Object.entries(
      buildUpdateDoctorEnv({ allowGatewayServiceRepair: true, allowGatewayActivation: false }),
    )) {
      vi.stubEnv(key, value);
    }
    const windows = kind.startsWith("windows");
    mocks.servicePlatform = windows ? "win32" : undefined;
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const resultPath = state.path("doctor-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
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
      const ownerPath = resolveGatewayStateOwnerPath(databasePath);
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(fs.existsSync(ownerPath)).toBe(false);
      const foreignRoot = state.path("foreign-install");
      if (windows) {
        fs.mkdirSync(foreignRoot);
        fs.writeFileSync(path.join(foreignRoot, "package.json"), '{"name":"openclaw"}');
      }
      const stop = vi.fn();
      const restart = vi.fn();
      mocks.packageRoot.mockReturnValue(process.cwd());
      mocks.config.mockClear().mockReturnValue(cfg);
      mocks.service.mockReturnValue({
        readCommand: async () => ({
          ...(windows ? { sourcePath: state.path("foreign-state", "gateway.cmd") } : {}),
          programArguments: [
            process.execPath,
            windows ? path.join(foreignRoot, "openclaw.mjs") : "operator-wrapper",
            "gateway",
          ],
          environment: {
            OPENCLAW_STATE_DIR: windows ? state.path("foreign-state") : state.stateDir,
            OPENCLAW_CONFIG_PATH: windows ? state.path("foreign.json") : state.configPath,
          },
        }),
        readRuntime: async () => ({
          status: windows ? "stopped" : "unknown",
          systemd: { managerUid: process.getuid?.() ?? 2001 },
        }),
        isLoaded: async () => windows,
        isEnabled: async () => true,
        stop,
        restart,
      });
      mocks.taskDefinitelyStopped.mockReturnValue(!windows);
      if (kind === "windows-startup-unknown") {
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
      if (windows) {
        await expect(run).rejects.toThrow("Doctor could not enter maintenance");
        await expect(run).rejects.toThrow("gateway status --deep");
        await expect(run).rejects.toThrow("openclaw doctor --fix");
        await expect(run).rejects.not.toThrow(/--no-restart|before the update/);
        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(fs.existsSync(ownerPath)).toBe(false);
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(mocks.taskDefinitelyStopped).toHaveBeenCalled();
        if (kind === "windows-startup-unknown") {
          expect(mocks.startupFallbackRuntime).toHaveBeenCalled();
        }
      } else {
        await run;
        expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt).toBe(
          completedAt,
        );
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        const action = "Restart the Gateway you launched manually after the update.";
        expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(action));
        expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
          resultPath,
          result: expect.objectContaining({
            status: "ok",
            warnings: expect.arrayContaining([expect.stringContaining(action)]),
          }),
        });
      }
      expect(stop).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
    });
  });

  it.each([true])(
    "leaves a split-root Bun Gateway running before Doctor repair (update=%s)",
    async (update) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update ? "1" : undefined);
      vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", undefined);
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({});
        const activeRoot = state.path("cli-install");
        const serviceRoot = state.path("bun-install");
        for (const root of [activeRoot, serviceRoot]) {
          fs.mkdirSync(root);
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({ name: "openclaw", version: "2026.9.6" }),
          );
        }
        const command = {
          programArguments: [
            state.path("runtime", "bun"),
            path.join(serviceRoot, "openclaw.mjs"),
            "gateway",
          ],
          environment: {
            OPENCLAW_STATE_DIR: state.stateDir,
            OPENCLAW_CONFIG_PATH: state.configPath,
          },
        };
        let running = true;
        const service = {
          readCommand: async () => command,
          readRuntime: async () => ({
            status: running ? "running" : "stopped",
            ...(running ? { pid: 4200 } : {}),
            systemd: { managerUid: process.getuid?.() ?? 2001 },
          }),
          isLoaded: async () => true,
          stop: vi.fn(async () => {
            running = false;
          }),
          restart: vi.fn(),
          install: vi.fn(),
        };
        mocks.packageRoot.mockReturnValue(activeRoot);
        mocks.service.mockReturnValue(service);
        mocks.resident.mockImplementation(() => (running ? { pid: 4200 } : undefined));
        const configBefore = fs.readFileSync(state.configPath);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        ).rejects.toThrow("different OpenClaw installation");
        expect(service.stop).not.toHaveBeenCalled();
        expect(service.restart).not.toHaveBeenCalled();
        expect(service.install).not.toHaveBeenCalled();
        expect(await service.readRuntime()).toMatchObject({ status: "running", pid: 4200 });
        expect(await service.readCommand()).toEqual(command);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(mocks.runContributions).not.toHaveBeenCalled();
      });
    },
  );

  registerDoctorConfigReceiptTests(runDoctorHealthFlow);

  it.each([{ yes: true }])(
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
});
