import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import {
  loadWorkspaceSkills,
  readWorkspaceSkillSources,
} from "../loading/workspace-skill-loader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
} from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const { createdWatchers, watchMock, nativeWatchMock, nativeContentWatchMock, watchForSkillRoot } =
  createSkillsWatcherMock();
vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
vi.mock("./refresh-content-native.js", () => ({
  createNativeSkillsContentWatcher: nativeContentWatchMock,
}));

const { shouldUseNativeSkillsWatcher } = await import("./refresh-watch-transport.js");

const fixture = useSkillsWatcherFixture();
let resolveReusableWorkspaceSkillSnapshot: typeof import("./session-snapshot.js").resolveReusableWorkspaceSkillSnapshot;
let refresh: typeof import("./refresh.js");
const releases: Array<() => void> = [];
beforeAll(async () => {
  refresh = await import("./refresh.js");
  ({ resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js"));
});
afterEach(() => {
  resetGatewayWorkAdmission();
  releases.splice(0).forEach((release) => release());
  watchMock.mockClear();
  createdWatchers.length = 0;
});

it("retires remote subscriptions during Gateway drain and reacquires after runtime reset", async () => {
  const { params, subscriptions, access, gateway } = await remoteFixture();
  await resolveReusableWorkspaceSkillSnapshot(params);
  const original = subscriptions[0]!;
  const version = getSkillsSnapshotVersion(gateway);

  markGatewayRestartDraining("stop (SIGTERM)");
  expect(original.signal.aborted).toBe(true);
  original.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  await access.watchSkills.mock.results[0]!.value;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);

  // Teardown joins the retired transport; the next runtime gets a fresh signal.
  await refresh.closeSkillsWatchers(true);
  resetGatewayWorkAdmission();
  refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(2);
  expect(subscriptions[1]!.signal.aborted).toBe(false);
  const restartedVersion = getSkillsSnapshotVersion(gateway);
  original.emit("unavailable");
  expect(getSkillsSnapshotVersion(gateway)).toBe(restartedVersion);
  subscriptions[1]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBeGreaterThan(restartedVersion);
});
afterEach(() => vi.unstubAllEnvs());

async function remoteFixture() {
  const gateway = fixture.workspaceDir;
  const host = await fixture.createFixtureDirectory("host");
  const writes = (description: string) =>
    writeSkill({
      dir: path.join(host, "skills", "guide"),
      name: "guide",
      description,
    });
  await writes("Original host instructions");
  const subscriptions: Array<{
    emit: (event: "change" | "unavailable" | "available") => void;
    signal: AbortSignal;
    end: () => void;
  }> = [];
  const access = {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: vi.fn(async () =>
      readWorkspaceSkillSources({
        sourcePlan: resolveWorkspaceSkillSourcePlan(host, { workspaceOnly: true }),
        limits: resolveSkillDiscoveryLimits(),
        additionalBins: [],
      }),
    ),
    watchSkills: vi.fn(
      async (
        _request: Pick<WorkspaceSkillSourceRequest, "sourcePlan" | "executionWorkspaceDir">,
        emit: (event: "change" | "unavailable" | "available") => void,
        signal: AbortSignal,
      ) =>
        new Promise<void>((end) => {
          subscriptions.push({ emit, signal, end });
          signal.addEventListener("abort", () => end(), { once: true });
        }),
    ),
  };
  const release = registerAgentWorkspaceAccess(gateway, access);
  const config = { plugins: { enabled: false } };
  releases.push(release);
  return {
    gateway,
    writes,
    subscriptions,
    access,
    release,
    params: { workspaceDir: gateway, config },
  };
}

it("refreshes an existing session from host changes while retaining a healthy snapshot", async () => {
  const { params, writes, subscriptions, access } = await remoteFixture();
  const first = await resolveReusableWorkspaceSkillSnapshot(params);
  expect(first.snapshot.prompt).toContain("Original host instructions");
  expect(
    (await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: first.snapshot }))
      .snapshot,
  ).toBe(first.snapshot);
  await writes("Edited host instructions");
  subscriptions[0]?.emit("change");
  const edited = await resolveReusableWorkspaceSkillSnapshot({
    ...params,
    existingSnapshot: first.snapshot,
  });
  expect(edited.snapshot.prompt).toContain("Edited host instructions");
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  expect(access.loadSkills).toHaveBeenCalledTimes(2);
  expect(
    watchMock.mock.calls.every(([, options]) =>
      options.ignored(path.join(params.workspaceDir, "skills", "stale", "SKILL.md")),
    ),
  ).toBe(true);
});

