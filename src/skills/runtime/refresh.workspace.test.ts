import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
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
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const observer = createSkillsWatcherMock();
const { watchMock } = observer;
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMock }));
const fixture = useSkillsWatcherFixture(observer);
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
  observer.subscriptions.length = 0;
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
  await observer.readyAll();
  expect(
    observer.subscriptions.some((entry) =>
      entry.options.scopes.some(
        (scope) =>
          path.resolve(entry.authority.rootDir, scope.path) ===
          path.join(params.workspaceDir, "skills"),
      ),
    ),
  ).toBe(false);
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

it("carries observation unavailability and recovery through the worker wire and joins termination", async () => {
  const workspace = await fixture.createFixtureDirectory("watch-worker");
  await writeSkill({
    dir: path.join(workspace, "skills/guide"),
    name: "guide",
    description: "Worker content",
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: unknown[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      messages.push(JSON.parse(line));
    }
  });
  const task = serveWorkspaceSkills({
    workspace,
    home: workspace,
    operation: "watch",
    input,
    output,
  });
  input.write(
    JSON.stringify({
      sourcePlan: resolveWorkspaceSkillSourcePlan(workspace, { workspaceOnly: true }),
    }) + "\n",
  );
  await waitForSkillsWatcherTurn();
  await observer.readyAll();
  const original = observer.forRoot(path.join(workspace, "skills"));
  original.fail(new Error("read failure"));
  expect(messages).toContain("unavailable");
  await original.close();
  await waitForSkillsWatcherTurn();
  await observer.readyAll();
  expect(messages).toContain("available");
  await writeSkill({
    dir: path.join(workspace, "skills/guide"),
    name: "guide",
    description: "Later worker edit",
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  observer
    .forRoot(path.join(workspace, "skills"))
    .change(path.join(workspace, "skills/guide/SKILL.md"));
  await vi.advanceTimersByTimeAsync(250);
  expect(messages).toContain("change");
  input.end();
  await task;
  expect(observer.subscriptions.every((entry) => entry.closed)).toBe(true);
  output.destroy();
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
  await observer.readyAll();
  await write("Updated Workshop instructions");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const watcher = observer.forRoot(workshop);
  watcher.change(path.join(workshop, "authored", "SKILL.md"));
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
  await waitForSkillsWatcherTurn();
  refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(2);
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

it("joins accepted stdout writes after retiring Skills observation", async () => {
  const workspace = await fixture.createFixtureDirectory("skills-watch-stdout");
  const input = new PassThrough();
  const written = createDeferred();
  const retired = createDeferred();
  let blocked = true;
  const callbacks: Array<(error?: Error | null) => void> = [];
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      written.resolve();
      if (blocked) {
        callbacks.push(callback);
      } else {
        callback();
      }
    },
  });
  const originalClose = refresh.closeSkillsWatchers;
  vi.spyOn(refresh, "closeSkillsWatchers").mockImplementation((...args) => {
    const pending = originalClose(...args);
    void pending.then(retired.resolve, retired.reject);
    return pending;
  });
  const worker = serveWorkspaceSkills({
    workspace,
    home: workspace,
    operation: "watch",
    input,
    output,
  });
  let finished = false;
  void worker.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    input.write(
      JSON.stringify({
        sourcePlan: resolveWorkspaceSkillSourcePlan(workspace, { workspaceOnly: true }),
      }) + "\n",
    );
    await written.promise;
    expect(output.writableNeedDrain).toBe(true);
    await observer.readyAll();
    input.end();
    await retired.promise;
    await waitForSkillsWatcherTurn();
    expect(observer.subscriptions.every((entry) => entry.closed)).toBe(true);
    expect(finished).toBe(false);
    blocked = false;
    callbacks.splice(0).forEach((callback) => callback());
    await worker;
    expect(output.writableLength).toBe(0);
  } finally {
    blocked = false;
    callbacks.splice(0).forEach((callback) => callback());
    input.end();
    await worker;
    output.destroy();
  }
});
