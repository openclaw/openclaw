// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import * as doctorConfigFlow from "../commands/doctor-config-flow.js";
import { collectSecurityWarnings } from "../commands/doctor-security.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ServiceInspectionError } from "../daemon/service-inspection-error.js";
import { sha256Hex } from "../infra/crypto-digest.js";
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
import * as mediaArchiveTransform from "../infra/state-migrations.media-persistence-transform.js";
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
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

type DoctorManagedRepairOutcome =
  | "interactive-ready"
  | "interactive-declined"
  | "ready"
  | "archive-verification"
  | "clean-stopped-repair"
  | "clean-stopped-probe-timeout"
  | "clean-stopped-owner-unknown"
  | "clean-stopped-manager-unknown"
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
        const interactive = outcome.startsWith("interactive-");
        const declined = outcome === "interactive-declined";
        const clean = declined || outcome.startsWith("clean-") || outcome.startsWith("update-");
        const archiveVerification = outcome === "archive-verification";
        const current = clean || archiveVerification;
        const inspectionOnly = outcome === "clean-force-inspect";
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
          current
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
        const open = current ? openOpenClawAgentDatabase : openHistoricalAgentDatabase;
        const initial = open({ agentId: "main", env: state.env });
        const secondary = open({ agentId: "research", env: state.env });
        if (archiveVerification) {
          const bytes = Buffer.from(
            '{"type":"message","message":{"role":"user","content":"retained history"}}\n',
          );
          const archiveName = "retained.jsonl.deleted.1234";
          ensureSessionTranscriptArchiveSchema(initial.db);
          initial.db
            .prepare(
              `INSERT INTO session_transcript_archives
               (session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
                archive_name,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              "retained",
              "retained-generation",
              "agent:main:retained",
              "deleted",
              "identity",
              bytes,
              sha256Hex(bytes),
              archiveName,
              1234,
              1234,
            );
          const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
            agentId: "main",
            path: initial.path,
          });
          fs.mkdirSync(archiveDirectory, { recursive: true });
          fs.writeFileSync(path.join(archiveDirectory, archiveName), bytes);
        }
        if (!current) {
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
        const initiallyStopped =
          outcome.startsWith("clean-stopped-") || outcome === "update-no-restart-stopped";
        const inconclusiveActivation =
          outcome.startsWith("clean-stopped-") && outcome !== "clean-stopped-repair";
        const platform =
          outcome === "clean-stopped-manager-unknown"
            ? vi.spyOn(process, "platform", "get").mockReturnValue("linux")
            : undefined;
        let running = !initiallyStopped;
        if (initiallyStopped) {
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        }
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
          if (outcome === "ready" || outcome === "interactive-ready") {
            for (const agentId of ["main", "research"]) {
              expect(() =>
                assertNoOpenClawAgentDatabaseLeases(agentId, { env: state.env }),
              ).not.toThrow();
            }
          }
          // A refusal before schema convergence restores the captured service,
          // whose prior runtime already served this state. Other cases prove that
          // the candidate can reopen every migrated database before health passes.
          if (outcome !== "repair-failed" && outcome !== "config-refused") {
            for (const agentId of ["main", "research"]) {
              const reopened = openOpenClawAgentDatabase({ agentId, env: state.env });
              expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
                OPENCLAW_AGENT_SCHEMA_VERSION,
              );
            }
          }
          // An unhealthy restart leaves the service down; a running service with
          // unverified readiness is a warning, covered by the readiness tests.
          running = outcome !== "restart-unhealthy";
          return { outcome: "completed" as const };
        });
        const start = vi.fn(async () => {
          events.push("start");
          running = true;
        });
        mocks.service.mockReturnValue({
          readCommand: async () => {
            if (events.includes("repair")) {
              if (outcome === "clean-stopped-probe-timeout") {
                throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
              }
              if (outcome === "clean-stopped-owner-unknown") {
                return null;
              }
            }
            return command;
          },
          readRuntime: async () => ({
            status: running ? "running" : "stopped",
            systemd:
              outcome === "clean-stopped-manager-unknown" && events.includes("repair")
                ? undefined
                : { managerUid: process.getuid?.() ?? 2001 },
            ...(running ? { pid } : {}),
          }),
          readLoadState: async () => ({ status: running ? "loaded" : "not-loaded" }),
          isLoaded: async () => running,
          isEnabled: async () => running,
          stop,
          start,
          restart,
        });
        mocks.runContributions.mockImplementation(async (ctx) => {
          events.push("repair");
          expect(ctx.gatewayMaintenanceActive).toBe(!inspectionOnly && !declined);
          if (interactive) {
            expect(ctx.prompter.shouldRepair).toBe(false);
            expect(running).toBe(declined);
            expect(
              await ctx.prompter.confirmAutoFix({
                message: "Apply a selected repair?",
                initialValue: true,
              }),
            ).toBe(false);
          }
          if (clean || archiveVerification) {
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
          if (
            outcome === "ready" ||
            outcome === "interactive-ready" ||
            outcome === "store-close-failed"
          ) {
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
        if (declined) {
          mocks.lint.mockImplementation(async (diagnosticRuntime) => {
            expect(running).toBe(true);
            expect(events).toEqual([]);
            diagnosticRuntime.log("Synthetic diagnostic finding; repairs remain pending.");
            return 1;
          });
        }
        const archiveTransform = archiveVerification
          ? vi.spyOn(mediaArchiveTransform, "transformMediaArchiveContent")
          : undefined;
        const loadConfig = doctorConfigFlow.loadAndMaybeMigrateDoctorConfig;
        const archiveRepair = archiveVerification
          ? vi
              .spyOn(doctorConfigFlow, "loadAndMaybeMigrateDoctorConfig")
              .mockImplementation(async (params) => {
                expect(running).toBe(false);
                expect(
                  await migrateLegacyMediaPersistence({
                    preparedDiscovery: params.agentDatabaseMigrationDiscovery,
                  }),
                ).toEqual({ changes: [], warnings: [] });
                return await loadConfig(params);
              })
          : undefined;
        const expectProcessOwnerReleased = () => {
          const owner = tryAcquireGatewayStateOwner(resolveOpenClawStateSqlitePath(state.env));
          expect(owner).not.toBeNull();
          owner?.release();
        };
        if (outcome === "config-refused") {
          runtime.exit.mockImplementation(expectProcessOwnerReleased);
        }
        const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
        if (interactive) {
          Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
          mocks.confirm.mockReset().mockResolvedValue(false).mockResolvedValueOnce(!declined);
        }
        try {
          const modernUpdate = outcome.startsWith("update-") && outcome !== "update-legacy";
          if (modernUpdate) {
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
            ...(interactive || inspectionOnly ? {} : { repair: true }),
            force,
            ...(interactive ? {} : { nonInteractive: true }),
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
          if (inconclusiveActivation) {
            await run;
            expect(events).toEqual(["repair"]);
            expect(running).toBe(false);
            expect(start).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(mocks.waitForGatewayHealthyRestart).not.toHaveBeenCalled();
            expect(runtime.log).toHaveBeenCalledWith(
              expect.stringMatching(
                /Gateway activation skipped.*inconclusive.*gateway status --deep/s,
              ),
            );
            expectProcessOwnerReleased();
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
            await run;
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
          if (declined) {
            expect(events).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(runtime.log).toHaveBeenCalledWith(
              "Synthetic diagnostic finding; repairs remain pending.",
            );
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(mocks.lint).toHaveBeenCalledBefore(runtime.exit);
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
            return;
          }
          const shouldRestart =
            outcome === "interactive-ready" ||
            outcome === "ready" ||
            archiveVerification ||
            outcome === "repair-failed" ||
            outcome === "store-close-failed" ||
            outcome === "config-refused" ||
            outcome === "workspace-cleanup-failed" ||
            outcome === "restart-unhealthy" ||
            outcome === "clean-stopped-repair" ||
            outcome === "clean-force-repair" ||
            approvalsBlocked ||
            outcome === "approvals-migrated" ||
            outcome === "update-legacy";
          expect(events).toEqual(
            inspectionOnly
              ? ["repair"]
              : shouldRestart
                ? [...(initiallyStopped ? [] : ["stop"]), "repair", "restart"]
                : ["stop", "repair"],
          );
          if (shouldRestart) {
            expect(restart).toHaveBeenCalledWith(
              expect.objectContaining({ preserveDefinition: true }),
            );
            expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledWith(
              expect.objectContaining({ requireRunningService: true }),
            );
          }
          if (clean) {
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
          }
          if (archiveTransform) {
            expect(archiveTransform).toHaveBeenCalledTimes(1);
            expect(archiveTransform.mock.invocationCallOrder[0]).toBeLessThan(
              stop.mock.invocationCallOrder[0]!,
            );
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
          if (
            outcome === "ready" ||
            outcome === "interactive-ready" ||
            clean ||
            archiveVerification ||
            outcome === "approvals-migrated"
          ) {
            expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          } else {
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          }
        } finally {
          if (interactive) {
            if (originalTty) {
              Object.defineProperty(process.stdin, "isTTY", originalTty);
            } else {
              Reflect.deleteProperty(process.stdin, "isTTY");
            }
            mocks.confirm.mockReset().mockResolvedValue(true);
          }
          archiveRepair?.mockRestore();
          archiveTransform?.mockRestore();
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
          platform?.mockRestore();
        }
      });
    },
  );
}
