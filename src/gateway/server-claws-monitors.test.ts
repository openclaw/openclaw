import { spawn } from "node:child_process";
import { once } from "node:events";
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { buildClawRemovePlan, readClawStatus } from "../claws/lifecycle-state.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import type { ClawMonitorCleanupGateway } from "../claws/monitor-cleanup-contract.js";
import { clearCronJobActive, markCronJobActive } from "../cron/active-jobs.js";
import {
  getSuspensionVisibleCronTaskRunCount,
  waitForActiveCronTaskRuns,
} from "../cron/service/active-run-cancellation.js";
import * as sessionReaper from "../cron/session-reaper.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import {
  claimCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
  isCronRunReceiptOwnerStale,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../cron/store/run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "../cron/store/run-receipt-write-admission.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as stateReader from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { authorizeOperatorScopesForMethod, isGatewayMethodClassified } from "./method-scopes.js";
import {
  useClawMonitorFixture,
  withMonitorDrainClock,
} from "./server-claws-monitors.test-support.js";

const fixture = useClawMonitorFixture();

describe("Claw serving monitor cleanup", () => {
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
    expect(readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(true);
    expect((await readClawStatus("worker", { config: current.getConfig() })).summary.claws).toBe(0);
    await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).rejects.toThrow();
  });

  it("retains local monitor blockers when the serving inspection is unavailable", async () => {
    const current = await fixture(false);
    const plan = await buildClawRemovePlan("worker", {
      config: current.getConfig(),
      monitorGateway: {
        ...current.gateway,
        inspect: async () => {
          throw new Error("Gateway offline");
        },
      },
    });
    expect(plan.blockers).toHaveLength(2);
    const jobs = plan.actions.filter((action) => action.kind === "scheduledJob");
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatchObject({
        action: "retain",
        blocked: true,
        details: { monitorInspection: "unavailable" },
      });
    }
    expect(readAgentDeletionJournal("worker")).toBeUndefined();
  });

  it("removes recorded Claw schedules alongside monitors with one disposition each", async () => {
    const current = await fixture(false, undefined, true);
    const plan = await current.plan();
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.filter((action) => action.kind === "cronJob")).toHaveLength(1);
    expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toHaveLength(2);
    expect(await current.apply(plan)).toMatchObject({
      status: "complete",
      cronJobs: [expect.objectContaining({ manifestId: "daily", action: "removed" })],
    });
  });

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
      expect(readAgentDeletionJournal("worker")).toBeUndefined();
    },
  );

  it.each(["operation", "scheduler"])(
    "revalidates the %s owner after awaited inventory",
    async (changedOwner) => {
      const current = await fixture(false);
      const database = openOpenClawAgentDatabase({ agentId: "worker" });
      const monitors = await current.gateway.inspect("worker");
      await current.withDeletion(async (deletion) => {
        const originalList = current.cron.list.bind(current.cron);
        const list = vi.spyOn(current.cron, "list").mockImplementationOnce(async (opts) => {
          const jobs = await originalList(opts);
          if (changedOwner === "operation") {
            beginAgentDeletionJournal({ ...deletion.entry, operationId: "replacement" });
          } else {
            current.replaceCron();
          }
          return jobs;
        });
        try {
          await expect(
            current.gateway.quiesce("worker", deletion.entry.operationId, monitors),
          ).rejects.toThrow(changedOwner === "operation" ? "deletion fence" : "changing");
          expect(database.db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
          await expect(
            fs.access(path.join(current.workspaceDir, "SOUL.md")),
          ).resolves.toBeUndefined();
        } finally {
          list.mockRestore();
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
        storePath: current.state.statePath("cron", "jobs.json"),
        job: monitor,
        agentId: "worker",
        startedAtMs: Date.now(),
      });
      const handle = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabase({
          database: db,
          prepared,
          receiptSchema: prepareCronRunReceiptWriteSchema(db),
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

  it("closes idle databases but waits for an agent still configured through agents.list", async () => {
    const current = await fixture(false);
    const database = openOpenClawAgentDatabase({ agentId: "worker" });
    const monitors = await current.gateway.inspect("worker");
    await current.withDeletion(async (deletion) => {
      await current.gateway.quiesce("worker", deletion.entry.operationId, monitors);
      expect(() => database.db.prepare("SELECT 1")).toThrow();
      const config = current.getConfig();
      config.agents = { ...config.agents, entries: undefined, list: listAgentEntries(config) };
      for (const monitor of monitors) {
        await current.cron.remove(monitor.id, { systemOwned: true });
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

  it("waits for deferred session cleanup after the monitor row and runner are gone", async () => {
    const runStarted = createDeferred();
    const releaseRun = createDeferred();
    const current = await fixture(true, async () => {
      runStarted.resolve();
      await releaseRun.promise;
      return { status: "ok" };
    });
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanupFinished = createDeferred();
    let cleaning = false;
    const original = sessionReaper.removeCronJobBaseSession;
    const cleanupSpy = vi
      .spyOn(sessionReaper, "removeCronJobBaseSession")
      .mockImplementation(async (params) => {
        if (params.jobId !== monitor.id) {
          return await original(params);
        }
        cleaning = true;
        cleanupStarted.resolve();
        try {
          await releaseCleanup.promise;
          return await original(params);
        } finally {
          cleanupFinished.resolve();
        }
      });
    const run = current.cron.run(monitor.id, "force");
    try {
      await runStarted.promise;
      await current.cron.remove(monitor.id, { systemOwned: true });
      await run;
      await cleanupStarted.promise;
      releaseRun.resolve();
      await vi.waitFor(() =>
        expect(getSuspensionVisibleCronTaskRunCount({ agentId: "worker" })).toBe(0),
      );
      expect(await current.cron.readJob(monitor.id)).toBeUndefined();
      const plan = await current.plan();
      const result = await withMonitorDrainClock(() => current.apply(plan));
      expect(result).toMatchObject({ status: "partial", agentRemoved: false });
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      releaseCleanup.resolve();
      await cleanupFinished.promise;
      expect(await current.apply(await current.plan())).toMatchObject({ status: "complete" });
    } finally {
      releaseRun.resolve();
      releaseCleanup.resolve();
      await run;
      if (cleaning) {
        await cleanupFinished.promise;
      }
      cleanupSpy.mockRestore();
    }
  });

  it.each(["config-write", "cron-persistence", "lost-cancellation-response", "reload"])(
    "retains cleanup state after a %s failure and completes a fresh retry",
    async (failure) => {
      const current = await fixture(false);
      const plan = await current.plan();
      const database = openOpenClawStateDatabase();
      if (failure === "cron-persistence") {
        database.db.exec(`CREATE TRIGGER refuse_monitor_delete
          BEFORE DELETE ON cron_jobs WHEN OLD.agent_id = 'worker'
          BEGIN SELECT RAISE(ABORT, 'synthetic monitor persistence failure'); END`);
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
          database.db.exec("DROP TRIGGER refuse_monitor_delete");
        }
      }
      expect(result).toMatchObject({
        status: "partial",
        agentRemoved: failure === "cron-persistence" || failure === "reload",
        error: { code: "monitor_cleanup_failed" },
      });
      if (failure === "config-write") {
        expect(result.error?.message).toContain("synthetic config persistence failure");
      }
      const firstJournal = readAgentDeletionJournal("worker");
      expect(firstJournal).toBeDefined();
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      expect(readAgentDeletionJournal("worker")?.operationId).toBe(firstJournal?.operationId);
      current.setReloadSettled(true);
      if (failure === "cron-persistence") {
        expect(
          (await current.cron.list({ includeDisabled: true })).some(
            (job) => job.agentId === "worker",
          ),
        ).toBe(true);
        await current.reconcile();
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
    const current = await fixture(false);
    const plan = await current.plan();
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    upsertCronJobRow(
      openOpenClawStateDatabase().db,
      current.state.statePath("cron", "jobs.json"),
      { ...monitor, payload: { kind: "agentTurn", message: "changed source" } },
      0,
    );
    await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_changed" });
    expect(readAgentDeletionJournal("worker")).toBeUndefined();
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

  it.each([false, true])(
    "removes both config-owned monitor families (enabled=%s)",
    async (enabled) => {
      const current = await fixture(enabled);
      const plan = await current.plan();
      expect(plan.blockers).toEqual([]);
      expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toEqual([
        expect.objectContaining({ action: "remove", blocked: false }),
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
  ])("keeps %s scheduled work outside monitor cleanup", async (variant) => {
    const current = await fixture(false);
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const changed = {
      ...monitor,
      id: variant.startsWith("changed-") ? monitor.id : "independent",
      ...(variant === "ordinary" ? { declarationKey: "operator-job" } : {}),
      ...(variant === "changed-name" ? { name: "operator name" } : {}),
      ...(variant === "changed-wake" ? { wakeMode: "now" as const } : {}),
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
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_job_attached" }));
    await expect(current.apply(plan)).rejects.toMatchObject({ code: "remove_blocked" });
    await expect(fs.readFile(path.join(current.workspaceDir, "SOUL.md"), "utf8")).resolves.toBe(
      "synthetic managed file\n",
    );
  });

  it("keeps files and a durable retry fence while a cancelled runner core is held", async () => {
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const current = await fixture(true, async ({ abortSignal }) => {
      if (!abortSignal) {
        throw new Error("Missing cancellation signal");
      }
      started.resolve(abortSignal);
      await release.promise;
      return { status: "ok" };
    });
    const monitor = (await current.cron.list({ includeDisabled: true })).find(
      (job) => job.agentId === "worker" && job.payload.kind === "agentTurn",
    )!;
    const run = current.cron.run(monitor.id, "force");
    const signal = await started.promise;
    try {
      const receipt = findActiveCronRunReceiptInDatabase({
        database: openOpenClawStateDatabase().db,
        storePath: current.state.statePath("cron", "jobs.json"),
        jobId: monitor.id,
      });
      if (!receipt) {
        throw new Error("Missing held monitor receipt");
      }
      const plan = await current.plan();
      const result = await withMonitorDrainClock(() => current.apply(plan));
      expect(signal.aborted).toBe(true);
      await run;
      expect(result).toMatchObject({
        status: "partial",
        agentRemoved: false,
        error: { code: "monitor_cleanup_failed" },
      });
      expect(readAgentDeletionJournal("worker")).toBeDefined();
      expect(Object.hasOwn(current.getConfig().agents?.entries ?? {}, "worker")).toBe(true);
      await expect(fs.access(path.join(current.workspaceDir, "SOUL.md"))).resolves.toBeUndefined();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      expect(readAgentDeletionJournal("worker")).toBeDefined();
      expect(isCronRunReceiptOwnerStale(receipt)).toBe(false);
      release.resolve();
      await vi.waitFor(() => expect(isCronRunReceiptOwnerStale(receipt)).toBe(true));
      expect(
        findActiveCronRunReceiptInDatabase({
          database: openOpenClawStateDatabase().db,
          storePath: current.state.statePath("cron", "jobs.json"),
          jobId: monitor.id,
        }),
      ).toMatchObject({ receiptId: receipt.receiptId, ownerPid: process.pid });
      const retry = await current.plan();
      const retried = await current.apply(retry);
      expect(retried, JSON.stringify(retried.error)).toMatchObject({ status: "complete" });
    } finally {
      release.resolve();
      await run;
      expect(await waitForActiveCronTaskRuns(1_000)).toEqual({ drained: true, active: 0 });
    }
  });
});