it("uses native preparation fallback after unavailable watching and cancels on watch:false", async () => {
  const { params, subscriptions, access, writes, gateway } = await remoteFixture();
  const first = await resolveReusableWorkspaceSkillSnapshot(params);
  subscriptions[0]!.emit("unavailable");
  for (const description of ["Second version", "Third version"]) {
    await writes(description);
    const next = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(next.snapshot.prompt).toContain(description);
  }
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  refresh.ensureSkillsWatcher({ ...params, config: { skills: { load: { watch: false } } } });
  expect(subscriptions[0]!.signal.aborted).toBe(true);
  const version = getSkillsSnapshotVersion(gateway);
  subscriptions[0]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
});

it("restores snapshot reuse only on verified availability, without adding a content revision", async () => {
  const { params, subscriptions, access, writes, gateway } = await remoteFixture();
  let snapshot = (await resolveReusableWorkspaceSkillSnapshot(params)).snapshot;
  const subscription = subscriptions[0]!;
  subscription.emit("unavailable");
  await writes("Reconciled during outage");
  subscription.emit("change");
  snapshot = (
    await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot })
  ).snapshot;
  const afterChange = access.loadSkills.mock.calls.length;
  snapshot = (
    await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot })
  ).snapshot;
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 1);
  const version = getSkillsSnapshotVersion(gateway);
  subscription.emit("available");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  expect(
    (await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot }))
      .snapshot,
  ).toBe(snapshot);
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 1);
  await writes("Changed under recovered coverage");
  subscription.emit("change");
  snapshot = (
    await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot })
  ).snapshot;
  expect(snapshot.prompt).toContain("Changed under recovered coverage");
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 2);
  subscription.emit("unavailable");
  await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot });
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 3);
  expect(access.watchSkills).toHaveBeenCalledOnce();
});

