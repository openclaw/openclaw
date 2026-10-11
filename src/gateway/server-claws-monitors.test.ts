import { spawn } from "node:child_process";
import { once } from "node:events";
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { upsertClawCronRef } from "../claws/cron.js";
import { buildClawRemovePlan, readClawStatus } from "../claws/lifecycle-state.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import type { ClawMonitorCleanupGateway } from "../claws/monitor-cleanup-contract.js";
import { readPortableHeartbeatState } from "../claws/portable-heartbeat-state.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { clearCronJobActive, markCronJobActive } from "../cron/active-jobs.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.kernel.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import { cronStoreKey } from "../cron/store/key.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import { releaseLocalCronRunReceiptOwnership } from "../cron/store/run-receipt-store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
} from "../cron/store/run-receipt-store.test-support.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as deletionJournal from "../state/agent-deletion-journal.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as stateReader from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { authorizeOperatorScopesForMethod, isGatewayMethodClassified } from "./method-scopes.js";
import {
  useClawMonitorFixture,
  withMonitorDrainClock,
} from "./server-claws-monitors.test-support.js";

const fixture = useClawMonitorFixture();

describe("Claw serving automation cleanup", () => {
  it.each(["default", "session", "foreign-session"] as const)(
    "preserves agent-less work belonging to its %s owner during Claw removal",
    async (ownership) => {
      const current = await fixture(false);
      const config = current.getConfig();
      await current.writeConfig({
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            systemAgent: { agentId: ownership === "session" ? "other" : "worker" },
          },
          entries: {
            ...config.agents?.entries,
            other: { workspace: current.state.path("other-workspace") },
          },
        },
      });
      const job = await current.cron.add({
        name: "Independent agent-less work",
        enabled: false,
        schedule: { kind: "every", everyMs: 86_400_000 },
        payload: { kind: "agentTurn", message: "Retain the selected agent" },
        sessionTarget: "isolated",
        wakeMode: "now",
        ...(ownership === "default"
          ? {}
          : { sessionKey: `agent:${ownership === "session" ? "worker" : "other"}:followup` }),
      });
      expect(job.agentId).toBeUndefined();
      expect(job.owner).toBeUndefined();
      const plan = await current.plan();
      if (ownership === "foreign-session") {
        expect(plan.blockers).toEqual([]);
        const removal = await current.apply(plan);
        expect(removal, JSON.stringify(removal)).toMatchObject({
          status: "complete",
          agentRemoved: true,
        });
      } else {
        expect(plan.blockers).toContainEqual(
          expect.objectContaining({ code: "agent_job_attached" }),
        );
        await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_blocked" });
        await current.withDeletion(async (deletion) => {
          await expect(
            current.gateway.quiesce("worker", deletion.entry.operationId, []),
          ).rejects.toThrow("Independent or changed cron job");
        });
        await expect(
          fs.access(path.join(current.workspaceDir, "SOUL.md")),
        ).resolves.toBeUndefined();
      }
      expect(await current.cron.readJob(job.id)).toBeDefined();
    },
  );

  it("rejects an agent-less job committed after the cancellation inventory was captured", async () => {
    const current = await fixture(false);
    const config = current.getConfig();
    await current.writeConfig({
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          systemAgent: { agentId: "worker" },
        },
      },
    });
    expect(current.getConfig().agents?.defaults?.systemAgent?.agentId).toBe("worker");
    const originalQuiesce = current.cron.quiesceJobs.bind(current.cron);
    const original = (await current.cron.list({ includeDisabled: true }))[0]!;
    const quiesce = vi
      .spyOn(current.cron, "quiesceJobs")
      .mockImplementationOnce(async (...args) => {
        upsertCronJobRow(
          openOpenClawStateDatabase().db,
          cronStoreKey(current.state.statePath("cron", "jobs.json")),
          {
            ...original,
            id: "new-agent-less-work",
            agentId: undefined,
            owner: undefined,
            declarationKey: undefined,
            sessionKey: undefined,
            enabled: false,
          },
          10,
        );
        return originalQuiesce(...args);
      });
    try {
      await current.withDeletion(async (deletion) => {
        await expect(
          current.gateway.quiesce("worker", deletion.entry.operationId, []),
        ).rejects.toThrow("changed before monitor cancellation");
      });
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
    } finally {
      quiesce.mockRestore();
    }
  });

  it.each(["quiesce", "drain"])(
    "retains a configured agent without a Claw install during %s",
    async (phase) => {
      const current = await fixture(false);
      await current.withDeletion(async (deletion) => {
        openOpenClawStateDatabase()
          .db.prepare("DELETE FROM claw_installs WHERE agent_id = ?")
          .run("worker");
        await expect(
          current.invoke({
            phase,
            agentId: "worker",
            operationId: deletion.entry.operationId,
            ...(phase === "quiesce" ? { monitors: await current.gateway.inspect("worker") } : {}),
          }),
        ).rejects.toThrow("configuration changed");
        expect(listAgentEntries(current.getConfig()).some((agent) => agent.id === "worker")).toBe(
          true,
        );
        await expect(
          fs.access(path.join(current.workspaceDir, "SOUL.md")),
        ).resolves.toBeUndefined();
      });
    },
  );

  it("removes orphaned workspace ownership through the serving monitor handler", async () => {
    const current = await fixture(false);
    await current.writeConfig({
      agents: { entries: { main: { workspace: current.state.path("main-workspace") } } },
    });
    openOpenClawStateDatabase()
      .db.prepare("DELETE FROM claw_installs WHERE agent_id = ?")
      .run("worker");
    expect(
      (await readClawStatus("worker", { config: current.getConfig() })).records[0],
    ).toMatchObject({
      orphaned: true,
      agentState: "missing",
    });
    const plan = await current.plan();
    expect(plan.blockers).toEqual([]);
    expect(await current.apply(plan)).toMatchObject({ status: "complete", agentRemoved: false });
    expect(deletionJournal.readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(true);
    expect((await readClawStatus("worker", { config: current.getConfig() })).summary.claws).toBe(0);
    await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).rejects.toThrow();
  });

  it("retains independent job blockers when the serving inspection is unavailable", async () => {
    const current = await fixture(false);
    await current.cron.add({
      agentId: "worker",
      name: "independent operator task",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "Independent task" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
    const plan = await buildClawRemovePlan("worker", {
      config: current.getConfig(),
      monitorGateway: {
        ...current.gateway,
        inspect: async () => {
          throw new Error("Gateway offline");
        },
      },
    });
    expect(plan.blockers).toHaveLength(1);
    const jobs = plan.actions.filter((action) => action.kind === "scheduledJob");
    expect(jobs).toHaveLength(1);
    for (const job of jobs) {
      expect(job).toMatchObject({
        action: "retain",
        blocked: true,
      });
    }
    expect(deletionJournal.readAgentDeletionJournal("worker")).toBeUndefined();
  });

  it("removes recorded Claw schedules with one disposition each", async () => {
    const current = await fixture(false, undefined, true);
    const plan = await current.plan();
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.filter((action) => action.kind === "cronJob")).toHaveLength(1);
    expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toEqual([]);
    expect(await current.apply(plan)).toMatchObject({
      status: "complete",
      cronJobs: [expect.objectContaining({ manifestId: "daily", action: "removed" })],
    });
  });

  it("removes an imported ordinary automation through the serving owner and retains its provisioning receipt", async () => {
    const current = await fixture(false, undefined, false, true);
    const storePath = current.state.statePath("cron", "jobs.json");
    const database = openOpenClawStateDatabase();
    const receipt = readDefaultProactiveJobReceiptInDatabase(database.db, storePath, "worker");
    expect(receipt).toBeDefined();
    const monitors = await current.gateway.inspect("worker");
    expect(monitors).toEqual([]);
    const plan = await current.plan();
    expect(plan.blockers).toEqual([]);
    expect(await current.apply(plan)).toMatchObject({ status: "complete", agentRemoved: true });
    expect(await current.cron.readJob(receipt!.jobId)).toBeUndefined();
    expect(
      (await readPortableHeartbeatState("worker", current.getConfig(), {})).ref,
    ).toBeUndefined();
    expect(readDefaultProactiveJobReceiptInDatabase(database.db, storePath, "worker")).toEqual(
      receipt,
    );
  });

  it.each(["job", "scratch", "scratch-before-cancellation", "released-ref", "receipt"])(
    "refuses to quiesce an imported ordinary automation after its %s changes",
    async (changed) => {
      const current = await fixture(false, undefined, false, true);
      const ref = (await readPortableHeartbeatState("worker", current.getConfig(), {})).ref!;
      const storePath = current.state.statePath("cron", "jobs.json");
      const monitors = await current.gateway.inspect("worker");
      const editScratch = async () => {
        expect(
          (
            await writeCronJobScratch({
              storePath,
              jobId: ref.schedulerJobId!,
              content: "operator-owned scratch",
              expectedRevision: 1,
            })
          ).ok,
        ).toBe(true);
      };
      const originalQuiesce = current.cron.quiesceJobs.bind(current.cron);
      const quiesce =
        changed === "scratch-before-cancellation"
          ? vi.spyOn(current.cron, "quiesceJobs").mockImplementationOnce(async (...args) => {
              await editScratch();
              return await originalQuiesce(...args);
            })
          : undefined;
      if (changed === "job") {
        await current.cron.update(ref.schedulerJobId!, { name: "operator-owned edit" });
      } else if (changed === "scratch") {
        await editScratch();
      } else if (changed === "released-ref") {
        upsertClawCronRef({ ...ref, status: "removed" });
      } else if (changed === "receipt") {
        openOpenClawStateDatabase()
          .db.prepare("DELETE FROM config_machine_state WHERE state_key = ?")
          .run(`automation-default:${cronStoreKey(storePath)}:worker`);
        expect(
          readDefaultProactiveJobReceiptInDatabase(
            openOpenClawStateDatabase().db,
            storePath,
            "worker",
          ),
        ).toBeUndefined();
      }
      try {
        await current.withDeletion(async (deletion) => {
          await expect(
            current.gateway.quiesce("worker", deletion.entry.operationId, monitors),
          ).rejects.toThrow(
            changed === "scratch-before-cancellation"
              ? "changed before monitor cancellation"
              : "Independent or changed cron job",
          );
          expect(await current.cron.readJob(ref.schedulerJobId!)).toBeDefined();
          await expect(
            fs.access(path.join(current.workspaceDir, "SOUL.md")),
          ).resolves.toBeUndefined();
        });
      } finally {
        quiesce?.mockRestore();
      }
    },
  );

  it("requires authenticated administrator scope for the monitor phase method", () => {
    expect(isGatewayMethodClassified("claws.monitors")).toBe(true);
    for (const scopes of [[], ["operator.read"], ["operator.write"]]) {
      expect(authorizeOperatorScopesForMethod("claws.monitors", scopes)).toEqual({
        allowed: false,
        missingScope: "operator.admin",
      });
    }
    expect(authorizeOperatorScopesForMethod("claws.monitors", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it.each(["configPath", "statePath", "cronStorePath"])(
    "refuses a different %s binding",
    async (field) => {
      const current = await fixture(false);
      await expect(
        current.invoke({
          phase: "inspect",
          agentId: "worker",
          binding: {
            ...resolveClawMonitorCleanupBinding(current.state.statePath("cron", "jobs.json")),
            [field]: current.state.path("different-owner"),
          },
        }),
      ).rejects.toThrow("does not serve");
      expect(deletionJournal.readAgentDeletionJournal("worker")).toBeUndefined();
    },
  );

  it.each([
    { boundary: "snapshot", changedOwner: "operation" },
    { boundary: "snapshot", changedOwner: "scheduler" },
    { boundary: "inventory", changedOwner: "operation" },
    { boundary: "inventory", changedOwner: "scheduler" },
  ])(
    "revalidates the $changedOwner owner after awaited $boundary",
    async ({ boundary, changedOwner }) => {
      const current = await fixture(false);
      const database = openOpenClawAgentDatabase({ agentId: "worker" });
      const monitors = await current.gateway.inspect("worker");
      await current.withDeletion(async (deletion) => {
        const replaceOwner = () => {
          if (changedOwner === "operation") {
            beginAgentDeletionJournal({ ...deletion.entry, operationId: "replacement" });
          } else {
            current.replaceCron();
          }
        };
        const originalRead = stateReader.executeExistingOpenClawStateRead;
        const originalList = current.cron.list.bind(current.cron);
        let changed = false;
        const preparation =
          boundary === "snapshot"
            ? vi
                .spyOn(stateReader, "executeExistingOpenClawStateRead")
                .mockImplementation(async (...args) => {
                  const snapshot = await originalRead(...args);
                  if (!changed && args[1].type === "clawMonitorCleanup.snapshot") {
                    changed = true;
                    replaceOwner();
                  }
                  return snapshot;
                })
            : vi.spyOn(current.cron, "list").mockImplementationOnce(async (opts) => {
                const jobs = await originalList(opts);
                replaceOwner();
                return jobs;
              });
        const quiesce = vi.spyOn(current.cron, "quiesceJobs");
        try {
          await expect(
            current.gateway.quiesce("worker", deletion.entry.operationId, monitors),
          ).rejects.toThrow(changedOwner === "operation" ? "deletion fence" : "changing");
          expect(quiesce).not.toHaveBeenCalled();
          expect(database.db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
          await expect(
            fs.access(path.join(current.workspaceDir, "SOUL.md")),
          ).resolves.toBeUndefined();
        } finally {
          preparation.mockRestore();
          quiesce.mockRestore();
        }
      });
    },
  );

  it.each(["runtime", "source"])(
    "refuses a changed %s configuration before cancelling ordinary jobs",
    async (changed) => {
      const current = await fixture(false);
      await current.withDeletion(async (deletion) => {
        const originalList = current.cron.list.bind(current.cron);
        const list = vi.spyOn(current.cron, "list").mockImplementationOnce(async (opts) => {
          const jobs = await originalList(opts);
          if (changed === "runtime") {
            current.getConfig().agents!.entries!.worker!.name = "replacement owner";
          } else {
            setRuntimeConfigSnapshot(current.getConfig(), structuredClone(current.getConfig()));
          }
          return jobs;
        });
        const cancel = vi.spyOn(current.cron, "quiesceJobs");
        try {
          await expect(
            current.gateway.quiesce("worker", deletion.entry.operationId, []),
          ).rejects.toThrow("configuration changed");
          expect(cancel).not.toHaveBeenCalled();
          await expect(
            fs.access(path.join(current.workspaceDir, "SOUL.md")),
          ).resolves.toBeUndefined();
        } finally {
          list.mockRestore();
          cancel.mockRestore();
        }
      });
    },
  );

  it.each([
    { boundary: "poll", read: 1, changed: "operation" },
    { boundary: "acknowledgement", read: 2, changed: "operation" },
    { boundary: "acknowledgement", read: 2, changed: "local activity" },
  ])("revalidates $changed after the $boundary receipt read", async ({ read, changed }) => {
    const current = await fixture(false);
    const database = openOpenClawAgentDatabase({ agentId: "worker" });
    const monitors = await current.gateway.inspect("worker");
    await current.withDeletion(async (deletion) => {
      const originalRead = stateReader.executeExistingOpenClawStateRead;
      let receiptReads = 0;
      let active: ReturnType<typeof markCronJobActive>;
      const reader = vi
        .spyOn(stateReader, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await originalRead(...args);
          if (args[1].type === "cron.activeReceiptOwners" && ++receiptReads === read) {
            if (changed === "operation") {
              beginAgentDeletionJournal({ ...deletion.entry, operationId: "replacement" });
            } else {
              active = markCronJobActive("late-local-run", { agentId: "worker" });
            }
          }
          return result;
        });
      try {
        await expect(
          current.gateway.quiesce("worker", deletion.entry.operationId, monitors),
        ).rejects.toThrow(changed === "operation" ? "deletion fence" : "cleanup state changed");
        expect(receiptReads).toBe(read);
        if (read === 1) {
          expect(database.db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
        }
        await expect(
          fs.access(path.join(current.workspaceDir, "SOUL.md")),
        ).resolves.toBeUndefined();
      } finally {
        reader.mockRestore();
        if (active) {
          clearCronJobActive(active.jobId, active);
        }
      }
    });
  });

  it.each([false, true])(
    "retains files for a foreign receipt after its job row disappears (unverifiable=%s)",
    async (unverifiable) => {
      const current = await fixture(false);
      const monitor = (await current.cron.list({ includeDisabled: true })).find(
        (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
      )!;
      const prepared = prepareCronRunReceiptClaim({
        observed: undefined,
        storePath: current.state.statePath("cron", "jobs.json"),
        job: monitor,
        agentId: "worker",
        startedAtMs: Date.now(),
      });
      const handle = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabaseForTest({
          database: db,
          prepared,
          resolveAgentId: () => "worker",
        }),
      );
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        env: { PATH: process.env.PATH, HOME: current.state.home },
      });
      try {
        await once(holder, "spawn");
        if (!holder.pid) {
          throw new Error("Missing fixture process identity");
        }
        const ownerStartTime = unverifiable ? null : getFileLockProcessStartTime(holder.pid);
        const database = openOpenClawStateDatabase();
        database.db
          .prepare(
            "UPDATE cron_run_receipts SET owner_pid = ?, owner_start_time = ? WHERE receipt_id = ?",
          )
          .run(holder.pid, ownerStartTime, handle.receiptId);
        if (unverifiable) {
          database.db
            .prepare("UPDATE cron_run_receipts SET started_at_ms = ? WHERE receipt_id = ?")
            .run(Date.now() - 24 * 60 * 60_000, handle.receiptId);
        }
        releaseLocalCronRunReceiptOwnership(handle);
        database.db.prepare("DELETE FROM cron_jobs WHERE job_id = ?").run(monitor.id);
        expect(getSuspensionVisibleCronTaskRunCount({ agentId: "worker" })).toBe(0);
        const plan = await current.plan();
        const result = await withMonitorDrainClock(() => current.apply(plan));
        expect(result).toMatchObject({ status: "partial", agentRemoved: false });
        await expect(
          fs.access(path.join(current.workspaceDir, "SOUL.md")),
        ).resolves.toBeUndefined();
        const exit = once(holder, "exit");
        holder.kill("SIGTERM");
        await exit;
        expect(
          database.db
            .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
            .get(handle.receiptId),
        ).toEqual({ status: "running" });
        expect(await current.apply(await current.plan())).toMatchObject({ status: "complete" });
      } finally {
        if (holder.pid && holder.exitCode === null && holder.signalCode === null) {
          const exit = once(holder, "exit");
          holder.kill("SIGTERM");
          await exit;
        }
        releaseLocalCronRunReceiptOwnership(handle);
      }
    },
  );

  it("closes idle databases but waits for an agent still configured through agents.entries", async () => {
    const current = await fixture(false);
    const database = openOpenClawAgentDatabase({ agentId: "worker" });
    const monitors = await current.gateway.inspect("worker");
    await current.withDeletion(async (deletion) => {
      await current.gateway.quiesce("worker", deletion.entry.operationId, monitors);
      expect(() => database.db.prepare("SELECT 1")).toThrow();
      for (const job of await current.cron.list({ includeDisabled: true })) {
        if (job.agentId === "worker") {
          await current.cron.remove(job.id);
        }
      }
      expect(
        (await current.cron.list({ includeDisabled: true })).filter(
          (job) => job.agentId === "worker",
        ),
      ).toEqual([]);
      expect(listAgentEntries(current.getConfig()).map((agent) => agent.id)).toContain("worker");
      await expect(
        withMonitorDrainClock(() => current.gateway.drain("worker", deletion.entry.operationId)),
      ).rejects.toThrow("config convergence is incomplete");
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
    });
    expect(await current.apply(await current.plan())).toMatchObject({ status: "complete" });
  });

  it.each(["config-write", "cron-persistence", "lost-cancellation-response", "reload"])(
    "retains cleanup state after a %s failure and completes a fresh retry",
    async (failure) => {
      const current = await fixture(false);
      const plan = await current.plan();
      const database = openOpenClawStateDatabase();
      if (failure === "cron-persistence") {
        database.db.exec(`CREATE TRIGGER refuse_owned_job_delete
          BEFORE DELETE ON cron_jobs WHEN OLD.agent_id = 'worker'
          BEGIN SELECT RAISE(ABORT, 'synthetic job persistence failure'); END`);
      }
      const renameSync = fsNode.renameSync.bind(fsNode);
      const writeFailure =
        failure === "config-write"
          ? vi.spyOn(fsNode, "renameSync").mockImplementation((...args) => {
              if (args[1] === current.state.configPath) {
                throw new Error("synthetic config persistence failure");
              }
              renameSync(...args);
            })
          : undefined;
      let result: Awaited<ReturnType<typeof current.apply>>;
      try {
        const apply = () =>
          current.apply(plan, {
            monitorGateway: {
              ...current.gateway,
              ...(failure === "lost-cancellation-response"
                ? {
                    quiesce: async (...args: Parameters<ClawMonitorCleanupGateway["quiesce"]>) => {
                      await current.gateway.quiesce(...args);
                      throw new Error("synthetic lost cancellation response");
                    },
                  }
                : {}),
              ...(failure === "reload"
                ? {
                    drain: async (...args: Parameters<ClawMonitorCleanupGateway["drain"]>) => {
                      current.setReloadSettled(false);
                      await current.gateway.drain(...args);
                    },
                  }
                : {}),
            },
          });
        result = failure === "reload" ? await withMonitorDrainClock(apply) : await apply();
      } finally {
        writeFailure?.mockRestore();
        if (failure === "cron-persistence") {
          database.db.exec("DROP TRIGGER refuse_owned_job_delete");
        }
      }
      expect(result).toMatchObject({
        status: "partial",
        agentRemoved: failure === "reload",
        error: {
          code: failure === "cron-persistence" ? "cron_cleanup_failed" : "monitor_cleanup_failed",
        },
      });
      if (failure === "config-write") {
        expect(result.error?.message).toContain("synthetic config persistence failure");
      }
      const firstJournal = deletionJournal.readAgentDeletionJournal("worker");
      expect(firstJournal).toBeDefined();
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      expect(deletionJournal.readAgentDeletionJournal("worker")?.operationId).toBe(
        firstJournal?.operationId,
      );
      current.setReloadSettled(true);
      if (failure === "cron-persistence") {
        expect(
          (await current.cron.list({ includeDisabled: true })).some(
            (job) => job.agentId === "worker",
          ),
        ).toBe(true);
      }
      const retry = await current.plan();
      expect(await current.apply(retry)).toMatchObject({ status: "complete" });
      await expect(
        current.invoke({
          phase: "drain",
          agentId: "worker",
          operationId: firstJournal!.operationId,
        }),
      ).rejects.toThrow("deletion fence");
    },
  );

  it("rejects source drift after preview before creating a deletion fence", async () => {
    const current = await fixture(false, undefined, false, true);
    const plan = await current.plan();
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    upsertCronJobRow(
      openOpenClawStateDatabase().db,
      current.state.statePath("cron", "jobs.json"),
      { ...monitor, name: "changed source" },
      0,
    );
    await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_changed" });
    expect(deletionJournal.readAgentDeletionJournal("worker")).toBeUndefined();
    await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
  });

  it("does not cancel or wait for a surviving agent's ordinary runner", async () => {
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const current = await fixture(false, async ({ abortSignal }) => {
      if (!abortSignal) {
        throw new Error("Missing cancellation signal");
      }
      started.resolve(abortSignal);
      await release.promise;
      return { status: "ok" };
    });
    const added = await current.cron.add({
      agentId: "main",
      name: "surviving ordinary job",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "synthetic held run" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
    const run = current.cron.run(added.id, "force");
    const signal = await started.promise;
    try {
      const plan = await current.plan();
      expect(await current.apply(plan)).toMatchObject({ status: "complete" });
      expect(signal.aborted).toBe(false);
      expect(await current.cron.readJob(added.id)).toBeDefined();
    } finally {
      release.resolve();
      await run;
    }
  });

  it("cancels the owned portable runner and waits for settlement before deleting files", async ({
    signal: testSignal,
  }) => {
    const started = createDeferred<AbortSignal>();
    const cancelled = createDeferred();
    const release = createDeferred();
    const current = await fixture(
      true,
      async ({ abortSignal }) => {
        if (!abortSignal) {
          throw new Error("Missing cancellation signal");
        }
        abortSignal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        started.resolve(abortSignal);
        await release.promise;
        return { status: "ok" };
      },
      false,
      true,
    );
    const portable = await readPortableHeartbeatState("worker", current.getConfig(), {});
    const run = current.cron.run(portable.ref!.schedulerJobId!, "force");
    let removing: ReturnType<typeof current.apply> | undefined;
    try {
      const signal = await withinTest(
        awaitGateBeforeSettlement(started.promise, run, "Portable runner did not start"),
        testSignal,
      );
      const plan = await current.plan();
      removing = current.apply(plan);
      await withinTest(
        awaitGateBeforeSettlement(
          cancelled.promise,
          removing,
          "Claw removal did not cancel its runner",
        ),
        testSignal,
      );
      expect(signal.aborted).toBe(true);
      await withinTest(run, testSignal);
      expect(getSuspensionVisibleCronTaskRunCount({ agentId: "worker" })).toBe(1);
      expect(deletionJournal.readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(false);
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      release.resolve();
      expect(await removing).toMatchObject({ status: "complete", agentRemoved: true });
      expect(await current.cron.readJob(portable.ref!.schedulerJobId!)).toBeUndefined();
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).rejects.toThrow();
    } finally {
      release.resolve();
      await run;
      await removing;
    }
  });

  it.each([false, true])(
    "removes the imported ordinary automation (enabled=%s)",
    async (enabled) => {
      const current = await fixture(enabled, undefined, false, true);
      expect(await current.gateway.inspect("worker")).toEqual([]);
      const plan = await current.plan();
      expect(plan.blockers).toEqual([]);
      expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toEqual([]);
      expect(plan.actions.filter((action) => action.kind === "cronJob")).toEqual([
        expect.objectContaining({ action: "remove", blocked: false }),
      ]);
      const result = await current.apply(plan);
      expect(result).toMatchObject({ status: "complete", agentRemoved: true });
      expect(
        (await current.cron.list({ includeDisabled: true })).every(
          (job) => job.agentId !== "worker",
        ),
      ).toBe(true);
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).rejects.toThrow();
    },
  );

  it.each([
    "ordinary",
    "imported",
    "foreign-store",
    "reassigned",
    "changed-payload",
    "changed-name",
    "changed-wake",
    "changed-delivery",
  ])("keeps %s scheduled work outside Claw ownership", async (variant) => {
    const current = await fixture(false);
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const changed = {
      ...monitor,
      id: variant.startsWith("changed-") ? monitor.id : "independent",
      ...(variant === "ordinary" ? { declarationKey: "operator-job" } : {}),
      ...(variant === "changed-name" ? { name: "operator name" } : {}),
      ...(variant === "changed-wake" ? { wakeMode: "next-heartbeat" as const } : {}),
      ...(variant === "changed-delivery" ? { delivery: { mode: "announce" as const } } : {}),
      ...(variant === "imported" ? { declarationKey: "heartbeat-task:worker:imported" } : {}),
      ...(variant === "reassigned" ? { agentId: "other", owner: { agentId: "worker" } } : {}),
      ...(variant === "changed-payload"
        ? { payload: { kind: "agentTurn" as const, message: "independent" } }
        : {}),
    };
    const database = openOpenClawStateDatabase();
    upsertCronJobRow(
      database.db,
      variant === "foreign-store" ? "/foreign/cron" : current.state.statePath("cron", "jobs.json"),
      changed,
      10,
    );
    const plan = await current.plan();
    if (variant.startsWith("changed-")) {
      expect(await current.apply(plan)).toMatchObject({
        status: "partial",
        agentRemoved: false,
        error: {
          code: "monitor_cleanup_failed",
          message: expect.stringContaining("Independent or changed cron job"),
        },
      });
    } else {
      expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_job_attached" }));
      await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_blocked" });
    }
    await expect(fs.readFile(path.join(current.workspaceDir, "SOUL.md"), "utf8")).resolves.toBe(
      "synthetic managed file\n",
    );
  });
});
