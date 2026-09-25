import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";

const observer = createSkillsWatcherMock();
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: vi.fn(() => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(() => []),
}));
const fixture = useSkillsWatcherFixture(observer);
const refresh = await import("./refresh.js");
afterEach(() => vi.unstubAllGlobals());

it.each([
  { platform: "linux", runtime: "node", mode: "node" },
  { platform: "darwin", runtime: "node", mode: "poll" },
  { platform: "win32", runtime: "node", mode: "poll" },
  { platform: "os400", runtime: "node", mode: "poll" },
  { platform: "linux", runtime: "bun", mode: "poll" },
  { platform: "linux", runtime: "deno", mode: "poll" },
  { platform: "linux", runtime: "other", mode: "poll" },
])(
  "selects the default Skills mode for $platform/$runtime",
  async ({ platform, runtime, mode }) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    // These process facts select policy, not an emulated native backend.
    vi.stubGlobal("process", {
      ...process,
      platform,
      release: { ...process.release, name: runtime === "other" ? "other" : "node" },
      versions: {
        ...process.versions,
        bun: runtime === "bun" ? "1.4.2" : undefined,
        deno: runtime === "deno" ? "2.0.0" : undefined,
      },
    });
    const params = { workspaceDir: fixture.workspaceDir };
    refresh.ensureSkillsWatcher(params);
    await observer.readyAll();
    expect(observer.subscriptions.length).toBeGreaterThan(0);
    expect(observer.subscriptions.every((entry) => entry.options.mode === mode)).toBe(true);
    expect(
      observer.subscriptions.every(
        (entry) => entry.options.intervalMs === (mode === "poll" ? 100 : undefined),
      ),
    ).toBe(true);
    expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(true);
  },
);

it.each(["false", "0", ""])(
  "keeps native-only Skills unavailable after unsupported-host refusal (%s)",
  async (setting) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", setting);
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const params = { workspaceDir: fixture.workspaceDir };
    refresh.ensureSkillsWatcher(params);
    await observer.readyAll();
    const root = path.join(params.workspaceDir, "skills");
    const original = observer.forRoot(root);
    const unavailable = new Error(
      "descriptor-bound native observation requires Node.js on Linux; select polling explicitly",
    );
    original.fail(unavailable, { operation: "watch" });
    expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(false);
    await original.close();
    await waitForSkillsWatcherTurn();
    await observer.started();
    const retry = observer.forRoot(root);
    expect(retry).not.toBe(original);
    retry.fail(unavailable, { operation: "watch" });
    await waitForSkillsWatcherTurn();
    expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(false);
    expect(observer.subscriptions.every((entry) => entry.options.mode === "node")).toBe(true);
  },
);

it.each([
  { configured: "1", interval: 20 },
  { configured: "250", interval: 250 },
  { configured: "invalid", interval: 100 },
  { configured: "2147483648", interval: 100 },
])("keeps explicit Skills polling cadence $configured", async ({ configured, interval }) => {
  vi.stubEnv("CHOKIDAR_USEPOLLING", "TrUe");
  vi.stubEnv("CHOKIDAR_INTERVAL", configured);
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  expect(observer.subscriptions.length).toBeGreaterThan(0);
  expect(
    observer.subscriptions.every(
      (entry) => entry.options.mode === "poll" && entry.options.intervalMs === interval,
    ),
  ).toBe(true);
});

it.each([false, true])("passes explicit library mode, polling=%s", async (polling) => {
  vi.stubEnv("CHOKIDAR_USEPOLLING", String(polling));
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  expect(observer.subscriptions.length).toBeGreaterThan(0);
  expect(
    observer.subscriptions.every((entry) => entry.options.mode === (polling ? "poll" : "node")),
  ).toBe(true);
});

