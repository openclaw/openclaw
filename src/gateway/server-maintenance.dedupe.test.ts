import { afterEach, describe, expect, it, vi } from "vitest";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createArtifactDownload } from "./artifact-download-grants.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

// mock-isolation: Dedupe timers must not start the unrelated device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: vi.fn(async () => 0),
}));

const fixtureSources: RpcSourceRef[] = [];

function createActiveRun(kind: "chat-send" | "agent" = "agent"): RpcSourceRef {
  const ref = createRpcSourceForTest(
    { kind },
    {
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      phase: kind === "chat-send" ? "waiting" : "preparing",
    },
  );
  fixtureSources.push(ref);
  return ref;
}

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    runManagedOutgoingMediaGc: async () => undefined,
  };
}

function expiredDedupe(runId: string, status = "accepted") {
  return { ts: Date.now() - DEDUPE_TTL_MS - 1, ok: true, payload: { runId, status } };
}

function createTimedMaintenanceScenario(resolveGatewayContext?: GatewayContextResolver) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const deps = createMaintenanceTimerDeps();
  let timers: ReturnType<typeof startGatewayMaintenanceTimers> | undefined;
  return {
    deps,
    now: Date.now(),
    tick: async () => {
      timers ??= startGatewayMaintenanceTimers({ ...deps, resolveGatewayContext });
      await vi.advanceTimersByTimeAsync(60_000);
    },
    [Symbol.asyncDispose]: async () => {
      if (timers) {
        await stopMaintenanceTimers(timers);
      }
    },
  };
}

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
) {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

describe("gateway dedupe maintenance", () => {
  afterEach(() => {
    for (const ref of fixtureSources.splice(0)) {
      retireSessionControllerInput(ref.input);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
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
    await using scenario = createTimedMaintenanceScenario();
    const { deps, tick } = scenario;
    const runId = "exec-approval-followup:req-active:nonce:retry-1";
    rpcSourceTesting.set(runId, createActiveRun());
    deps.dedupe.set("agent:exec-approval-followup:req-active", expiredDedupe(runId));
    deps.dedupe.set(
      "agent:exec-approval-followup:req-stale",
      expiredDedupe("exec-approval-followup:req-stale:nonce:retry-1"),
    );

    await tick();

    expect(deps.dedupe.has("agent:exec-approval-followup:req-active")).toBe(true);
    expect(deps.dedupe.has("agent:exec-approval-followup:req-stale")).toBe(false);
  });

  it("does not retain this Gateway's stale dedupe key for another Gateway's run", async () => {
    const resolveGatewayContext = () => undefined;
    const otherGateway = () => undefined;
    await using scenario = createTimedMaintenanceScenario(resolveGatewayContext);
    const { deps, tick } = scenario;
    for (const [runId, resolver] of [
      ["own", resolveGatewayContext],
      ["foreign", otherGateway],
    ] as const) {
      const source = createActiveRun();
      bindGatewayContextResolver(source.input, resolver);
      rpcSourceTesting.set(runId, source);
      deps.dedupe.set(`agent:${runId}`, expiredDedupe(runId));
    }
    await tick();
    expect(deps.dedupe.has("agent:own")).toBe(true);
    expect(deps.dedupe.has("agent:foreign")).toBe(false);
  });

  it.each(["chat", "agent"] as const)(
    "keeps live %s dedupe through ttl and overflow",
    async (kind) => {
      await using scenario = createTimedMaintenanceScenario();
      const { deps, now, tick } = scenario;
      const runId = "active-oldest";
      for (let index = 0; index < DEDUPE_MAX; index += 1) {
        deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
      }
      rpcSourceTesting.set(runId, createActiveRun(kind === "chat" ? "chat-send" : "agent"));
      const key = `${kind}:${runId}`;
      deps.dedupe.set(key, expiredDedupe(runId, kind === "chat" ? "ok" : "accepted"));
      deps.dedupe.set("overflow-newest", { ts: now, ok: true });
      await tick();
      expect(deps.dedupe.size).toBe(DEDUPE_MAX);
      expect(
        [key, "stable-0", "stable-1", "overflow-newest"].map((k) => deps.dedupe.has(k)),
      ).toEqual([true, false, false, true]);
    },
  );

  it("evicts multiple dedupe overflows by oldest timestamp with interleaved reinsertions", async () => {
    await using scenario = createTimedMaintenanceScenario();
    const { deps, now, tick } = scenario;

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`item-${index}`, { ts: now - 10_000 + index, ok: true });
    }

    deps.dedupe.delete("item-0");
    deps.dedupe.set("item-0", { ts: now, ok: true });

    deps.dedupe.set("overflow-1", { ts: now - 5_000, ok: true });
    deps.dedupe.set("overflow-2", { ts: now - 20_000, ok: true });

    deps.dedupe.delete("item-500");
    deps.dedupe.set("item-500", { ts: now - 30_000, ok: true });

    expect(deps.dedupe.size).toBe(DEDUPE_MAX + 2);

    await tick();

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);

    expect(
      ["item-500", "overflow-2", "item-0", "overflow-1", "item-1"].map((k) => deps.dedupe.has(k)),
    ).toEqual([false, false, true, true, true]);
  });
});
