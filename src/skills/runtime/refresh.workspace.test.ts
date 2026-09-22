import path from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-loader.js";
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