it("selects workspace, extra and companion roots at discovery depth without broad traversal", async () => {
  const extra = await fixture.createFixtureDirectory("repository");
  const workspaceDir = fixture.workspaceDir;
  refresh.ensureSkillsWatcher({
    workspaceDir,
    config: { skills: { load: { extraDirs: [extra] } } },
  });
  await observer.readyAll();
  for (const [root, depth] of [
    [path.join(workspaceDir, "skills"), 7],
    [extra, 3],
    [path.join(extra, "skills"), 7],
  ] as const) {
    const observed = observer.forRoot(root);
    expect(observed.options.scopes).toContainEqual(
      expect.objectContaining({ kind: "tree", depth: expect.any(Number) }),
    );
    expect(observed.options.scopes[0]!.depth).toBeGreaterThanOrEqual(depth);
    expect(observed.options.signal).toBeInstanceOf(AbortSignal);
    for (const ignored of [".git", "node_modules", "dist", ".venv", "__pycache__", "build"]) {
      expect(
        observed.options.exclude?.({
          path: path.relative(observed.authority.rootDir, path.join(root, ignored)),
          kind: "directory",
        }),
      ).toBe(true);
    }
  }
});

it("reuses logical subscriptions and cached target discovery when inputs are unchanged", async () => {
  const params = { workspaceDir: fixture.workspaceDir };
  refresh.ensureSkillsWatcher(params);
  await observer.readyAll();
  const original = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
  observer.watchMock.mockClear();
  refresh.ensureSkillsWatcher(params);
  await observer.started();
  expect(observer.watchMock).not.toHaveBeenCalled();
  expect(observer.forRoot(path.join(fixture.workspaceDir, "skills"))).toBe(original);
});

it("reuses caller-prepared plugin metadata", async () => {
  const plugin = await import("../loading/plugin-skills.js");
  vi.mocked(plugin.resolvePluginSkillRoots).mockClear();
  vi.mocked(plugin.resolvePluginSkillRootsFromMetadata).mockClear();
  const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir, pluginMetadataSnapshot });
  expect(plugin.resolvePluginSkillRootsFromMetadata).toHaveBeenCalled();
  expect(plugin.resolvePluginSkillRoots).not.toHaveBeenCalled();
});

it("shares logical targets across workspaces without downgrading discovery depth", async () => {
  const workspaceDir = fixture.workspaceDir;
  const shared = path.join(workspaceDir, "skills");
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.readyAll();
  const original = observer.forRoot(shared);
  const other = await fixture.createFixtureDirectory("other");
  refresh.ensureSkillsWatcher({
    workspaceDir: other,
    config: { skills: { load: { extraDirs: [shared, shared] } } },
  });
  await observer.readyAll();
  expect(observer.forRoot(shared)).toBe(original);
  expect(original.options.scopes[0]!.depth).toBeGreaterThanOrEqual(7);
});

it.each(["extra", "plugin"] as const)(
  "selects nested companion discovery for %s roots",
  async (source) => {
    const root = await fixture.createFixtureDirectory("source/skills/group/demo");
    await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n");
    const sourceRoot = path.resolve(root, "../../..");
    const plugin = await import("../loading/plugin-skills.js");
    const resolveRoots = vi.mocked(plugin.resolvePluginSkillRoots);
    const originalRoots = resolveRoots.getMockImplementation()!;
    if (source === "plugin") {
      // The plugin remains installed through startup reconciliation.
      resolveRoots.mockReturnValue([{ dir: sourceRoot, rejectHardlinks: true }]);
    }
    try {
      refresh.ensureSkillsWatcher({
        workspaceDir: fixture.workspaceDir,
        config: { skills: { load: { extraDirs: source === "extra" ? [sourceRoot] : [] } } },
      });
      await observer.readyAll();
      expect(
        observer.forRoot(path.join(sourceRoot, "skills")).options.scopes[0]!.depth,
      ).toBeGreaterThanOrEqual(7);
    } finally {
      resolveRoots.mockImplementation(originalRoots);
    }
  },
);

it("keeps an isolated state directory out of personal home sources", async () => {
  const plan = resolveWorkspaceSkillSourcePlan(fixture.workspaceDir, {});
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir, sourcePlan: plan });
  await observer.readyAll();
  expect(plan.roots.some((entry) => entry.source === "agents-skills-personal")).toBe(false);
});
