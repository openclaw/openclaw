import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
} from "../loading/workspace-skill-sources.js";
import { resolveSkillFileHost } from "../skill-file-host.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import * as remoteRefresh from "./refresh-remote.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import * as refresh from "./refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const releases: Array<() => void> = [];
const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await refresh.closeSkillsWatchers(true);
    } finally {
      releases.splice(0).forEach((release) => release());
      resetGatewayWorkAdmission();
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      cleanup();
    }
  }),
);
let fixtureRoot: string;
const fixture = {
  get workspaceDir() {
    return path.join(fixtureRoot, "workspace");
  },
  async createFixtureDirectory(relative: string) {
    const directory = path.join(fixtureRoot, relative);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  },
};
beforeEach(async () => {
  fixtureRoot = temporary.make("skills-workspace-");
  await fixture.createFixtureDirectory("workspace/skills");
  vi.stubEnv("OPENCLAW_STATE_DIR", await fixture.createFixtureDirectory("state"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

async function waitForSkillsTurn() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

it("retires remote subscriptions during Gateway drain and reacquires after runtime reset", async () => {
  const { params, subscriptions, access, gateway } = await remoteFixture();
  await resolveReusableWorkspaceSkillSnapshot(params);
  const original = subscriptions[0]!;
  const version = getSkillsSnapshotVersion(gateway);

  markGatewayRestartDraining("stop (SIGTERM)");
  expect(original.signal.aborted).toBe(true);
  original.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  await refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  await access.watchSkills.mock.results[0]!.value;
  await waitForSkillsTurn();
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);

  // Teardown joins the retired transport; the next runtime gets a fresh signal.
  await refresh.closeSkillsWatchers(true);
  resetGatewayWorkAdmission();
  await refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(2);
  expect(subscriptions[1]!.signal.aborted).toBe(false);
  const restartedVersion = getSkillsSnapshotVersion(gateway);
  original.emit("unavailable");
  expect(getSkillsSnapshotVersion(gateway)).toBe(restartedVersion);
  subscriptions[1]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBeGreaterThan(restartedVersion);
});

it("waits for an agent's remote skills subscription to close before deletion completes", async () => {
  const { params, access } = await remoteFixture();
  const closeStarted = createDeferred();
  const releaseClose = createDeferred();
  access.watchSkills.mockImplementation(async (_request, _emit, signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          closeStarted.resolve();
          resolve();
        },
        { once: true },
      );
    });
    await releaseClose.promise;
  });
  await refresh.ensureSkillsWatcher({ ...params, agentId: "worker" });
  const drain = refresh.closeSkillsWatchersForAgent({ agentId: "worker" });
  try {
    await awaitGateBeforeSettlement(
      closeStarted.promise,
      drain,
      "Agent drainage completed before remote watcher cancellation began",
    );
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await waitForSkillsTurn();
    expect(drained).toBe(false);
  } finally {
    releaseClose.resolve();
  }
  await drain;
});

it("keeps a shared remote subscription until its last agent owner is removed", async () => {
  const { params, subscriptions, access } = await remoteFixture();
  await refresh.ensureSkillsWatcher({ ...params, agentId: "first" });
  await refresh.ensureSkillsWatcher({ ...params, agentId: "second" });
  expect(access.watchSkills).toHaveBeenCalledTimes(1);

  await refresh.closeSkillsWatchersForAgent({ agentId: "first" });
  expect(subscriptions[0]?.signal.aborted).toBe(false);

  await refresh.closeSkillsWatchersForAgent({ agentId: "second" });
  expect(subscriptions[0]?.signal.aborted).toBe(true);
});

