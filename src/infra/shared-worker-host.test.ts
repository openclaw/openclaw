import { mkdirSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { initializeGatewayResourceProfile } from "./gateway-resource-profile.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  claimsSharedHostSlot,
  createHostedWorker,
  isHostedWorkerEndpoint,
  type HostedWorkerEndpoint,
} from "./shared-worker-host.js";
import { sharedHostSqliteKeys } from "./shared-worker-host.types.js";
import { getTrackedWorkerPoolSnapshot } from "./worker-cpu.js";
import {
  createWorkerPoolMemoryBudget,
  getWorkerMemoryBudgetSnapshot,
  initializeWorkerMemoryBudget,
} from "./worker-memory-budget.js";
import { closeDefaultRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import { createWorkerTaskHost } from "./worker-task-host.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

const sqliteStore = resolveRuntimeProcessEntrypointUrl("sqliteStore");
const live = new Set<HostedWorkerEndpoint>();

function carrier(key: string) {
  const endpoint = createHostedWorker(sqliteStore, {}, { key, ready: false });
  live.add(endpoint);
  const exited = new Promise<{ code: number; error?: Error }>((resolve) => {
    let error: Error | undefined;
    endpoint.on("error", (failure) => {
      error = failure;
    });
    endpoint.once("exit", (code) => resolve({ code, error }));
  });
  const started = new Promise<void>((resolve) => {
    endpoint.once("started", resolve);
  });
  return { endpoint, started, exited };
}

afterEach(async () => {
  for (const endpoint of live) {
    endpoint.retiring("cancelled");
    await endpoint.terminate();
  }
  live.clear();
  initializeWorkerMemoryBudget(
    initializeGatewayResourceProfile({ profile: "standard" }),
    undefined,
  );
});

it("hosts nothing outside the lean profile", () => {
  initializeGatewayResourceProfile({ profile: "standard" });
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(false);
});

it("replaces the whole host when one endpoint needs physical termination", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const agent = carrier("sqlite-store:agent");
  const shared = carrier("sqlite-store:shared-state");
  await Promise.all([agent.started, shared.started]);
  // Two logical endpoints, one physical isolate; a key admits one live endpoint.
  expect(agent.endpoint.threadId).toBe(shared.endpoint.threadId);
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(false);
  const census = getTrackedWorkerPoolSnapshot().workerCensus;
  expect(census.find((row) => row.kind === "shared-worker-host.worker.js")).toMatchObject({
    count: 1,
    hostedEndpoints: 2,
  });

  const firstThread = agent.endpoint.threadId;
  agent.endpoint.retiring("cancelled");
  await agent.endpoint.terminate();
  const sibling = await shared.exited;
  // The uninvolved endpoint fails explicitly instead of silently losing its isolate.
  expect(sibling.code).not.toBe(0);
  expect(sibling.error?.message).toMatch(/^Shared worker host failed: sqlite-store endpoint/);
  expect(shared.endpoint.terminalFailure).toBe(sibling.error);

  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);
  const replacement = carrier("sqlite-store:agent");
  await replacement.started;
  expect(replacement.endpoint.threadId).not.toBe(firstThread);
});

it("detaches an idle endpoint logically and releases the host after the last one", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const agent = carrier("sqlite-store:agent");
  const shared = carrier("sqlite-store:shared-state");
  await Promise.all([agent.started, shared.started]);

  agent.endpoint.retiring("idle_timeout");
  await agent.endpoint.terminate();
  expect(await agent.exited).toEqual({ code: 0, error: undefined });
  expect(shared.endpoint.executionStopped).toBe(false);
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);

  shared.endpoint.retiring("idle_timeout");
  await shared.endpoint.terminate();
  expect(await shared.exited).toEqual({ code: 0, error: undefined });
  // The last endpoint's retirement joins the physical host, so the native source can close.
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);
  await closeDefaultRetainedNativeWorkerSource();
  expect(
    getTrackedWorkerPoolSnapshot().workerCensus.some(
      (row) => row.kind === "shared-worker-host.worker.js",
    ),
  ).toBe(false);
});

