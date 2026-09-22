import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
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
} from "./refresh.watcher.test-support.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const { createdWatchers, watchMock, nativeWatchMock, watchForSkillRoot } =
  createSkillsWatcherMock();
vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
const fixture = useSkillsWatcherFixture();
let resolveReusableWorkspaceSkillSnapshot: typeof import("./session-snapshot.js").resolveReusableWorkspaceSkillSnapshot;
let refresh: typeof import("./refresh.js");
const releases: Array<() => void> = [];
beforeAll(async () => {
  refresh = await import("./refresh.js");
  ({ resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js"));
});
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  watchMock.mockClear();
  createdWatchers.length = 0;
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
    emit: (event: "change" | "unavailable") => void;
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
        emit: (event: "change" | "unavailable") => void,
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

it("carries an unchanged-content verification error through the worker into host preparation", async () => {
  const workspace = await fixture.createFixtureDirectory("watch-worker");
  const root = path.join(workspace, "skills");
  await writeSkill({ dir: path.join(root, "guide"), name: "guide", description: "Stable content" });
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
  const sourcePlan = resolveWorkspaceSkillSourcePlan(workspace, { workspaceOnly: true });
  input.write(`${JSON.stringify({ sourcePlan })}\n`);
  try {
    await vi.waitFor(() => {
      expect(watchMock.mock.calls.some(([watched]) => watched === root.replaceAll("\\", "/"))).toBe(
        true,
      );
    });
    const active = watchForSkillRoot(root).watcher;
    active.emit("ready");
    const pending = watchForSkillRoot(root).watcher;
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
  } finally {
    input.end();
    await task;
    expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
    output.destroy();
    await refresh.closeSkillsWatchers(true);
  }

  // Worker and Gateway own separate processes in production. Retire the worker
  // before feeding its actual wire event into the host-side transport fixture.
  const unavailable = messages().find((event): event is "unavailable" => event === "unavailable");
  expect(unavailable).toBe("unavailable");
  const { params, subscriptions, access, writes } = await remoteFixture();
  let current = (await resolveReusableWorkspaceSkillSnapshot(params)).snapshot;
  subscriptions[0]!.emit(unavailable!);
  for (const description of ["First later preparation", "Second later preparation"]) {
    await writes(description);
    current = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: current })
    ).snapshot;
    expect(current.prompt).toContain(description);
  }
  expect(access.watchSkills).toHaveBeenCalledOnce();
  refresh.ensureSkillsWatcher({ ...params, config: { skills: { load: { watch: false } } } });
  expect(subscriptions[0]!.signal.aborted).toBe(true);
});

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
