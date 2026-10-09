import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  await flushLogger();
  setLoggerOverride(null);
  resetLogger();
  vi.unstubAllEnvs();
});

it("reports failed preparation without retaining pending agents as startup migration warnings", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const logPath = path.join(home, "startup.log");
    const config = {
      gateway: { mode: "local" },
      agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
      plugins: { enabled: false },
      meta: { migrations: { webhookListeners: true } },
    };
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
    await fs.writeFile(logPath, "");
    vi.stubEnv("OPENCLAW_LOG_LEVEL", "warn");
    setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
    const paths = ["main", "worker"].map((agentId) => openOpenClawAgentDatabase({ agentId }).path);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    for (const pathname of paths) {
      const db = new DatabaseSync(pathname);
      try {
        // A missing canonical index requests preparation without waiting for a timeout.
        db.exec("DROP INDEX idx_agent_session_nodes_active");
      } finally {
        db.close();
      }
    }

    await withAgentDatabaseStartupAdmission(async (admission) => {
      const owner = admission.adopt();
      const failWorker = createDeferredCore();
      const credential = "sk-" + "syntheticfixture".repeat(4);
      try {
        const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(ready.snapshot.valid).toBe(true);
        for (const agentId of ["main", "worker"]) {
          expect(readAgentDatabaseAdmissionRefusal(agentId)?.code).toBe(
            "agent-database-inspection-pending",
          );
        }
        expect.soft(readStartupMigrationWarning()).toBeUndefined();
        expect.soft(readStartupMigrationWarning(false)).toBeUndefined();
        await flushLogger();
        expect.soft(await fs.readFile(logPath, "utf8")).not.toContain("Startup migration warnings");

        const mainPreparation = admission.waitForAgentPreparation("main");
        const allPreparation = admission.pendingPreparation;
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async ({ agentId, env, assertCurrent }) => {
            await withOpenClawAgentDatabaseAsync({ agentId, env }, () => {}, assertCurrent);
          },
          migrateAgent: async ({ agentId }) => {
            if (agentId === "worker") {
              await failWorker.promise;
              throw new Error(
                `Synthetic agent preparation failure ${credential} \u001b[31m${"details ".repeat(1000)}`,
              );
            }
          },
          publishAgent: async () => {},
        });
        await mainPreparation;
        expect(readAgentDatabaseAdmissionRefusal("main")).toBeUndefined();
        expect.soft(readStartupMigrationWarning()).toBeUndefined();
        await flushLogger();
        expect.soft(await fs.readFile(logPath, "utf8")).not.toContain("Startup migration warnings");

        failWorker.resolve();
        await allPreparation;
        expect(readAgentDatabaseAdmissionRefusal("worker")?.code).toBe(
          "agent-database-inspection-failed",
        );
        const failure = readStartupMigrationWarning();
        expect.soft(failure).toContain("Synthetic agent preparation failure");
        expect(failure).toContain('Run "openclaw doctor --fix" against the same state/config');
        expect.soft(failure).not.toContain("has not completed startup inspection");
        expect(failure).not.toContain(credential);
        expect(failure).not.toContain("\u001b");
        expect(failure?.length).toBeLessThan(2200);
        await flushLogger();
        const failureLog = (await fs.readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line): { message?: string; "1"?: { repairHint?: string } } => JSON.parse(line))
          .find((record) => record.message === "agent database remains degraded");
        expect(failureLog?.["1"]?.repairHint).toContain("openclaw doctor --fix");

        recordStartupMigrationWarnings(["Retained session history requires repair"]);
        expect(readStartupMigrationWarning()).toContain("Retained session history requires repair");
        expect(readStartupMigrationWarning()).toContain("Synthetic agent preparation failure");
        expect(readStartupMigrationWarning(false)).toBe(
          'Startup migrations need attention. Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
        );
      } finally {
        failWorker.resolve();
        await owner.stop();
      }
    });
  });
});
