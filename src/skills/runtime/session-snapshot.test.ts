import path from "node:path";
// Session snapshot tests cover runtime skill state captured for agent sessions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillSnapshot } from "../types.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";
import { resolveSkillSnapshotExecutionFileHost } from "./skill-snapshot-provenance.js";

// Start the suite cold so these hoisted mocks also apply after another file loaded the owner.
vi.hoisted(() => {
  vi.resetModules();
});

let workspaceSequence = 0;
let workspaceDir: string;

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
    prompt: `<available_skills>\n  <skill>\n    <name>${skillName}</name>\n    <location>/skills/${skillName}/SKILL.md</location>\n  </skill>\n</available_skills>`,
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
  getSkillsSourceVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

describe("resolveReusableWorkspaceSkillSnapshot", () => {
  beforeEach(() => {
    // Both owner caches key on workspaceDir; keep reuse within a case without sharing its state.
    // Loading and watching are mocked, so this identity needs no real directory.
    workspaceDir = path.resolve(`/tmp/session-snapshot-${++workspaceSequence}`);
    vi.clearAllMocks();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    ensureSkillsWatcherMock.mockImplementation(() => undefined);
    getSkillsSnapshotVersionMock.mockReturnValue(1);
    shouldRefreshSnapshotForVersionMock.mockImplementation((cached = 0, next = 0) =>
      next === 0 ? cached > 0 : cached < next,
    );
  });

  it("prepares fresh session eligibility even when the snapshot version is unchanged", async () => {
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "cached skills prompt",
      skills: [{ name: "cached-skill" }],
      resolvedSkills: [{ name: "cached-skill" }],
    });
    const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;
    const params = {
      workspaceDir,
      config: {},
      executionWorkspaceDir: "/tmp/execution",
      pluginMetadataSnapshot,
    };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      workspaceDir,
      expect.objectContaining({ pluginMetadataSnapshot }),
    );
    expect(ensureSkillsWatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot }),
    );
    const second = await resolveReusableWorkspaceSkillSnapshot(params);

    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.snapshot.prompt).toBe("cached skills prompt");
    expect(second.snapshot.skills).toEqual([{ name: "cached-skill" }]);
    expect(second.snapshot.resolvedSkills).toEqual([{ name: "cached-skill" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);

    getSkillsSnapshotVersionMock.mockReturnValue(2);
    await resolveReusableWorkspaceSkillSnapshot(params);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(3);
  });

  it("keeps concurrent builds separate by source host", async () => {
    const workspaceBuild = createDeferred<SnapshotFixture>();
    const gatewayBuild = createDeferred<SnapshotFixture>();
    buildWorkspaceSkillSnapshotMock.mockImplementation((_workspace, options) =>
      options.executionWorkspaceFileHost ? gatewayBuild.promise : workspaceBuild.promise,
    );
    const params = {
      workspaceDir,
      executionWorkspaceDir: path.resolve(workspaceDir, "../execution"),
      config: {},
      watch: false,
    };
    const workspace = resolveReusableWorkspaceSkillSnapshot(params);
    const gateway = resolveReusableWorkspaceSkillSnapshot({
      ...params,
      executionWorkspaceFileHost: "gateway",
    });
    workspaceBuild.resolve({ prompt: "workspace catalog", skills: [], resolvedSkills: [] });
    gatewayBuild.resolve({ prompt: "Gateway catalog", skills: [], resolvedSkills: [] });
    const [local, hosted] = await Promise.all([workspace, gateway]);
    expect(local.snapshot.prompt).toBe("workspace catalog");
    expect(hosted.snapshot.prompt).toBe("Gateway catalog");
    expect(resolveSkillSnapshotExecutionFileHost(local.snapshot)).toBeUndefined();
    expect(resolveSkillSnapshotExecutionFileHost(hosted.snapshot)).toBe("gateway");
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toEqual(local.snapshot);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "hydrates cached resolvedSkills only when the filter changes: %s",
    async (changed) => {
      const snapshot = strippedSnapshot();
      const params = { workspaceDir, config: {}, existingSnapshot: snapshot };
      await resolveReusableWorkspaceSkillSnapshot(params);
      expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
      await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        skillFilter: changed ? ["new-filter"] : undefined,
        existingSnapshot: { ...snapshot, skillFilter: changed ? ["old-filter"] : undefined },
      });
      expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(changed ? 2 : 1);
    },
  );

  it.each([
    "legacy path",
    "source path",
    "source host",
    "legacy workspace locator",
    "legacy gateway host",
    "legacy implicit host",
  ])("rejects an unverified provider during cold hydration (%s)", async (identity) => {
    const original = strippedSnapshot();
    if (identity.startsWith("source")) {
      original.skills[0]!.source = { filePath: "/skills/test/SKILL.md", fileHost: "gateway" };
    }
    if (identity === "legacy gateway host") {
      original.skills[0]!.gatewayFilePath = "/skills/test/SKILL.md";
    }
    if (identity === "legacy workspace locator") {
      original.prompt = original.prompt.replace(
        "/skills/test/SKILL.md",
        "workspace-skill://workspace/test/SKILL.md",
      );
    }
    const replacement = createCanonicalFixtureSkill({
      name: "test",
      description: "Different provider",
      filePath: identity.endsWith("host") ? "/skills/test/SKILL.md" : "/other-root/test/SKILL.md",
      baseDir: "/other-root/test",
      source: "openclaw-workspace",
    });
    if (identity === "source host" || identity === "legacy workspace locator") {
      replacement.fileHost = "workspace";
    } else if (identity === "source path" || identity === "legacy implicit host") {
      replacement.fileHost = "gateway";
    }
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      ...original,
      prompt: strippedSnapshot().prompt.replace("/skills/test/SKILL.md", replacement.filePath),
      skills: [
        {
          name: replacement.name,
          source: { filePath: replacement.filePath, fileHost: replacement.fileHost },
        },
      ],
      resolvedSkills: [replacement],
    });
    const params = { workspaceDir, config: {}, watch: false };
    await resolveReusableWorkspaceSkillSnapshot(params);
    for (const existingSnapshot of [original, { ...original }]) {
      const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot,
      });
      expect(snapshot.prompt).toBe(original.prompt);
      expect(snapshot.skills).toBe(original.skills);
      expect(snapshot.resolvedSkills).toEqual([]);
      expect(snapshot.discoverySkills).toEqual([]);
    }
  });

  it.each([
    {
      name: "reordered duplicates",
      cached: ["weather", "meme-factory"],
      next: [" meme-factory ", "weather", "weather"],
      refresh: false,
    },
    { name: "explicit empty filter", cached: [], next: [], refresh: false },
    { name: "absent filter", cached: undefined, next: undefined, refresh: false },
    {
      name: "changed membership",
      cached: ["weather", "meme-factory"],
      next: ["weather", "other"],
      refresh: true,
    },
    { name: "absent to empty", cached: undefined, next: [], refresh: true },
    { name: "empty to absent", cached: [], next: undefined, refresh: true },
  ])("preserves snapshot reuse semantics for $name", async ({ cached, next, refresh }) => {
    const snapshot: SkillSnapshot = {
      ...strippedSnapshot(),
      resolvedSkills: [],
      skillFilter: cached,
    };
    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: {},
      existingSnapshot: snapshot,
      skillFilter: next,
      watch: false,
    });
    expect(result.shouldRefresh).toBe(refresh);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(refresh ? 1 : 0);
    if (!refresh) {
      expect(result.snapshot).toBe(snapshot);
      expect(result.snapshot.skillFilter).toBe(cached);
    }
  });

  it("rebuilds for a live caller after an abandoned preparation drains", async () => {
    const entered = createDeferred();
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
      entered.resolve();
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
    const params = { workspaceDir, config: {}, watch: false };
    const first = resolveReusableWorkspaceSkillSnapshot({
      ...params,
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const firstRejected = expect(first).rejects.toBe(reason);
    await entered.promise;
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
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toEqual(
      (await second).snapshot,
    );
  });

  it("propagates a shared build failure to callers that remain current", async () => {
    const build = createDeferred<SnapshotFixture>();
    const reason = new Error("skill source unavailable");
    buildWorkspaceSkillSnapshotMock.mockReturnValue(build.promise);
    const params = { workspaceDir, config: {}, watch: false };
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
    const params = { workspaceDir, config: {} };
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

  it.each([
    { reason: "watcher invalidation", cached: 1, current: 5, watcher: true },
    { reason: "process restart from zero", cached: 0, current: 1 },
    { reason: "process restart from timestamp", cached: 9_999, current: 10_000 },
    { reason: "missing prompt format", cached: 5, current: 0, format: undefined },
    {
      reason: "old skill identities",
      cached: 1,
      current: 1,
      format: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION - 1,
    },
    { reason: "node eligibility", cached: 1, current: 1, node: true },
  ])("refreshes snapshots after $reason", async (row) => {
    getSkillsSnapshotVersionMock.mockReturnValue(row.watcher ? 1 : row.current);
    if (row.watcher) {
      ensureSkillsWatcherMock.mockImplementation(() =>
        getSkillsSnapshotVersionMock.mockReturnValue(row.current),
      );
    }
    if ("format" in row) {
      shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    }
    const result = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: row.watcher ? { skills: { load: { extraDirs: ["/tmp/shared-skills"] } } } : {},
      eligibility: row.node ? { nodeSkills: { canExec: false } } : undefined,
      existingSnapshot: {
        ...strippedSnapshot("test", row.cached),
        ...("format" in row ? { promptFormatVersion: row.format } : {}),
        ...(row.node ? { nodeSkillsEligibility: { canExec: true, node: "build-node" } } : {}),
      },
    });
    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(row.cached, row.current);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      workspaceDir,
      expect.objectContaining({ snapshotVersion: row.current }),
    );
  });

  it.each(["removed", "rotated"] as const)(
    "keys config eligibility on secret presence when %s",
    async (change) => {
      const discord = createCanonicalFixtureSkill({
        name: "discord",
        description: "Discord skill",
        filePath: "/skills/discord/SKILL.md",
        baseDir: "/skills/discord",
        source: "openclaw-workspace",
      });
      buildWorkspaceSkillSnapshotMock.mockImplementation((_workspaceDir, opts) => ({
        prompt: "",
        skills: [],
        resolvedSkills: opts.config?.channels?.discord?.token ? [discord] : [],
      }));
      const snapshot = strippedSnapshot("discord");
      const prepare = (config: OpenClawConfig) =>
        resolveReusableWorkspaceSkillSnapshot({
          workspaceDir,
          config,
          existingSnapshot: { ...snapshot },
        });
      const first = await prepare({ channels: { discord: { token: "first-secret" } } });
      expect(first.snapshot.resolvedSkills).toEqual([discord]);
      expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
      const second = await prepare({
        channels: { discord: change === "rotated" ? { token: "rotated-secret" } : {} },
      });
      expect(second.snapshot.resolvedSkills).toEqual(change === "rotated" ? [discord] : []);
      expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(change === "rotated" ? 1 : 2);
    },
  );
});
