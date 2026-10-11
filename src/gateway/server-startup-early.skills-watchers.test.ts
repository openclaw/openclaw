import fs from "node:fs/promises";
import path from "node:path";
import type * as FsSafeWatch from "@openclaw/fs-safe/watch";
import type { WatchOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { expect, it, onTestFinished, vi } from "vitest";
import * as observationSource from "../skills/runtime/refresh-observation-source.js";
import {
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
} from "../skills/runtime/refresh-state.js";
import { pathWatchers } from "../skills/runtime/refresh-watch-registry.js";
import { closeSkillsWatchers, ensureSkillsWatcher } from "../skills/runtime/refresh.js";
import {
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "../skills/runtime/refresh.watcher.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const subscriptions: Array<{
  subscription: WatchSubscription;
  options: WatchOptions;
  retired: boolean;
}> = [];
vi.mock("@openclaw/fs-safe/watch", async () => {
  // Mock factories run before static imports; /root and /watch must share
  // fs-safe's private Root registry.
  const { createRequire } = await import("node:module");
  const actual = createRequire(import.meta.url)("@openclaw/fs-safe/watch") as typeof FsSafeWatch;
  const watch: typeof actual.watch = (root, options) => {
    const subscription = actual.watch(root, {
      ...options,
      mode: "poll",
      pollIntervalMs: 2_147_483_647,
    });
    const observed = { subscription, options, retired: false };
    // Native retirement is the cost: macOS stops each FSEvents stream with a
    // synchronous fseventsd round trip on the JS thread.
    const close = subscription.close.bind(subscription);
    subscription.close = () => {
      observed.retired = true;
      return close();
    };
    subscriptions.push(observed);
    return subscription;
  };
  return { ...actual, watch };
});
// mock-isolation: Startup side runtimes are outside the skills watcher lifecycle.
vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: async () => ({ update: async () => {}, stop: async () => {} }),
}));
// mock-isolation: Machine naming only feeds discovery.
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "Test" }));
// mock-isolation: No remote nodes are connected; local watchers are the subject.
vi.mock("../skills/runtime/remote.js", () => ({
  setSkillsRemoteRegistry: () => {},
  primeRemoteSkillsCache: () => {},
  refreshRemoteBinsForConnectedNodes: async () => {},
}));
// mock-isolation: Cron maintenance timers are outside this lifecycle.
vi.mock("../cron/maintenance.js", () => ({ startCronMaintenance: () => {} }));
// mock-isolation: Installed plugins must not add skill roots to the fixture.
vi.mock("../skills/loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

const fixture = useSkillsWatcherFixture();

async function startEarlyRuntime() {
  const { runDeliveryQueueMediaGc: _runDeliveryQueueMediaGc, ...maintenance } =
    createGatewayMaintenanceStateForTest({
      healthSummary: {} as never,
      healthVersion: 0,
      presenceVersion: 0,
    });
  const scheduler = createTestGatewayScheduler();
  onTestFinished(() => scheduler.stop());
  return await startGatewayEarlyRuntime({
    minimalTestGateway: false,
    isClosing: () => false,
    cfgAtStart: { cron: { enabled: false } } as never,
    port: 18_789,
    gatewayTls: { enabled: false },
    gatewayDirectReachable: false,
    tailscaleMode: "off" as never,
    log: { info: () => {}, warn: () => {} },
    logDiscovery: { info: () => {}, warn: () => {} },
    nodeRegistry: {} as never,
    swapDiscovery: () => null,
    pluginRuntimeClaim: createGatewayPluginRuntimeGeneration({
      getServices: () => null,
      setServices: () => {},
    }).currentClaim(),
    maintenance,
    broadcast: maintenance.broadcast,
    scheduler,
    getRuntimeConfig: () => ({}) as never,
  });
}

async function writeSkill(root: string, name: string) {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(
    path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}

async function watchersStarted(plans: Promise<unknown>[]) {
  await Promise.resolve();
  await Promise.all(
    [...pathWatchers.values()].flatMap((state) => (state.authority ? [state.authority] : [])),
  );
  await Promise.all(plans);
  await waitForSkillsWatcherTurn();
  // Retired subscriptions reject their readiness.
  await Promise.allSettled(subscriptions.map((entry) => entry.subscription.ready));
}

async function watchManyWorktrees() {
  subscriptions.length = 0;
  const plans: Promise<unknown>[] = [];
  const plan = observationSource.skillsObservationScope;
  vi.spyOn(observationSource, "skillsObservationScope").mockImplementation((...args) => {
    const planned = plan(...args);
    plans.push(planned);
    return planned;
  });
  const worktrees: string[] = [];
  for (let tree = 0; tree < 6; tree += 1) {
    const worktree = await fixture.createFixtureDirectory(`worktrees/wt${tree}`);
    for (let skill = 0; skill < 20; skill += 1) {
      await writeSkill(path.join(worktree, "skills", `group${skill % 4}`), `skill${skill}`);
    }
    worktrees.push(worktree);
  }
  const runtime = await startEarlyRuntime();
  for (const executionWorkspaceDir of worktrees) {
    ensureSkillsWatcher({
      workspaceDir: fixture.workspaceDir,
      executionWorkspaceDir,
      agentId: "main",
      config: {},
    });
  }
  await watchersStarted(plans);
  expect(subscriptions).toHaveLength(pathWatchers.size);
  expect(subscriptions.length).toBeGreaterThan(worktrees.length);
  return { runtime, worktrees };
}

it("stops an exiting Gateway without retiring native skills watchers one by one", async () => {
  const { runtime, worktrees } = await watchManyWorktrees();
  const workspaceDir = fixture.workspaceDir;

  await runtime.skillsChangeUnsub({ exitAfterClose: true });

  // Each native retirement is a synchronous fseventsd round trip on macOS.
  expect(subscriptions.filter((entry) => entry.retired)).toHaveLength(0);
  // No observation outlives the stopping Gateway, even from a late callback.
  const changes: unknown[] = [];
  onTestFinished(registerSkillsChangeListener((event) => changes.push(event)));
  const version = getSkillsSnapshotVersion(workspaceDir);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const { options } of subscriptions) {
    options.onInvalidate({ reason: "event" });
    options.onHealth?.({ state: "unavailable", mode: "poll", directories: 0 });
  }
  ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: worktrees[0], agentId: "main" });
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  expect(changes).toEqual([]);
  expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
  expect(pathWatchers.size).toBe(0);

  // The detached subscriptions stay owned: a later close still retires them.
  await closeSkillsWatchers();
  expect(subscriptions.every((entry) => entry.retired)).toBe(true);
});

it("retires every skills watcher when the Gateway process keeps running", async () => {
  const { runtime } = await watchManyWorktrees();

  await runtime.skillsChangeUnsub();

  expect(subscriptions.every((entry) => entry.retired)).toBe(true);
});
