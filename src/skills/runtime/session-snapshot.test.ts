import path from "node:path";
// Session snapshot tests cover runtime skill state captured for agent sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillSnapshot } from "../types.js";

const TEST_WORKSPACE_DIR = path.resolve("/tmp/workspace");

type SnapshotFixture = {
  prompt: string;
  skills: unknown[];
  resolvedSkills: unknown[];
  version?: number;
};
type SnapshotBuildOptions = NonNullable<
  Parameters<typeof import("../loading/workspace-skill-prompt.js").buildSkillSnapshot>[1]
>;

function strippedSnapshot(skillName = "test", version = 1): SkillSnapshot {
  return {
    prompt: "skills prompt",
    skills: [{ name: skillName }],
    version,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn<
    (workspaceDir: string, opts: SnapshotBuildOptions) => SnapshotFixture | Promise<SnapshotFixture>
  >(() => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 1),
  shouldRefreshSnapshotForVersionMock: vi.fn((cached = 0, next = 0) =>
    next === 0 ? cached > 0 : cached < next,
  ),
}));

vi.mock("../loading/workspace-skill-prompt.js", () => ({
  buildSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("./refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("./refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

let resolveReusableWorkspaceSkillSnapshot: typeof import("./session-snapshot.js").resolveReusableWorkspaceSkillSnapshot;

describe("resolveReusableWorkspaceSkillSnapshot", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js"));
    vi.clearAllMocks();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    ensureSkillsWatcherMock.mockImplementation(() => undefined);
    getSkillsSnapshotVersionMock.mockReturnValue(1);
    shouldRefreshSnapshotForVersionMock.mockImplementation((cached = 0, next = 0) =>
      next === 0 ? cached > 0 : cached < next,
    );
  });

  it("reuses prepared plugin metadata for watcher reconciliation and skill loading", async () => {
    const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      executionWorkspaceDir: "/tmp/execution",
      config: {},
      pluginMetadataSnapshot,
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      TEST_WORKSPACE_DIR,
      expect.objectContaining({ pluginMetadataSnapshot }),
    );
    expect(ensureSkillsWatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot }),
    );
  });

  it("reuses complete cached snapshots for fresh sessions until the snapshot version changes", async () => {
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "cached skills prompt",
      skills: [{ name: "cached-skill" }],
      resolvedSkills: [{ name: "cached-skill" }],
    });
    const params = { workspaceDir: TEST_WORKSPACE_DIR, config: {} };

    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    const second = await resolveReusableWorkspaceSkillSnapshot(params);

    expect(second.snapshot).toBe(first.snapshot);
    expect(second.snapshot.prompt).toBe("cached skills prompt");
    expect(second.snapshot.skills).toEqual([{ name: "cached-skill" }]);
    expect(second.snapshot.resolvedSkills).toEqual([{ name: "cached-skill" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();

    getSkillsSnapshotVersionMock.mockReturnValue(2);
    await resolveReusableWorkspaceSkillSnapshot(params);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("reuses cached resolvedSkills across calls with the same workspace, version, and filter", async () => {
    const snapshot = strippedSnapshot();

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: snapshot,
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: { ...snapshot },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds for a live caller after an abandoned preparation drains", async () => {
    const probe = createDeferred();
    const cancelled = createDeferred();
    const drain = createDeferred();
    const events: string[] = [];
    const controller = new AbortController();
    const reason = new Error("first preparation cancelled");
    buildWorkspaceSkillSnapshotMock.mockImplementation(() => {
      events.push("rebuilt");
      return { prompt: "live snapshot", skills: [{ name: "visible" }], resolvedSkills: [] };
    });
    buildWorkspaceSkillSnapshotMock.mockImplementationOnce(async (_workspace, options) => {
      await probe.promise;
      try {
        options.assertCurrent?.();
      } catch (error) {
        events.push("cancelled");
        cancelled.resolve();
        await drain.promise;
        events.push("drained");
        throw error;
      }
      throw new Error("fixture expected preparation cancellation");
    });
    const params = { workspaceDir: TEST_WORKSPACE_DIR, config: {}, watch: false };
    const first = resolveReusableWorkspaceSkillSnapshot({
      ...params,
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const firstRejected = expect(first).rejects.toBe(reason);
    controller.abort(reason);
    probe.resolve();
    await cancelled.promise;

    const second = resolveReusableWorkspaceSkillSnapshot(params);
    const secondResolved = expect(second).resolves.toMatchObject({
      snapshot: { prompt: "live snapshot", skills: [{ name: "visible" }] },
    });
    drain.resolve();
    await Promise.all([firstRejected, secondResolved]);
    expect(events).toEqual(["cancelled", "drained", "rebuilt"]);
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toBe(
      (await second).snapshot,
    );
  });

  it("propagates a shared build failure to callers that remain current", async () => {
    const build = createDeferred<SnapshotFixture>();
    const reason = new Error("skill source unavailable");
    buildWorkspaceSkillSnapshotMock.mockReturnValue(build.promise);
    const params = { workspaceDir: TEST_WORKSPACE_DIR, config: {}, watch: false };
    const firstRejected = expect(resolveReusableWorkspaceSkillSnapshot(params)).rejects.toBe(
      reason,
    );
    const secondRejected = expect(resolveReusableWorkspaceSkillSnapshot(params)).rejects.toBe(
      reason,
    );

    build.reject(reason);
    await Promise.all([firstRejected, secondRejected]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
  });

  it("does not repeat watcher fallback invalidation when concurrent preparations retry", async () => {
    let version = 1;
    ensureSkillsWatcherMock.mockImplementation(() => {
      version += 1;
    });
    getSkillsSnapshotVersionMock.mockImplementation(() => version);
    const firstBuild = createDeferred();
    const secondBuild = createDeferred();
    const builds = [firstBuild, secondBuild];
    buildWorkspaceSkillSnapshotMock.mockImplementation(async (_workspace, options) => {
      await builds.shift()?.promise;
      return {
        prompt: `snapshot version ${options.snapshotVersion}`,
        skills: [],
        resolvedSkills: [],
        version: options.snapshotVersion,
      };
    });
    const params = { workspaceDir: TEST_WORKSPACE_DIR, config: {} };
    const first = resolveReusableWorkspaceSkillSnapshot({ ...params, skillFilter: ["first"] });
    const second = resolveReusableWorkspaceSkillSnapshot({ ...params, skillFilter: ["second"] });

    firstBuild.resolve();
    const firstResult = await first;
    secondBuild.resolve();
    const secondResult = await second;
    for (const result of [firstResult, secondResult]) {
      expect(result.snapshotVersion).toBe(3);
      expect(result.snapshot).toMatchObject({ prompt: "snapshot version 3", version: 3 });
    }
    expect(version).toBe(3);
  });

  it("invalidates cached resolvedSkills when skillFilter changes", async () => {
    const snapshot = strippedSnapshot();

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: snapshot,
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      skillFilter: ["new-filter"],
      existingSnapshot: {
        ...snapshot,
        skillFilter: ["old-filter"],
      },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes when effective node-skill eligibility changes", async () => {
    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      eligibility: { nodeSkills: { canExec: false } },
      existingSnapshot: {
        ...strippedSnapshot(),
        nodeSkillsEligibility: { canExec: true, node: "build-node" },
      },
    });

    expect(result.shouldRefresh).toBe(true);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("reads the skills snapshot version after watcher-side invalidation", async () => {
    getSkillsSnapshotVersionMock.mockReturnValue(1);
    ensureSkillsWatcherMock.mockImplementation(() => {
      getSkillsSnapshotVersionMock.mockReturnValue(5);
    });

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { skills: { load: { extraDirs: ["/tmp/shared-skills"] } } },
      existingSnapshot: strippedSnapshot("test", 1),
    });

    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(1, 5);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(5);
  });

  it("refreshes persisted version-0 snapshots after process restart", async () => {
    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: strippedSnapshot("test", 0),
    });

    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(0, 1);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(1);
  });

  it("refreshes persisted timestamp-version snapshots from earlier processes", async () => {
    getSkillsSnapshotVersionMock.mockReturnValue(10_000);

    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: strippedSnapshot("test", 9_999),
    });

    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(9_999, 10_000);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(10_000);
  });

  it("invalidates cached resolvedSkills when non-skills config gates change", async () => {
    buildWorkspaceSkillSnapshotMock.mockImplementation((_workspaceDir, opts) => {
      const config = (opts as { config?: { channels?: { discord?: { token?: string } } } }).config;
      return {
        prompt: "",
        skills: [],
        resolvedSkills: config?.channels?.discord?.token ? [{ name: "discord" }] : [],
      };
    });

    const snapshot = strippedSnapshot("discord");

    const first = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: { token: "enabled" } } } as OpenClawConfig,
      existingSnapshot: snapshot,
    });

    expect(first.snapshot.resolvedSkills).toEqual([{ name: "discord" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const second = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: {} } } as OpenClawConfig,
      existingSnapshot: { ...snapshot },
    });

    expect(second.snapshot.resolvedSkills).toEqual([]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secret values in the cache key while preserving eligibility presence", async () => {
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [{ name: "discord" }],
    });

    const snapshot = strippedSnapshot("discord");

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: { token: "first-secret" } } } as OpenClawConfig,
      existingSnapshot: snapshot,
    });

    await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: { token: "rotated-secret" } } } as OpenClawConfig,
      existingSnapshot: { ...snapshot },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes persisted snapshots missing the current prompt format marker", async () => {
    ensureSkillsWatcherMock.mockImplementation(() => undefined);
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    const oldSnapshot = {
      ...strippedSnapshot(),
      version: 5,
      promptFormatVersion: undefined,
    };

    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: oldSnapshot,
    });

    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(5, 0);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(0);
  });

  it("refreshes snapshots from before config-key skill identities", async () => {
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: {
        ...strippedSnapshot(),
        promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION - 1,
      },
    });

    expect(result.shouldRefresh).toBe(true);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