it("lets a synchronous caller observe physical host termination", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const agent = carrier("sqlite-store:agent");
  await agent.started;
  agent.endpoint.retiring("cancelled");
  const stop = agent.endpoint.stop();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 10_000;
  // Retained consumers drive stops without returning to the event loop.
  while (stop.read().status === "pending" && performance.now() < deadline) {
    stop.service();
    Atomics.wait(pause, 0, 0, 2);
  }
  expect(stop.read().status).toBe("fulfilled");
  expect(agent.endpoint.executionStopped).toBe(true);
  expect(agent.endpoint.terminalFailure?.message).toMatch(/^Shared worker host failed:/);
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "linux")(
  "releases a hosted reader's native handles on a logical stop while the host stays up",
  async () => {
    initializeGatewayResourceProfile({ profile: "lean" });
    const root = tempDirs.make("openclaw-shared-host-reader-");
    mkdirSync(root, { recursive: true });
    const file = path.join(root, "state.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec(
      "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '1', 1)",
    );
    seed.close();
    const handles = () =>
      readdirSync("/proc/self/fd").filter((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`) === file;
        } catch {
          return false;
        }
      });
    // A sibling keeps the physical host alive across the reader's logical stop.
    const sibling = carrier("sqlite-store:agent");
    await sibling.started;
    const pool = createOwnedWorkerTaskPool(
      { workerUrl: resolveRuntimeProcessEntrypointUrl("stateRead"), maxWorkers: 1 },
      { databaseAccess: "read-only" },
    );
    try {
      await pool.run(
        {
          databasePath: file,
          location: file,
          context: { environment: { OPENCLAW_STATE_DIR: root } },
          command: { type: "nodeHost.config" },
          checkFreshAdmission: false,
        },
        {},
      );
      // One descriptor is the hosted reader's; the main thread's admission record holds another.
      const opened = handles().length;
      expect(opened).toBeGreaterThanOrEqual(2);
      await pool.rotate();
      expect(sibling.endpoint.executionStopped).toBe(false);
      expect(handles()).toHaveLength(opened - 1);
    } finally {
      await pool.close();
    }
  },
);

it("fails endpoints and frees the slot when the host constructor is refused", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const previous = process.env.NODE_OPTIONS;
  // Node refuses a Worker whose inherited NODE_OPTIONS are invalid; no native Worker exists.
  process.env.NODE_OPTIONS = "--openclaw-invalid-shared-host-option";
  let agent: ReturnType<typeof carrier>;
  try {
    agent = carrier("sqlite-store:agent");
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previous;
    }
  }
  const outcome = await agent.exited;
  expect(outcome.code).not.toBe(0);
  expect(outcome.error?.message).toMatch(/^Shared worker host failed:/);
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);
});

it("charges hosted endpoints once while reserving dedicated same-kind slots", async () => {
  initializeWorkerMemoryBudget(initializeGatewayResourceProfile({ profile: "lean" }), {
    memoryBudgetMiB: 8192,
  });
  const host = createWorkerTaskHost();
  const owners = [{}, {}];
  const budgets = [];
  const urls = ["sessionTranscript", "pluginModelCatalogRead"] as const;
  for (const [index, name] of urls.entries()) {
    const url = resolveRuntimeProcessEntrypointUrl(name);
    const owner = owners[index]!;
    const budget = createWorkerPoolMemoryBudget(owner, url, 2)!;
    budgets.push(budget);
    const pending = getWorkerMemoryBudgetSnapshot()!;
    expect(pending.floorBytes - pending.baselineBytes).toBeGreaterThanOrEqual(90 * 1024 ** 2);
    const { worker } = host.createWorker(url, {});
    if (!isHostedWorkerEndpoint(worker)) {
      throw new Error("Expected a hosted endpoint in the qualified lean runtime");
    }
    live.add(worker);
    host.workerStarted(worker, owner, 2, {}, {});
    await new Promise<void>((resolve) => {
      worker.once("started", resolve);
    });
    expect(budget.floor).toBe(1);
  }
  const agent = carrier(sharedHostSqliteKeys.agent);
  const shared = carrier(sharedHostSqliteKeys["shared-state"]);
  await Promise.all([agent.started, shared.started]);
  const snapshot = getWorkerMemoryBudgetSnapshot()!;
  // Four logical endpoints share 90 MiB; the native lifecycle supervisor adds 10 MiB.
  expect(snapshot.floorBytes - snapshot.baselineBytes).toBe((90 + 10) * 1024 ** 2);
  expect(snapshot).toMatchObject({ pendingBytes: 0, growthAdmissions: 0 });
  expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
    workerCount: 2,
    workerCensus: expect.arrayContaining([
      expect.objectContaining({
        kind: "shared-worker-host.worker.js",
        count: 1,
        hostedEndpoints: 4,
      }),
      expect.objectContaining({ kind: "worker-native-lifecycle.worker.js", count: 1 }),
    ]),
  });
  // Another pool of the same kind cannot claim the occupied endpoint's discount.
  const dedicated = {};
  createWorkerPoolMemoryBudget(
    dedicated,
    resolveRuntimeProcessEntrypointUrl("sessionTranscript"),
    2,
  );
  const mixed = getWorkerMemoryBudgetSnapshot()!;
  expect(mixed.floorBytes - mixed.baselineBytes).toBe((90 + 10 + 38) * 1024 ** 2);
  expect(mixed.pendingBytes).toBe(38 * 1024 ** 2);
  const original = budgets[0]!;
  expect(original.admitGrowth()).toBe(true);
  expect(getWorkerMemoryBudgetSnapshot()!.pendingBytes).toBe(76 * 1024 ** 2);
  original.releaseGrowth(1);

  // A failing host stays physically reserved through join and replacement.
  agent.endpoint.retiring("cancelled");
  const stopped = agent.endpoint.terminate();
  const exiting = getWorkerMemoryBudgetSnapshot()!;
  expect(exiting.floorBytes - exiting.baselineBytes).toBe((90 + 10 + 38) * 1024 ** 2);
  await stopped;
  const replacement = carrier(sharedHostSqliteKeys.agent);
  await replacement.started;
  expect(owners).toHaveLength(2);
  expect(dedicated).toEqual({});
  const replaced = getWorkerMemoryBudgetSnapshot()!;
  expect(replaced.floorBytes - replaced.baselineBytes).toBe((90 + 10 + 38) * 1024 ** 2);
  expect(getTrackedWorkerPoolSnapshot().workerCensus).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "shared-worker-host.worker.js",
        count: 1,
        hostedEndpoints: 1,
      }),
    ]),
  );
});

it("settles a retried stop that was rejected before the host joined", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const agent = carrier("sqlite-store:agent");
  await agent.started;
  // The supervisor could not confirm exit, then the physical join arrived later.
  agent.endpoint.retiring("cancelled");
  const first = agent.endpoint.stop();
  agent.endpoint.rejectStop(new Error("synthetic supervisor loss"));
  expect(first.read().status).toBe("rejected");
  agent.endpoint.finish(1, new Error("synthetic join"));
  expect(agent.endpoint.stop().read().status).toBe("fulfilled");
});
