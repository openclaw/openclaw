import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  ExecApprovalManager,
  type OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import {
  createTestApprovalFixture,
  createApprovalScheduler,
  type ApprovalClockWake,
} from "./exec-approval-manager.test-support.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import { InvalidApprovalIdError } from "./exec-approval-registration.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";

async function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = await getOperatorApprovalDetailed({ nowMs: Date.now(), ...params });
  return result.outcome === "found" ? result.record : null;
}

describe("ExecApprovalManager", () => {
  let currentTest: TestContext;
  let scheduled: ReturnType<typeof createApprovalScheduler>;
  beforeEach((test) => {
    currentTest = test;
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    scheduled = createApprovalScheduler();
  });
  afterEach(async () => {
    await scheduled.scheduler.stop();
    vi.restoreAllMocks();
  });

  const persistentPolicy = {
    resolveAllowedDecisions: () => ["allow-once", "deny"] as const,
    resolveAudienceSessionKeys: (sessionKey: string) => [sessionKey, "agent:main:parent"],
  };

  function createManager<TPayload = ExecApprovalRequestPayload>(
    options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence" | "scheduler"> = {},
  ) {
    const fixture = createTestApprovalFixture<TPayload>(currentTest, {
      ...options,
      scheduler: scheduled.scheduler,
    });
    const { databaseOptions } = fixture;
    return {
      ...fixture,
      dir: path.dirname(databaseOptions.path),
      readStored: () => getOperatorApproval({ id: "approval", databaseOptions }),
    };
  }

  async function register(
    manager: ExecApprovalManager,
    id = "approval",
    timeout = 60_000,
    request: ExecApprovalRequestPayload = { command: "echo ok" },
    bindings: Partial<ExecApprovalRecord> = {},
  ) {
    const record = Object.assign(manager.create(request, timeout, id), bindings);
    const { decision: decisionPromise } = await manager.register(record, timeout);
    return {
      record,
      id: record.id,
      decisionPromise,
      allow: () => manager.resolveDetailed(record.id, "allow-once", device),
      snapshot: () => manager.getSnapshot(record.id),
    };
  }

  async function persistentApproval(
    options: Parameters<typeof createManager<ExecApprovalRequestPayload>>[0] = {},
    timeout = 60_000,
    request?: ExecApprovalRequestPayload,
  ) {
    const fixture = createManager({ ...persistentPolicy, ...options });
    return { ...fixture, ...(await register(fixture.manager, "approval", timeout, request)) };
  }

  async function lifecycleApproval(timeout = 60_000) {
    const events: OperatorApprovalLifecycleEvent[] = [];
    return {
      ...(await persistentApproval({ onLifecycle: (event) => events.push(event) }, timeout)),
      events,
    };
  }

  function blockStorage({
    dir,
    databaseOptions,
  }: Pick<ReturnType<typeof createManager>, "dir" | "databaseOptions">) {
    const validPath = databaseOptions.path;
    const blocker = path.join(dir, "storage-blocker");
    fs.writeFileSync(blocker, "blocked");
    databaseOptions.path = path.join(blocker, "state.sqlite");
    return () => {
      databaseOptions.path = validPath;
    };
  }

  const device = { kind: "device", id: "control-ui" } as const;
  const system = { kind: "system", id: null } as const;
  const delegatedAuthority: NonNullable<ExecApprovalRecord["agentRuntimeDelegatedAuthority"]> = {
    kind: "local",
    operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
    lifecycleGeneration: "generation-1",
    claimId: "claim-1",
  };

  function delegatedManager() {
    const runtime = { active: true };
    const { manager } = createManager({
      validateAgentRuntimeDelegatedAuthority: () => runtime.active,
    });
    const bind = (id = "approval", bindings: Partial<ExecApprovalRecord> = {}) =>
      register(manager, id, 60_000, undefined, {
        agentRuntimeDelegatedAuthority: delegatedAuthority,
        ...bindings,
      });
    return { manager, runtime, bind };
  }

  function deadlineTimers(timers: ApprovalClockWake[], delays: number[]) {
    const deadlines = timers.filter(({ delayMs }) => delayMs !== 15_000);
    expect(deadlines.map(({ delayMs }) => delayMs)).toEqual(delays);
    return deadlines;
  }

  async function runTimer(timer: ApprovalClockWake | undefined, preserveNow = false) {
    const wake = expectDefined(timer, "scheduled wake");
    if (!preserveNow) {
      vi.mocked(Date.now).mockReturnValue(Math.max(Date.now(), wake.atMs));
    }
    await wake.run();
  }

  it("expires resolved approval grace after elapsed time despite a wall-clock rollback", async () => {
    const { manager } = createManager();
    const { id, decisionPromise, snapshot } = await register(manager);
    expect(await manager.resolve(id, "allow-once")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect((await snapshot())?.resolutionSource).toBe("operator");
    const cleanupTimer = scheduled.wakes.find((timer) => timer.delayMs === 15_000);
    vi.mocked(Date.now).mockReturnValue(500);
    await runTimer(cleanupTimer, true);
    expect(manager.getLocalSnapshot(id)).toBeNull();
    expect(await manager.consumeAllowOnce(id)).toBe(false);
  });

  it("retains a resolved live binding across a slow handoff and cleans up after release", async () => {
    const timers = scheduled.wakes;
    const now = vi.mocked(Date.now);
    const { manager, id, readStored } = await persistentApproval();
    const releaseFirst = manager.retainForHandoff(id);
    const releaseSecond = manager.retainForHandoff(id);
    await manager.resolveDetailed(id, "allow-once", { kind: "device", id: "device-1" });
    now.mockReturnValue(20_000);
    expect(manager.getLiveSnapshot(id)).toMatchObject({ decision: "allow-once" });
    expect(manager.consumeAskFallback(id)).toBe(false);
    expect(await manager.consumeAllowOnce(id, "system.run:approval-consume")).toBe(true);
    expect(manager.consumeAskFallback(id)).toBe(false);
    expect(await manager.consumeAllowOnce(id, "system.run:approval-consume")).toBe(false);
    expect(await readStored()).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      consumedBy: "system.run:approval-consume",
    });
    expect(timers.filter((timer) => timer.delayMs === 15_000)).toHaveLength(0);
    releaseFirst?.();
    expect(timers.filter((timer) => timer.delayMs === 15_000)).toHaveLength(0);
    releaseSecond?.();
    const cleanupTimers = timers.filter((timer) => timer.delayMs === 15_000);
    expect(cleanupTimers).toHaveLength(1);
    releaseSecond?.();
    expect(timers.filter((timer) => timer.delayMs === 15_000)).toHaveLength(1);
    await runTimer(cleanupTimers[0]);
    expect(manager.getLiveSnapshot(id)).toBeNull();
  });

  it("cancels old cleanup and restarts the grace period after handoff", async () => {
    const { manager } = createManager();
    const timers = scheduled.wakes;
    const now = vi.mocked(Date.now);
    const { id } = await register(manager);
    expect(await manager.resolve(id, "allow-once")).toBe(true);
    const staleCleanup = timers.find((timer) => timer.delayMs === 15_000);
    const release = manager.retainForHandoff(id);
    expect(staleCleanup).toMatchObject({ atMs: 16_000, cancelled: true });
    now.mockReturnValue(2_000);
    release?.();
    const cleanupTimers = timers.filter((timer) => timer.delayMs === 15_000);
    expect(cleanupTimers).toHaveLength(2);
    expect(cleanupTimers[1]).toMatchObject({ atMs: 17_000, cancelled: false });
    now.mockReturnValue(16_000);
    expect(manager.getLiveSnapshot(id)).toMatchObject({ decision: "allow-once" });
    await runTimer(cleanupTimers[1]);
    expect(manager.getLiveSnapshot(id)).toBeNull();
  });

  it("never projects an allowed decision without its live local record", async () => {
    const { manager, bind } = delegatedManager();
    const { id } = await bind("approval-live-projection");
    expect(await manager.resolve(id, "allow-always")).toBe(true);
    expect(manager.projectDecisionIfActive(id, "allow-always")).toBe("allow-always");
    await runTimer(scheduled.wakes.find((timer) => timer.delayMs === 15_000));
    expect(manager.projectDecisionIfActive(id, "allow-always")).toBeNull();
    expect(createManager().manager.projectDecisionIfActive(id, "allow-always")).toBeNull();
    const { record: unbound } = await register(manager, "approval-unbound");
    expect(await manager.resolve(unbound.id, "allow-always")).toBe(true);
    expect(manager.projectDecisionIfActive(unbound.id, "allow-always")).toBe("allow-always");
  });

  it("schedules the remaining deadline after registration preparation", async () => {
    const { manager } = createManager();
    vi.mocked(Date.now).mockReturnValueOnce(1_000).mockReturnValue(1_250);
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-deadline");
    await manager.register(record, 60_000);
    expect(record.expiresAtMs).toBe(61_000);
    deadlineTimers(scheduled.wakes, [59_750]);
  });

  it("reschedules a deadline timer when the wall clock rolls backward", async () => {
    const timers = scheduled.wakes;
    const { readStored, record, decisionPromise } = await persistentApproval();
    vi.mocked(Date.now).mockReturnValue(500);
    await runTimer(deadlineTimers(timers, [60_000])[0], true);
    expect(await readStored()).toMatchObject({ status: "pending" });
    const rescheduled = deadlineTimers(timers, [60_000, 60_500]);
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);
    await runTimer(rescheduled[1]);
    await expect(decisionPromise).resolves.toBeNull();
    expect(await readStored()).toMatchObject({ status: "expired" });
  });

  it("publishes the derived global audience after durable insert and live waiter registration", async () => {
    let durableAtCallback: unknown;
    let waiterAtCallback: Promise<ExecApprovalDecision | null> | null = null;
    const lifecycleEvents: OperatorApprovalLifecycleEvent[] = [];
    const resolveAudienceSessionKeys = (sessionKey: string, agentId?: string | null) => [
      sessionKey === "global" && agentId ? `agent:${agentId}:global` : sessionKey,
    ];
    const created = createManager({
      ...persistentPolicy,
      resolveAudienceSessionKeys,
      onLifecycle: (event) => {
        lifecycleEvents.push(event);
        if (event.phase === "pending") {
          durableAtCallback = openOpenClawStateDatabase(created.databaseOptions)
            .db.prepare("SELECT approval_id, status FROM operator_approvals WHERE approval_id = ?")
            .get(event.record.id);
          waiterAtCallback = created.manager.awaitDecision(event.record.id);
        }
      },
    });
    const manager = created.manager;
    const { id, decisionPromise } = await register(manager, "approval", 60_000, {
      command: "echo ordered",
      sessionKey: "global",
      agentId: "work",
    });
    expect(lifecycleEvents).toMatchObject([
      {
        phase: "pending",
        record: {
          id,
          status: "pending",
          audienceSessionKeys: ["agent:work:global"],
        },
      },
    ]);
    expect(await created.readStored()).toMatchObject({
      source: { sessionKey: "global", agentId: "work" },
      audienceSessionKeys: ["agent:work:global"],
    });
    expect(durableAtCallback).toEqual({ approval_id: id, status: "pending" });
    await manager.resolveDetailed(id, "deny", system);
    await expect(decisionPromise).resolves.toBe("deny");
    await expect(waiterAtCallback).resolves.toBe("deny");
  });

  it.each([
    ["operator", "allowed", "allow-once", undefined, "allow-once"],
    ["timeout", "expired", "deny", "timeout", null],
    ["force-deny", "denied", "deny", "malformed-verdict", "deny"],
  ] as const)(
    "emits one terminal event when %s wins",
    async (transition, status, decision, terminalReason, waiterDecision) => {
      const { manager, readStored, record, decisionPromise, events, allow } =
        await lifecycleApproval();
      if (transition === "operator") {
        expect(await allow()).toMatchObject({ outcome: "resolved" });
        expect(
          await manager.resolveDetailed(record.id, "deny", { kind: "channel", id: "telegram" }),
        ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
        expect(await readStored()).toMatchObject({
          decision: "allow-once",
          resolver: { id: "control-ui" },
        });
      } else if (transition === "timeout") {
        vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);
        await runTimer(deadlineTimers(scheduled.wakes, [60_000])[0]);
      } else {
        expect(
          await manager.forceDenyDetailed(record.id, "malformed-verdict", {
            kind: "system",
            id: "invalid-verdict",
          }),
        ).toMatchObject({ outcome: "denied" });
      }
      await expect(decisionPromise).resolves.toBe(waiterDecision);
      expect(events.map((event) => event.phase)).toEqual(["pending", "terminal"]);
      expect(events[1]?.record).toMatchObject({
        id: record.id,
        status,
        decision,
        ...(terminalReason ? { terminalReason } : { resolver: device }),
      });
    },
  );

  it("isolates lifecycle callback failures from registration and resolution", async () => {
    const onLifecycle = vi.fn(() => {
      throw new Error("stream unavailable");
    });
    const { manager, readStored, id, decisionPromise } = await persistentApproval({ onLifecycle });
    const result = await manager.resolveDetailed(id, "deny", device);
    expect(result).toMatchObject({ outcome: "resolved" });
    await expect(decisionPromise).resolves.toBe("deny");
    expect(onLifecycle).toHaveBeenCalledTimes(2);
    expect(await readStored()).toMatchObject({ status: "denied", decision: "deny" });
  });

  it("does not re-emit pending for an idempotent persisted registration", async () => {
    const { manager, databaseOptions, readStored } = createManager(persistentPolicy);
    const { record, id, decisionPromise } = await register(manager, "approval", 60_000, {
      command: "echo replay",
      sessionKey: "agent:main:child",
    });
    const onLifecycle = vi.fn();
    const replayManager = new ExecApprovalManager({
      ...persistentPolicy,
      scheduler: scheduled.scheduler,
      persistence: { runtimeEpoch: manager.runtimeEpoch, databaseOptions },
      onLifecycle,
    });
    const replayPromise = (
      await replayManager.register({ ...record, request: { ...record.request } }, 60_000)
    ).decision;
    const replayWaiter = replayManager.awaitDecision(id);
    expect(onLifecycle).not.toHaveBeenCalled();
    expect(await readStored()).toMatchObject({ id, status: "pending" });
    await manager.resolveDetailed(id, "deny", system);
    await replayManager.resolveDetailed(id, "deny", system);
    return Promise.all([
      expect(decisionPromise).resolves.toBe("deny"),
      expect(replayPromise).resolves.toBe("deny"),
      expect(replayWaiter).resolves.toBe("deny"),
    ]);
  });

  it("persists only the reviewer-safe presentation while retaining the local request", async () => {
    const { manager, databaseOptions, readStored } = createManager(persistentPolicy);
    const request: ExecApprovalRequestPayload = {
      command: "echo safe",
      commandArgv: ["/bin/echo", "hidden-argv-value"],
      cwd: "/hidden/cwd/value",
      systemRunBinding: {
        argv: ["/bin/echo", "hidden-binding-argv"],
        cwd: "/hidden/binding/cwd",
        agentId: "main",
        sessionKey: "agent:main:secret",
        envHash: "hidden-env-hash",
      },
    };
    const { id, decisionPromise } = await register(manager, "approval", 60_000, request);
    const durable = await readStored();
    expect(durable?.presentation).toMatchObject({ kind: "exec", commandText: "echo safe" });
    expect(JSON.stringify(durable)).not.toMatch(
      /hidden-argv-value|\/hidden\/cwd\/value|hidden-env-hash/,
    );
    const database = openOpenClawStateDatabase(databaseOptions);
    const row = database.db
      .prepare("SELECT presentation_json FROM operator_approvals WHERE approval_id = ?")
      .get(id) as { presentation_json?: unknown } | undefined;
    expect(String(row?.presentation_json)).not.toContain("hidden-");
    expect(manager.getLiveSnapshot(id)?.request).toBe(request);
    expect((await manager.listPendingRecords())[0]?.request).toBe(request);
    await manager.resolveDetailed(id, "deny", device);
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it.for([
    { name: "plugin approval UUID", id: "plugin:12345678-1234-1234-1234-123456789abc" },
    { name: "128-character id", id: "a".repeat(128) },
    { name: "undefined sentinel", id: undefined },
    { name: "null sentinel", id: null },
    { name: "empty sentinel", id: "" },
    { name: "URL dot segment", id: ".", rejected: true },
    { name: "URL parent segment", id: "..", rejected: true },
    { name: "trailing line feed", id: "approval-safe\n", rejected: true },
    { name: "overlong value", id: "a".repeat(129), rejected: true },
  ])("validates approval IDs: $name", ({ id, rejected }) => {
    const { manager } = createManager();
    const create = () => manager.create({ command: "echo id" }, 60_000, id);
    if (rejected) {
      expect(create).toThrow(InvalidApprovalIdError);
    } else if (id) {
      expect(create().id).toBe(id);
    } else {
      expect(create().id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("rejects unrenderable persistent plugin requests before creating a row or waiter", async () => {
    const { manager, databaseOptions } = createManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
    });
    const requests: PluginApprovalRequestPayload[] = [
      { title: "", description: "Needs approval" },
      { title: "Sensitive action", description: " \t " },
    ];
    for (const [index, request] of requests.entries()) {
      const id = `plugin:invalid-presentation-${index}`;
      const record = manager.create(request, 60_000, id);

      await expect(manager.register(record, 60_000)).rejects.toThrow(
        "approval cannot be persisted without a valid reviewer presentation",
      );
      expect(manager.awaitDecision(id)).toBeNull();
      expect(await getOperatorApproval({ id, databaseOptions })).toBeNull();
    }
  });

  it.each([
    { resolvedBy: null, status: "expired", reason: "timeout" },
    { resolvedBy: "no-approval-route", status: "denied", reason: "no-route" },
  ])(
    "persists $reason denial while preserving the null waiter result",
    async ({ resolvedBy, status, reason }) => {
      const { manager, readStored, id, decisionPromise, snapshot } = await persistentApproval();

      expect(await manager.expire(id, resolvedBy)).toBe(true);
      await expect(decisionPromise).resolves.toBeNull();
      expect(await snapshot()).toMatchObject({ status, terminalReason: reason, resolvedBy });
      expect((await snapshot())?.decision).toBeUndefined();
      expect(await readStored()).toMatchObject({
        status,
        decision: "deny",
        terminalReason: reason,
      });
      if (reason === "timeout") {
        expect(manager.consumeAskFallback(id)).toBe(true);
        expect(manager.consumeAskFallback(id)).toBe(false);
        expect((await snapshot())?.askFallbackConsumed).toBe(true);
      }
    },
  );

  it.each(["snapshot", "waiter"] as const)(
    "reconciles the %s read with the durable expiry boundary",
    async (read) => {
      const { manager, record, decisionPromise, snapshot } = await persistentApproval();
      vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

      if (read === "waiter") {
        const waiter = manager.awaitDecision(record.id);
        expect(waiter).not.toBeNull();
        await expect(waiter).resolves.toBeNull();
      }
      expect(await snapshot()).toMatchObject({ status: "expired" });
      expect(await manager.listPendingRecords()).toEqual([]);
      await expect(decisionPromise).resolves.toBeNull();
    },
  );

  it("reports persistence failures from the timeout callback without throwing", async () => {
    const onError = vi.fn();
    const fixture = await persistentApproval({ onError });
    const { id, decisionPromise } = fixture;
    blockStorage(fixture);
    const deadline = deadlineTimers(scheduled.wakes, [60_000])[0];
    await expect(runTimer(deadline)).resolves.toBeUndefined();
    await expect(decisionPromise).resolves.toBe("deny");
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ approvalId: id, approvalKind: "exec", operation: "expire" }),
    );
  });

  it.each(["resolution", "expiry", "lookup"] as const)(
    "preserves the fail-closed verdict through storage recovery by %s",
    async (recovery) => {
      const fixture = await lifecycleApproval(recovery === "expiry" ? 1_000 : 60_000);
      const { manager, readStored, record, decisionPromise, events, allow, snapshot } = fixture;
      const restore = blockStorage(fixture);
      await expect(allow()).rejects.toThrow();
      await expect(decisionPromise).resolves.toBe("deny");
      restore();
      vi.mocked(Date.now).mockReturnValue(recovery === "expiry" ? record.expiresAtMs : 2_000);
      if (recovery === "expiry") {
        expect(await allow()).toMatchObject({
          outcome: "expired",
          record: { status: "expired" },
        });
        expect(events.map((event) => event.phase)).toEqual(["pending", "terminal"]);
        expect(events[1]?.record).toMatchObject({ status: "expired", terminalReason: "timeout" });
      } else {
        const denied = { status: "denied", terminalReason: "storage-corrupt" };
        if (recovery === "lookup") {
          const pending = expectDefined(await readStored(), "durable pending approval");
          expect(pending.status).toBe("pending");
          expect(
            await manager.reconcileDurableLookup({ outcome: "found", record: pending }),
          ).toMatchObject(denied);
        } else {
          expect(await allow()).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
        }
        expect(await readStored()).toMatchObject({ ...denied, decision: "deny" });
        if (recovery === "resolution") {
          vi.mocked(Date.now).mockReturnValue(100_000);
          expect(await snapshot()).toMatchObject({
            decision: "deny",
            terminalReason: "storage-corrupt",
          });
        }
      }
    },
  );

  it.each(["elapsed", "crossed-during-redemption"] as const)(
    "refuses allow-once redemption when the grace window is %s",
    async (boundary) => {
      const { manager, readStored, id, allow, snapshot } = await persistentApproval();
      await allow();
      const now = vi.mocked(Date.now);
      if (boundary === "elapsed") {
        now.mockReturnValue(16_001);
        expect(await snapshot()).toBeNull();
      } else {
        now.mockReturnValueOnce(15_999).mockReturnValue(16_000);
      }
      expect(await manager.consumeAllowOnce(id)).toBe(false);
      expect(await readStored()).toMatchObject({ decision: "allow-once", consumedAtMs: null });
    },
  );

  it("never rehydrates executable ownership from the durable record", async () => {
    const { manager, databaseOptions, readStored } = createManager(persistentPolicy);
    const { record, allow, snapshot } = await register(manager, "approval", 60_000, undefined, {
      requestedByDeviceId: "device-owner",
    });
    await allow();
    const sameEpochManager = new ExecApprovalManager<{ command: string }>({
      scheduler: scheduled.scheduler,
      approvalKind: "exec",
      persistence: { runtimeEpoch: manager.runtimeEpoch, databaseOptions },
    });
    const durable = expectDefined(await readStored(), "durable approval");
    expect(await snapshot()).toMatchObject({
      decision: "allow-once",
      requestedByDeviceId: "device-owner",
    });
    expect(await sameEpochManager.getSnapshot(record.id)).toBeNull();
    expect(
      await sameEpochManager.reconcileDurableLookup({ outcome: "found", record: durable }),
    ).toBe(durable);
    expect(sameEpochManager.getLiveSnapshot(record.id)).toBeNull();
    expect(await sameEpochManager.consumeAllowOnce(record.id)).toBe(false);
    await runTimer(scheduled.wakes.find((timer) => timer.delayMs === 15_000));
    expect(await snapshot()).toBeNull();
    expect(await manager.consumeAllowOnce(record.id)).toBe(false);
    expect(await readStored()).toMatchObject({ decision: "allow-once", consumedAtMs: null });
  });

  it("cancels a parked waiter when delegated authority closes", async () => {
    const { manager, runtime, bind } = delegatedManager();
    const { id, snapshot } = await bind();
    runtime.active = false;
    await expect(manager.awaitDecision(id)).resolves.toBeNull();
    expect(await snapshot()).toMatchObject({ status: "cancelled", terminalReason: "run-aborted" });
  });

  it("denies stale non-deny resolution and retained allow-once redemption", async () => {
    const { manager, runtime, bind } = delegatedManager();
    const { record: stalePending } = await bind("approval-closed-resolve");
    runtime.active = false;
    expect(
      await manager.resolveDetailed(stalePending.id, "allow-once", { kind: "device", id: "ui" }),
    ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
    expect(await manager.getSnapshot(stalePending.id)).toMatchObject({ status: "cancelled" });
    runtime.active = true;
    const { record: retained } = await bind("approval-closed-consume");
    expect(await manager.resolve(retained.id, "allow-once", "ui")).toBe(true);
    runtime.active = false;
    expect(manager.projectDecisionIfActive(retained.id, "allow-once")).toBeNull();
    expect(await manager.consumeAllowOnce(retained.id)).toBe(false);
  });

  it("keeps delegated authority independent from optional audit evidence", async () => {
    const { manager, runtime, bind } = delegatedManager();
    const { record, snapshot } = await bind("approval", {
      executionIdentityToken: {
        tokenVersion: 1,
        createdAt: 1,
        runId: "run-1",
        contextId: "context-audit",
        executionId: "execution-audit",
      },
    });
    delete record.executionIdentityToken;
    expect(await manager.forceDenyIfRuntimeAuthorityClosed(record.id)).toBeNull();
    expect((await snapshot())?.resolvedAtMs).toBeUndefined();
    runtime.active = false;
    expect(await manager.forceDenyIfRuntimeAuthorityClosed(record.id)).toMatchObject({
      outcome: "denied",
    });
  });
});