async function remoteFixture(options: { finishOnAbort?: boolean } = {}) {
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
    loadSkills: vi.fn(async (_request: WorkspaceSkillSourceRequest) =>
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
          if (options.finishOnAbort !== false) {
            signal.addEventListener("abort", () => end(), { once: true });
          }
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

it("bounds remote subscriptions by recent access and invalidates evicted source readmission", async () => {
  const { gateway, access, subscriptions } = await remoteFixture();
  const sourcePlan = resolveWorkspaceSkillSourcePlan(gateway, { workspaceOnly: true });
  const ensure = (index: number) =>
    remoteRefresh.ensureRemoteSkillsWatcher({
      watcherKey: `remote-${index}`,
      workspaceDir: gateway,
      executionWorkspaceDir: `/remote/workspace-${index}`,
      access,
      sourcePlan,
    });
  for (let index = 0; index < 128; index++) {
    await ensure(index);
  }
  await ensure(0);
  await ensure(128);
  expect(access.watchSkills).toHaveBeenCalledTimes(129);
  expect(subscriptions[0]!.signal.aborted).toBe(false);
  expect(subscriptions[1]!.signal.aborted).toBe(true);
  expect(subscriptions.filter(({ signal }) => !signal.aborted)).toHaveLength(128);

  const evictedVersion = getSkillsSnapshotVersion(gateway);
  subscriptions[1]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(evictedVersion);
  await ensure(1);
  expect(getSkillsSnapshotVersion(gateway)).toBeGreaterThan(evictedVersion);
  expect(subscriptions[2]!.signal.aborted).toBe(true);
  expect(access.watchSkills).toHaveBeenCalledTimes(130);
  expect(subscriptions.filter(({ signal }) => !signal.aborted)).toHaveLength(128);
});

it("joins remote replacement, disposal, and shutdown before releasing their callers", async () => {
  const fixtureOptions = { finishOnAbort: false };
  const { gateway, access, subscriptions } = await remoteFixture(fixtureOptions);
  const params = {
    watcherKey: JSON.stringify([gateway, undefined, undefined]),
    workspaceDir: gateway,
    access,
    sourcePlan: resolveWorkspaceSkillSourcePlan(gateway, { workspaceOnly: true }),
  };
  try {
    await remoteRefresh.ensureRemoteSkillsWatcher(params);
    let replaced = false;
    const replacement = Promise.resolve(
      remoteRefresh.ensureRemoteSkillsWatcher({
        ...params,
        executionWorkspaceDir: "/remote/replacement",
      }),
    ).then(() => {
      replaced = true;
    });
    await waitForSkillsTurn();
    expect(subscriptions[0]!.signal.aborted).toBe(true);
    expect(replaced).toBe(false);
    expect(access.watchSkills).toHaveBeenCalledTimes(1);
    const retiredVersion = getSkillsSnapshotVersion(gateway);
    subscriptions[0]!.emit("unavailable");
    expect(getSkillsSnapshotVersion(gateway)).toBe(retiredVersion);
    subscriptions[0]!.end();
    await replacement;
    expect(access.watchSkills).toHaveBeenCalledTimes(2);

    let disposed = false;
    const disposal = refresh
      .ensureSkillsWatcher({
        workspaceDir: gateway,
        sourcePlan: params.sourcePlan,
        config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
      })
      .then(() => {
        disposed = true;
      });
    await waitForSkillsTurn();
    expect(subscriptions[1]!.signal.aborted).toBe(true);
    expect(disposed).toBe(false);
    subscriptions[1]!.end();
    await disposal;

    await remoteRefresh.ensureRemoteSkillsWatcher(params);
    let closed = false;
    const closing = remoteRefresh.closeRemoteSkillsWatchers().then(() => {
      closed = true;
    });
    await waitForSkillsTurn();
    expect(subscriptions[2]!.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    subscriptions[2]!.end();
    await closing;
  } finally {
    fixtureOptions.finishOnAbort = true;
    subscriptions.forEach(({ end }) => end());
  }
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

it("publishes initial availability and completed skill changes through the worker wire", async () => {
  const workspace = await fixture.createFixtureDirectory("watch-worker");
  await writeSkill({
    dir: path.join(workspace, "skills/guide"),
    name: "guide",
    description: "Worker content",
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: unknown[] = [];
  const ready = createDeferred();
  const changed = createDeferred();
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message: unknown = JSON.parse(line);
      messages.push(message);
      if (message === "available") {
        ready.resolve();
      } else if (message === "change") {
        changed.resolve();
      }
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
  await ready.promise;
  expect(messages).toContain("available");
  await writeSkill({
    dir: path.join(workspace, "skills/guide"),
    name: "guide",
    description: "Later worker edit",
  });
  await refresh.refreshSkillsDiscovery({ workspaceDir: workspace });
  await changed.promise;
  expect(messages).toContain("change");
  input.end();
  await task;
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
  await write("Updated Workshop instructions");
  await refresh.refreshSkillsDiscovery({ workspaceDir: gateway, reason: "workshop" });
  const updated = await resolveReusableWorkspaceSkillSnapshot({
    ...request,
    existingSnapshot: first.snapshot,
  });
  expect(updated.snapshot.prompt).toContain("Updated Workshop instructions");
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  expect(subscriptions[0]!.signal.aborted).toBe(false);
  await refresh.ensureSkillsWatcher({
    ...request,
    config: { ...config, skills: { load: { watch: false } } },
  });
  expect(subscriptions[0]!.signal.aborted).toBe(true);
});

it("reacquires a closed transport and rejects late events after binding retirement", async () => {
  const { params, gateway, subscriptions, access, release } = await remoteFixture();
  await refresh.ensureSkillsWatcher(params);
  subscriptions[0]!.end();
  await waitForSkillsTurn();
  await refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(2);
  const version = getSkillsSnapshotVersion(gateway);
  subscriptions[0]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  release();
  expect(subscriptions[1]!.signal.aborted).toBe(true);
  subscriptions[1]!.emit("change");
  expect(getSkillsSnapshotVersion(gateway)).toBe(version);
  await refresh.closeSkillsWatchers();
  await expect(refresh.ensureSkillsWatcher(params)).rejects.toThrow("Workspace access is stopped");
});

it("joins accepted stdout writes after retiring skill discovery", async () => {
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
    input.end();
    await retired.promise;
    await waitForSkillsTurn();
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

it("keeps canonical Gateway roots local through discovery, refresh, and host changes", async () => {
  const { params, access, release } = await remoteFixture();
  const canonical = await fixture.createFixtureDirectory("canonical-project");
  const projectRoot = path.join(canonical, "skills");
  await writeSkill({
    dir: path.join(projectRoot, "guide"),
    name: "guide",
    description: "Lower precedence project",
  });
  const project = path.join(projectRoot, "project");
  await writeSkill({ dir: project, name: "project", description: "Original project instructions" });
  const canonicalParams = {
    ...params,
    executionWorkspaceDir: canonical,
    executionWorkspaceFileHost: "gateway" as const,
  };
  let snapshot = (await resolveReusableWorkspaceSkillSnapshot(canonicalParams)).snapshot;
  expect(snapshot.resolvedSkills?.find((skill) => skill.name === "guide")?.description).toBe(
    "Original host instructions",
  );
  const projectSkill = snapshot.resolvedSkills?.find((skill) => skill.name === "project");
  expect(projectSkill).toMatchObject({ filePath: path.join(project, "SKILL.md") });
  expect(resolveSkillFileHost(projectSkill!)).toBe("gateway");
  expect(access.loadSkills.mock.lastCall?.[0].executionWorkspaceDir).toBeUndefined();
  expect(access.watchSkills.mock.lastCall?.[0].executionWorkspaceDir).toBeUndefined();
  await writeSkill({ dir: project, name: "project", description: "Changed project instructions" });
  await refresh.refreshSkillsDiscovery({ workspaceDir: params.workspaceDir });
  snapshot = (
    await resolveReusableWorkspaceSkillSnapshot({ ...canonicalParams, existingSnapshot: snapshot })
  ).snapshot;
  expect(snapshot.prompt).toContain("Changed project instructions");
  // A remote explicit path with identical text is a different source identity.
  const remote = await resolveReusableWorkspaceSkillSnapshot({
    ...params,
    executionWorkspaceDir: canonical,
    existingSnapshot: snapshot,
  });
  expect(remote.shouldRefresh).toBe(true);
  expect(access.loadSkills.mock.lastCall?.[0].executionWorkspaceDir).toBe(canonical);
  expect(access.watchSkills.mock.lastCall?.[0].executionWorkspaceDir).toBe(canonical);
  release();
  await expect(
    resolveReusableWorkspaceSkillSnapshot({ ...canonicalParams, existingSnapshot: snapshot }),
  ).rejects.toThrow("stopped or not ready");
});
