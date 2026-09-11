import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  restart: vi.fn(),
  health: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.state,
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: async ({ root }: { root: string }) => ({
    kind: "owned",
    root,
    fingerprint: "original",
    refreshDefinition: false,
  }),
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restart,
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.health,
}));
afterEach(() => vi.restoreAllMocks());

it.each([
  "healthy",
  "lost at health",
  "refusal",
  "missing executor",
  "ordinary",
  "revoked at service",
  "revoked at health",
  "release refused",
] as const)(
  "recovers under the original executor without converting authority loss to health: %s",
  async (scenario) =>
    withTestDir({ prefix: "native-recovery-owner-" }, async (dir) => {
      vi.clearAllMocks();
      const root = await fs.realpath(dir);
      const control = path.join(root, "leases");
      await fs.mkdir(control);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const env = { HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, "state") };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env };
      const opts = {
        jsonMode: true,
        updateRun: scenario === "ordinary" ? undefined : run,
        preManagedServiceStop: {
          inspected: true,
          runtimeInspected: true,
          running: true,
          stopped: true,
          serviceEnv: env,
          serviceUpdateVerdict: {
            kind: "owned" as const,
            root,
            fingerprint: "original",
            refreshDefinition: false,
          },
        },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      } satisfies Parameters<typeof maybeRestartServiceAfterFailedMutableUpdate>[0];
      const changeRow = () => {
        const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
        try {
          if (scenario === "release refused") {
            db.exec(
              "CREATE TRIGGER refuse_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(ABORT, 'test release refused'); END",
            );
          } else {
            const changed = db
              .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
              .run("replacement", root);
            expect(changed.changes).toBe(1);
          }
        } finally {
          db.close();
        }
      };
      mocks.state.mockImplementation(async () => {
        if (scenario === "revoked at service") {
          changeRow();
        }
        return { env, command: { environment: env } };
      });
      mocks.health.mockImplementation(async () => {
        if (scenario === "revoked at health" || scenario === "release refused") {
          changeRow();
        }
        if (scenario === "lost at health") {
          run.executorFence = undefined;
        }
        return { healthy: true, runtime: { status: "running" } };
      });
      mocks.restart.mockImplementation(async (params) => {
        expect(params.opts.run).toBe(opts.updateRun);
        if (opts.updateRun) {
          params.assertCurrent();
        }
        if (scenario === "refusal") {
          throw new UpdateCommandRecoveryPendingError("receiver refused");
        }
        return "accepted";
      });
      const work = withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(root);
        if (scenario !== "missing executor") {
          run.executorFence = fence;
        }
        const recovery = maybeRestartServiceAfterFailedMutableUpdate(opts);
        if (scenario === "healthy" || scenario === "ordinary" || scenario === "release refused") {
          await expect(recovery).resolves.toBe("healthy");
          expect(mocks.restart).toHaveBeenCalledOnce();
        } else {
          await expect(recovery).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
          if (scenario === "missing executor") {
            expect(mocks.state).not.toHaveBeenCalled();
            expect(mocks.restart).not.toHaveBeenCalled();
          }
        }
      });
      if (scenario.startsWith("revoked") || scenario === "release refused") {
        if (scenario === "release refused") {
          await expect(work).rejects.toThrow("test release refused");
        } else {
          await expect(work).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
        }
        const row = createManagedHandoffLeaseStore().read(root);
        expect(row.kind).toBe("current");
        if (scenario.startsWith("revoked")) {
          expect(row.kind === "current" && row.lease.owner).toBe("replacement");
        }
        if (scenario === "revoked at service") {
          expect(mocks.restart).not.toHaveBeenCalled();
          expect(mocks.health).not.toHaveBeenCalled();
        }
      } else {
        await work;
        expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
      }
      // Helper recovery and executor settlement never publish a terminal ledger fact.
      expect(getUpdateRun(runId, { env })?.status).toBe("running");
    }),
);
