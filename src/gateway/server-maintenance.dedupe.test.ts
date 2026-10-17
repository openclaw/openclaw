import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createArtifactDownload } from "./artifact-download-grants.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const startDevicePairSetupMaintenanceMock = vi.hoisted(() => vi.fn(async () => 0));

// mock-isolation: Dedupe timers must not start the unrelated device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: startDevicePairSetupMaintenanceMock,
}));

const ABORTED_RUN_TTL_MS = 60 * 60_000;

function createActiveRun(
  sessionKey: string,
  kind?: ChatAbortControllerEntry["kind"],
): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + ABORTED_RUN_TTL_MS,
    kind,
  };
}

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    runWorktreeGc: vi.fn(async () => undefined),
    runManagedOutgoingMediaGc: async () => undefined,
  };
}

type MaintenanceTimerDeps = ReturnType<typeof createMaintenanceTimerDeps>;

function expiredDedupe(runId: string, status = "accepted") {
  return { ts: Date.now() - DEDUPE_TTL_MS - 1, ok: true, payload: { runId, status } };
}

function seedStableDedupeEntries(deps: MaintenanceTimerDeps, now: number): void {
  for (let index = 0; index < DEDUPE_MAX; index += 1) {
    deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
  }
}

function createTimedMaintenanceScenario() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const deps = createMaintenanceTimerDeps();
  return { deps, now: Date.now() };
}

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
) {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
  vi.useRealTimers();
}

describe("gateway dedupe maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    startDevicePairSetupMaintenanceMock.mockReset().mockResolvedValue(0);
  });

  it("releases an unused expired artifact grant while its connection stays open", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    using now = vi.spyOn(Date, "now");
    now.mockImplementation(() => clock.clock.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const deps = { ...createMaintenanceTimerDeps(), scheduler, isNixMode: true };
    const controller = new AbortController();
    const client: GatewayClient = {
      connId: "unused-artifact",
      connectionSignal: controller.signal,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "test", platform: "test", mode: "test" },
      },
    };
    deps.clients.add(client);
    const release = vi.fn();
    const read = vi.fn(async () => undefined);
    const grant = createArtifactDownload({
      client,
      prepared: {
        artifact: {
          id: "unused-artifact",
          type: "file",
          title: "unused.txt",
          download: { mode: "bytes" },
        },
        digest: "unused-artifact-digest",
      },
      assertCurrent: () => {},
      read,
      release,
    });
    const timers = startGatewayMaintenanceTimers(deps);
    try {
      await clock.advanceBy(0);
      await clock.advanceTo(Date.parse(grant.expiresAt) - 1);
      expect(release).not.toHaveBeenCalled();
      await clock.advanceBy(60_000);
      expect(controller.signal.aborted).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      await clock.advanceBy(60_000);
      expect(release).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await stopMaintenanceTimers(timers);
      await scheduler.stop();
    }
  });

  it("keeps active exec approval dedupe aliases past the normal ttl", async () => {
    const { deps } = createTimedMaintenanceScenario();
    const runId = "exec-approval-followup:req-active:nonce:retry-1";
    deps.chatAbortControllers.set(runId, createActiveRun("agent:main:main", "agent"));
    deps.dedupe.set("agent:exec-approval-followup:req-active", expiredDedupe(runId));
    deps.dedupe.set(
      "agent:exec-approval-followup:req-stale",
      expiredDedupe("exec-approval-followup:req-stale:nonce:retry-1"),
    );

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:exec-approval-followup:req-active")).toBe(true);
    expect(deps.dedupe.has("agent:exec-approval-followup:req-stale")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it.each(["chat", "agent"] as const)(
    "keeps live %s dedupe through ttl and overflow",
    async (kind) => {
      const { deps, now } = createTimedMaintenanceScenario();
      const runId = "active-oldest";
      seedStableDedupeEntries(deps, now);
      if (kind === "chat") {
        deps.chatQueuedTurns.set(runId, {
          controller: new AbortController(),
          sessionId: "session-main",
          sessionKey: "agent:main:main",
        });
      } else {
        deps.chatAbortControllers.set(runId, createActiveRun("agent:main:main", "agent"));
      }
      const key = `${kind}:${runId}`;
      deps.dedupe.set(key, expiredDedupe(runId, kind === "chat" ? "ok" : "accepted"));
      deps.dedupe.set("overflow-newest", { ts: now, ok: true });
      const timers = startGatewayMaintenanceTimers(deps);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.dedupe.size).toBe(DEDUPE_MAX);
      expect(deps.dedupe.has(key)).toBe(true);
      expect(deps.dedupe.has("stable-0")).toBe(false);
      expect(deps.dedupe.has("stable-1")).toBe(false);
      expect(deps.dedupe.has("overflow-newest")).toBe(true);
      await stopMaintenanceTimers(timers);
    },
  );

  it("evicts multiple dedupe overflows by oldest timestamp with interleaved reinsertions", async () => {
    const { deps, now } = createTimedMaintenanceScenario();

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`item-${index}`, { ts: now - 10_000 + index, ok: true });
    }

    deps.dedupe.delete("item-0");
    deps.dedupe.set("item-0", { ts: now, ok: true });

    deps.dedupe.set("overflow-1", { ts: now - 5_000, ok: true });
    deps.dedupe.set("overflow-2", { ts: now - 20_000, ok: true });

    deps.dedupe.delete("item-500");
    deps.dedupe.set("item-500", { ts: now - 30_000, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX + 2);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);

    expect(deps.dedupe.has("item-500")).toBe(false);
    expect(deps.dedupe.has("overflow-2")).toBe(false);

    expect(deps.dedupe.has("item-0")).toBe(true);
    expect(deps.dedupe.has("overflow-1")).toBe(true);

    expect(deps.dedupe.has("item-1")).toBe(true);

    await stopMaintenanceTimers(timers);
  });
});