it.each(["initial", "replacement"] as const)(
  "carries an unchanged-content %s verification error through the worker into host preparation",
  async (phase) => {
    // Availability is certifiable through owned native handles or pathname polling.
    vi.stubEnv("CHOKIDAR_USEPOLLING", String(!shouldUseNativeSkillsWatcher(false)));
    const workspace = await fixture.createFixtureDirectory("watch-worker");
    const root = path.join(workspace, "skills");
    await writeSkill({
      dir: path.join(root, "guide"),
      name: "guide",
      description: "Stable content",
    });
    expect(
      loadWorkspaceSkills(workspace, { workspaceOnly: true }).map((entry) => entry.skill.name),
    ).toEqual(["guide"]);
    const input = new PassThrough();
    const output = new PassThrough();
    let wire = "";
    output.on("data", (chunk: Buffer) => {
      wire += chunk.toString();
    });
    const messages = () =>
      wire
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
    const task = serveWorkspaceSkills({
      workspace,
      home: workspace,
      operation: "watch",
      input,
      output,
    });
    const outside = await fixture.createFixtureDirectory("worker-linked-skills");
    const sourcePlan = {
      ...resolveWorkspaceSkillSourcePlan(workspace, { workspaceOnly: true }),
      allowSymlinkTargets: [outside],
    };
    input.write(`${JSON.stringify({ sourcePlan })}\n`);
    try {
      await vi.waitFor(() => {
        expect(
          watchMock.mock.calls.some(([watched]) => watched === root.replaceAll("\\", "/")),
        ).toBe(true);
      });
      let active = watchForSkillRoot(root).watcher;
      for (const watcher of createdWatchers) {
        if (watcher !== active) {
          watcher.emit("ready");
        }
      }
      await Promise.resolve();
      active.emit("ready");
      let pending = watchForSkillRoot(root).watcher;
      if (phase === "replacement") {
        pending.emit("ready");
        active = pending;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const expanded = await fixture.createFixtureDirectory("watch-worker/skills/expanded");
        active.emit("all", "addDir", expanded);
        pending = watchForSkillRoot(root).watcher;
        expect(pending).not.toBe(active);
      }
      const version = getSkillsSnapshotVersion(workspace);
      pending.emit("error", Object.assign(new Error("verification read failed"), { code: "EIO" }));
      expect(messages().filter((event) => event === "unavailable")).toEqual(["unavailable"]);
      expect(getSkillsSnapshotVersion(workspace)).toBeGreaterThan(version);
      expect(active.closed).toBe(false);
      expect(pending.closed).toBe(true);
      const count = createdWatchers.length;
      const messageCount = messages().length;
      pending.emit("error", new Error("late verification error"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(createdWatchers).toHaveLength(count);
      expect(messages()).toHaveLength(messageCount);
      await writeSkill({
        dir: path.join(outside, "linked"),
        name: "linked",
        description: "Outage discovery",
      });
      await fs.symlink(
        outside,
        path.join(root, "linked-root"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeSkill({
        dir: path.join(root, "guide"),
        name: "guide",
        description: "Changed during outage",
      });
      vi.useFakeTimers();
      active.emit("all", "change", path.join(root, "guide", "SKILL.md"));
      await vi.advanceTimersByTimeAsync(250);
      vi.useRealTimers();
      expect(messages().slice(messageCount)).toContain("change");
      expect(messages()).not.toContain("available");
      active.emit("all", "addDir", path.join(root, "expanded-again"));
      const recovering = watchForSkillRoot(root).watcher;
      expect(recovering).not.toBe(active);
      recovering.emit("ready");
      // Verified content still has deferred target discovery: the worker must
      // acquire and verify the new symlink target before advertising availability.
      expect(messages()).not.toContain("available");
      await vi.waitFor(() => {
        expect(
          watchMock.mock.calls.some(([watched]) => watched === outside.replaceAll("\\", "/")),
        ).toBe(true);
      });
      // Worker discovery reconciled with its config-less request. Prime the
      // loader's matching symlink policy before coverage becomes available.
      expect(
        loadWorkspaceSkills(workspace, {
          workspaceOnly: true,
          config: { skills: { load: { allowSymlinkTargets: sourcePlan.allowSymlinkTargets } } },
        }).map((entry) => entry.skill.name),
      ).toContain("linked");
      expect(messages()).not.toContain("available");
      const outsideObserver = watchForSkillRoot(outside).watcher;
      for (const watcher of createdWatchers) {
        watcher.emit("ready");
      }
      await waitForSkillsWatcherTurn();
      expect(watchForSkillRoot(outside).watcher).not.toBe(outsideObserver);
      expect(watchForSkillRoot(outside).watcher.closed).toBe(false);
      expect(messages().filter((event) => event === "available")).toEqual(["available"]);
      const restoredCount = messages().length;
      await writeSkill({
        dir: path.join(outside, "linked"),
        name: "linked",
        description: "Changed after recovered coverage",
      });
      vi.useFakeTimers();
      watchForSkillRoot(outside).watcher.emit(
        "all",
        "change",
        path.join(outside, "linked", "SKILL.md"),
      );
      await vi.advanceTimersByTimeAsync(250);
      vi.useRealTimers();
      expect(messages().slice(restoredCount)).toContain("change");
      watchForSkillRoot(root).watcher.emit("error", new Error("later observation failure"));
      expect(messages().at(-1)).toBe("unavailable");
    } finally {
      input.end();
      await task;
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      output.destroy();
      await refresh.closeSkillsWatchers(true);
    }

    // Worker and Gateway own separate processes in production. Retire the worker
    // before feeding its actual wire event into the host-side transport fixture.
    const events = messages().filter(
      (event): event is "change" | "unavailable" | "available" =>
        event === "change" || event === "unavailable" || event === "available",
    );
    const failureIndex = events.indexOf("unavailable");
    const availableIndex = events.indexOf("available");
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(availableIndex).toBeGreaterThan(failureIndex);
    const { params, subscriptions, access, writes } = await remoteFixture();
    let current = (await resolveReusableWorkspaceSkillSnapshot(params)).snapshot;
    for (const event of events.slice(failureIndex, availableIndex)) {
      subscriptions[0]!.emit(event);
    }
    for (const description of ["First later preparation", "Second later preparation"]) {
      await writes(description);
      current = (
        await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: current })
      ).snapshot;
      expect(current.prompt).toContain(description);
    }
    const restoredVersion = getSkillsSnapshotVersion(params.workspaceDir);
    subscriptions[0]!.emit(events[availableIndex]!);
    const loads = access.loadSkills.mock.calls.length;
    expect(
      (await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: current }))
        .snapshot,
    ).toBe(current);
    expect(access.loadSkills).toHaveBeenCalledTimes(loads);
    expect(getSkillsSnapshotVersion(params.workspaceDir)).toBe(restoredVersion);
    const nextChange = events.indexOf("change", availableIndex + 1);
    expect(nextChange).toBeGreaterThan(availableIndex);
    await writes("Post-recovery content");
    subscriptions[0]!.emit(events[nextChange]!);
    current = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: current })
    ).snapshot;
    expect(current.prompt).toContain("Post-recovery content");
    subscriptions[0]!.emit(events.at(-1)!);
    await writes("Second outage content");
    current = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: current })
    ).snapshot;
    expect(current.prompt).toContain("Second outage content");
    expect(access.watchSkills).toHaveBeenCalledOnce();
    refresh.ensureSkillsWatcher({ ...params, config: { skills: { load: { watch: false } } } });
    expect(subscriptions[0]!.signal.aborted).toBe(true);
  },
);

