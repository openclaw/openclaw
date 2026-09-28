// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { collectSecurityWarnings } from "../commands/doctor-security.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ExecApprovalsMigrationRequiredError } from "../infra/exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "../infra/exec-approvals-sqlite.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import { tryAcquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "../infra/state-migrations.exec-approvals.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
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

const { mocks } = await import("./doctor-health.test-support.js");

type DoctorManagedRepairOutcome =
  | "ready"
  | "clean-repair"
  | "clean-inspect"
  | "clean-force-repair"
  | "clean-force-inspect"
  | "update-no-restart"
  | "update-no-restart-stopped"
  | "update-parent-stopped"
  | "update-legacy"
  | "repair-failed"
  | "store-close-failed"
  | "config-refused"
  | "workspace-cleanup-failed"
  | "approvals-malformed"
  | "approvals-conflicting"
  | "approvals-migrated"
  | "restart-unhealthy"
  | "ancestor-blocked";

export function registerDoctorManagedRepairTests(outcomes: readonly DoctorManagedRepairOutcome[]) {
  const { materializeSharedStateDatabase, openHistoricalAgentDatabase } = useDoctorHealthFixture();
  it.each(outcomes)(
    "coordinates the matching managed writer through multi-agent repair: %s",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        // These cases own managed agent repair after shared-state initialization.
        materializeSharedStateDatabase(state.env);
        const clean = outcome.startsWith("clean-") || outcome.startsWith("update-");
        const inspectionOnly = outcome === "clean-inspect" || outcome === "clean-force-inspect";
        const force = outcome.startsWith("clean-force-");
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              main: { workspace: state.workspaceDir },
              research: { workspace: state.path("research") },
            },
          },
        };
        await state.writeConfig(
          clean
            ? cfg
            : {
                agents: {
                  list: [
                    { id: "main", workspace: state.workspaceDir },
                    { id: "research", workspace: state.path("research") },
                  ],
                },
              },
        );
        mocks.config.mockReturnValue(cfg);
        const configBefore = fs.readFileSync(state.configPath);
        const approvalsCase = outcome.startsWith("approvals-");
        const approvalsBlocked = approvalsCase && outcome !== "approvals-migrated";
        const approvalsPath = state.statePath("exec-approvals.json");
        const canonicalApprovals = {
          version: 1 as const,
          defaults: { security: "deny" as const },
          agents: {},
        };
        const approvalsBefore =
          outcome === "approvals-malformed"
            ? '{"version":1,"agents":'
            : serializeExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });
        if (approvalsCase) {
          fs.writeFileSync(approvalsPath, approvalsBefore);
          if (outcome === "approvals-conflicting") {
            writeExecApprovalsConfigRow({
              db: openOpenClawStateDatabase({ env: state.env }).db,
              file: canonicalApprovals,
            });
          }
        }
        if (outcome === "workspace-cleanup-failed") {
          fs.mkdirSync(state.workspaceDir, { recursive: true });
          fs.writeFileSync(
            path.join(state.workspaceDir, "openclaw-workspace-state.json"),
            JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
          );
        }
        const open = clean ? openOpenClawAgentDatabase : openHistoricalAgentDatabase;
        const initial = open({ agentId: "main", env: state.env });
        const secondary = open({ agentId: "research", env: state.env });
        if (!clean) {
          secondary.db.close();
          initial.db.close();
        }
        closeOpenClawAgentDatabasesForTest();
        const leaseId = claimOpenClawAgentDatabaseLease({
          agentId: "main",
          path: initial.path,
          env: state.env,
        });
        const agentBefore = fs.readFileSync(initial.path);
        const events: string[] = [];
        let running = outcome !== "update-no-restart-stopped";
        const pid = outcome === "ancestor-blocked" ? process.pid : 4200;
        mocks.resident.mockImplementation(() => (running ? { pid } : undefined));
        const packageRoot = process.cwd();
        mocks.packageRoot.mockReturnValue(packageRoot);
        const command = {
          programArguments: [process.execPath, path.join(packageRoot, "openclaw.mjs"), "gateway"],
          environment: {
            OPENCLAW_STATE_DIR: state.stateDir,
            OPENCLAW_CONFIG_PATH: state.configPath,
          },
        };
        const stop = vi.fn(async () => {
          events.push("stop");
          running = false;
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        });
        const restart = vi.fn(async () => {
          events.push("restart");
          if (outcome === "ready") {
            expect(() =>
              assertNoOpenClawAgentDatabaseLeases("main", { env: state.env }),
            ).not.toThrow();
            expect(() =>
              assertNoOpenClawAgentDatabaseLeases("research", { env: state.env }),
            ).not.toThrow();
          }
          const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
          expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          const research = openOpenClawAgentDatabase({ agentId: "research", env: state.env });
          expect(research.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          running = true;
          return { outcome: "completed" as const };
        });
        mocks.service.mockReturnValue({
          readCommand: async () => command,
          readRuntime: async () => ({
            status: running ? "running" : "stopped",
            systemd: { managerUid: process.getuid?.() ?? 2001 },
            ...(running ? { pid } : {}),
          }),
          readLoadState: async () => ({ status: running ? "loaded" : "not-loaded" }),
          isLoaded: async () => running,
          isEnabled: async () => running,
          stop,
          restart,
        });
        mocks.runContributions.mockImplementation(async (ctx) => {
          events.push("repair");
          expect(ctx.gatewayMaintenanceActive).toBe(!inspectionOnly);
          if (clean) {
            return;
          }
          if (outcome === "repair-failed") {
            throw new Error("synthetic migration failure");
          }
          if (outcome === "config-refused") {
            ctx.configWriteRefusal = "validation";
            return;
          }
          const result = await migrateLegacyMediaPersistence();
          expect(result.warnings).toEqual([]);
          if (approvalsCase) {
            const approvals = await migrateLegacyExecApprovals({
              stateDir: state.stateDir,
              env: state.env,
              detected: detectLegacyExecApprovals({
                stateDir: state.stateDir,
                doctorOnlyStateMigrations: true,
              }),
            });
            expect(approvals.warnings.length > 0).toBe(approvalsBlocked);
            await collectSecurityWarnings(ctx.cfg, state.env);
          }
          if (outcome === "ready" || outcome === "store-close-failed") {
            // Later diagnostics reopen runtime handles after the migration closes its own.
            const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
            openOpenClawAgentDatabase({ agentId: "research", env: state.env });
            if (outcome === "store-close-failed") {
              vi.spyOn(reopened.db, "close").mockImplementationOnce(() => {
                throw new Error("synthetic database close failure");
              });
            }
          }
          if (outcome === "workspace-cleanup-failed") {
            const migration = await migrateLegacyWorkspaceState({
              stateDir: state.stateDir,
              env: state.env,
              detected: await detectLegacyWorkspaceState({
                cfg: ctx.cfg,
                stateDir: state.stateDir,
                env: state.env,
                homedir: () => state.home,
                doctorOnlyStateMigrations: true,
              }),
              removeSource: () => {
                throw new Error("simulated unlink failure");
              },
            });
            expect(migration.warnings.join("\n")).toContain("legacy cleanup failed");
            expect(
              (await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt,
            ).toBe("2026-07-15T00:00:00.000Z");
          }
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const expectProcessOwnerReleased = () => {
          const owner = tryAcquireGatewayStateOwner(resolveOpenClawStateSqlitePath(state.env));
          expect(owner).not.toBeNull();
          owner?.release();
        };
        if (outcome === "config-refused") {
          runtime.exit.mockImplementation(expectProcessOwnerReleased);
        }
        try {
          const modernUpdate = outcome.startsWith("update-") && outcome !== "update-legacy";
          if (modernUpdate) {
            if (!running) {
              releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
            }
            const parentRestarts = outcome === "update-parent-stopped";
            const prepared = await maybeStopManagedServiceBeforeMutableUpdate({
              updateInstallKind: "package",
              root: packageRoot,
              shouldRestart: parentRestarts,
              jsonMode: true,
            });
            expect(prepared.stopped).toBe(parentRestarts);
            expect(running).toBe(outcome === "update-no-restart");
            expect(events).toEqual(parentRestarts ? ["stop"] : []);
            events.length = 0;
            stop.mockClear();
            // Published parents grant repair; the candidate still owns maintenance inspection.
            for (const [key, value] of Object.entries(
              buildUpdateDoctorEnv({
                allowGatewayServiceRepair: true,
                allowGatewayActivation: parentRestarts,
              }),
            )) {
              vi.stubEnv(key, value);
            }
          } else if (outcome === "update-legacy") {
            vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
          }
          mocks.restartedHealthy = outcome !== "restart-unhealthy";
          const run = runDoctorHealthFlow(runtime, {
            ...(inspectionOnly ? {} : { repair: true }),
            force,
            nonInteractive: true,
          });
          if (outcome === "update-no-restart") {
            await expect(run).rejects.toThrow("update parent");
            expect(events).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
            return;
          }
          if (outcome === "ancestor-blocked") {
            await expect(run).rejects.toThrow("openclaw doctor --fix");
            await expect(run).rejects.toThrow("from a shell outside the gateway service");
            await expect(run).rejects.not.toThrow("openclaw update");
            expect(events).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
            return;
          }
          if (outcome === "repair-failed") {
            await expect(run).rejects.toThrow("synthetic migration failure");
          } else if (outcome === "config-refused") {
            await expect(run).rejects.toThrow("persisted repair state is not ready");
            expect(runtime.exit).toHaveBeenCalledWith(1);
          } else if (outcome === "store-close-failed") {
            await expect(run).rejects.toThrow("synthetic database close failure");
            expectProcessOwnerReleased();
          } else if (outcome === "workspace-cleanup-failed") {
            await expect(run).rejects.toThrow(/workspace.*requires migration/);
          } else if (approvalsBlocked) {
            await expect(run).rejects.toThrow(ExecApprovalsMigrationRequiredError);
            expectProcessOwnerReleased();
          } else if (outcome === "restart-unhealthy") {
            await expect(run).rejects.toThrow("managed Gateway did not become ready");
          } else {
            await run;
          }
          if (modernUpdate) {
            expect(events.filter((event) => event !== "repair")).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
            return;
          }
          const shouldRestart =
            outcome === "ready" ||
            outcome === "restart-unhealthy" ||
            outcome === "clean-repair" ||
            outcome === "clean-force-repair" ||
            outcome === "approvals-migrated" ||
            outcome === "update-legacy";
          expect(events).toEqual(
            inspectionOnly
              ? ["repair"]
              : shouldRestart
                ? ["stop", "repair", "restart"]
                : ["stop", "repair"],
          );
          expect(stop).toHaveBeenCalledTimes(inspectionOnly ? 0 : 1);
          expect(restart).toHaveBeenCalledTimes(shouldRestart ? 1 : 0);
          if (shouldRestart) {
            expect(restart).toHaveBeenCalledWith(
              expect.objectContaining({ preserveDefinition: true }),
            );
          }
          if (clean) {
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
          }
          if (approvalsCase) {
            if (approvalsBlocked) {
              expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsBefore);
              expect(() => loadExecApprovalsReadOnly()).toThrow(
                ExecApprovalsMigrationRequiredError,
              );
            } else {
              expect(fs.existsSync(approvalsPath)).toBe(false);
              expect(loadExecApprovalsReadOnly().defaults?.security).toBe("full");
            }
            if (outcome === "approvals-conflicting") {
              expect(
                readExecApprovalsConfigRow(openOpenClawStateDatabase({ env: state.env }).db)
                  ?.raw_json,
              ).toBe(serializeExecApprovals(canonicalApprovals));
            }
          }
          if (outcome === "ready" || clean || outcome === "approvals-migrated") {
            expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          } else {
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          }
        } finally {
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        }
      });
    },
  );
}