it("refreshes Gateway Workshop edits alongside the existing host subscription", async () => {
  const { params, gateway, access, subscriptions } = await remoteFixture();
  const config = {
    ...params.config,
    agents: { entries: { main: { agentDir: path.join(gateway, "agent") } } },
  };
  const workshop = resolveWorkshopSkillsDir(config, "main");
  const write = (description: string) =>
    writeSkill({ dir: path.join(workshop, "authored"), name: "authored", description });
  await write("Original Workshop instructions");
  const request = { ...params, config, agentId: "main" };
  const first = await resolveReusableWorkspaceSkillSnapshot(request);
  expect(first.snapshot.prompt).toContain("Original Workshop instructions");
  await write("Updated Workshop instructions");
  vi.useFakeTimers();
  const { watcher } = watchForSkillRoot(workshop);
  watcher.emit("all", "change", path.join(workshop, "authored", "SKILL.md"));
  await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  const updated = await resolveReusableWorkspaceSkillSnapshot({
    ...request,
    existingSnapshot: first.snapshot,
  });
  expect(updated.snapshot.prompt).toContain("Updated Workshop instructions");
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  expect(subscriptions[0]!.signal.aborted).toBe(false);
  refresh.ensureSkillsWatcher({
    ...request,
    config: { ...config, skills: { load: { watch: false } } },
  });
  expect(watcher.closed).toBe(true);
  expect(subscriptions[0]!.signal.aborted).toBe(true);
});

it("reacquires a closed transport and rejects late events after binding retirement", async () => {
  const { params, gateway, subscriptions, access, release } = await remoteFixture();
  refresh.ensureSkillsWatcher(params);
  subscriptions[0]!.end();
  await vi.waitFor(() => {
    refresh.ensureSkillsWatcher(params);
    expect(access.watchSkills).toHaveBeenCalledTimes(2);
  });
  const version = getSkillsSnapshotVersion(gateway);
  subscriptions[0]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  release();
  expect(subscriptions[1]!.signal.aborted).toBe(true);
  subscriptions[1]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  await refresh.closeSkillsWatchers();
  expect(() => refresh.ensureSkillsWatcher(params)).toThrow("Workspace access is stopped");
});
