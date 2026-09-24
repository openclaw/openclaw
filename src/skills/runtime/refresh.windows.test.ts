import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSkillsSourceVersion } from "./refresh-state.js";
import { createSkillsWatcherMock } from "./refresh.watcher.test-support.js";

const { createdWatchers, watchMock, nativeWatchMock, nativeContentWatchMock, watchForSkillRoot } =
  createSkillsWatcherMock();
let refreshModule: typeof import("./refresh.js");
let fixtureRoot: string;
let fixtureWorkspaceDir: string;

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
vi.mock("./refresh-content-native.js", () => ({
  createNativeSkillsContentWatcher: nativeContentWatchMock,
}));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: vi.fn(() => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(() => []),
}));

describe("Windows skills watcher paths", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });
  beforeEach(async () => {
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-fixture-"));
    fixtureWorkspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(fixtureWorkspaceDir, "skills"), { recursive: true });
  });
  afterEach(async () => {
    await refreshModule.closeSkillsWatchers(true);
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each(["acquisition", "reconciliation"] as const)(
    "retains the configured root when Windows resolves a deleted ancestor during %s",
    async (phase) => {
      vi.useFakeTimers();
      const root = await fs.realpath(fixtureRoot);
      const sourceRoot = path.join(root, "left", "nested", "skills");
      const siblingRoot = path.join(root, "right", "skills");
      const workspaceDir = path.join(root, "workspace");
      const siblingWorkspace = path.join(root, "sibling-workspace");
      const config = { skills: { load: { extraDirs: [sourceRoot] } } };
      const siblingConfig = { skills: { load: { extraDirs: [siblingRoot] } } };
      await fs.mkdir(path.join(siblingWorkspace, "skills"), { recursive: true });
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      try {
        refreshModule.ensureSkillsWatcher({
          workspaceDir: siblingWorkspace,
          config: siblingConfig,
        });
        const shared = watchForSkillRoot(siblingRoot).watcher;
        const emitRawAndDrain = async (rawPath: string) => {
          shared.emit("raw", "rename", rawPath, { watchedPath: root });
          await Promise.resolve();
        };
        if (phase === "reconciliation") {
          refreshModule.ensureSkillsWatcher({ workspaceDir, config });
        }
        await fs.mkdir(sourceRoot, { recursive: true });
        await emitRawAndDrain("left");
        const retired =
          phase === "reconciliation" ? watchForSkillRoot(sourceRoot).watcher : undefined;
        const originalLstat = fsSync.lstatSync;
        const staleDirectories = new Map(
          [path.join(root, "left"), path.dirname(sourceRoot), sourceRoot].map((dir) => [
            dir,
            originalLstat(dir),
          ]),
        );
        await fs.rm(path.join(root, "left"), { recursive: true });
        const deletedNamespace = path.join(root, "$Extend", "$Deleted");
        await fs.mkdir(deletedNamespace, { recursive: true });
        const nativeRealpath = fsSync.realpathSync.native;
        const lstat = vi
          .spyOn(fsSync, "lstatSync")
          .mockImplementation(
            (...args) => staleDirectories.get(String(args[0])) ?? originalLstat(...args),
          );
        const realpath = vi
          .spyOn(fsSync.realpathSync, "native")
          .mockImplementation((input) =>
            staleDirectories.has(String(input))
              ? path.join(deletedNamespace, "removed-directory")
              : nativeRealpath(input),
          );
        // NTFS can remove a directory after lstat but before native realpath,
        // returning an inaccessible delete-pending name before unlink delivery.
        if (phase === "acquisition") {
          refreshModule.ensureSkillsWatcher({ workspaceDir, config });
        } else {
          await emitRawAndDrain("left");
        }
        expect(watchMock.mock.calls.some(([watched]) => watched.includes("$Deleted"))).toBe(false);
        expect(watchForSkillRoot(sourceRoot).watchRoot).toBe(root.replaceAll("\\", "/"));
        expect(retired?.closed ?? true).toBe(true);
        lstat.mockRestore();
        realpath.mockRestore();

        const sourceVersion = getSkillsSourceVersion(workspaceDir);
        const skillDir = path.join(sourceRoot, "returned-proof");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: returned-proof\ndescription: Recreated root\n---\n",
        );
        await emitRawAndDrain("left");
        const replacement = watchForSkillRoot(sourceRoot).watcher;
        // Recreate can precede the retired generation's final ready/unlink events.
        retired?.emit("ready");
        retired?.emit("all", "unlinkDir", sourceRoot);
        for (const watcher of createdWatchers) {
          if (!watcher.closed) {
            watcher.emit("ready");
          }
        }
        await vi.advanceTimersByTimeAsync(250);
        expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(sourceVersion);
        expect(replacement.closed).toBe(true);
        expect(watchForSkillRoot(sourceRoot).watcher.closed).toBe(false);
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { watch: false } } },
        });
        expect(shared.closed).toBe(false);
        await fs.mkdir(siblingRoot, { recursive: true });
        await emitRawAndDrain("right");
        expect(watchForSkillRoot(siblingRoot).watchRoot).toBe(siblingRoot.replaceAll("\\", "/"));
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    },
  );

  it.each(["existing", "missing", "untrusted-link", "trusted-link"] as const)(
    "expands Windows short watch paths without changing %s root behavior",
    async (scenario) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "skills-short-path-")),
      );
      const shortRoot = path.join(root, "SHORT~1");
      const longRoot = path.join(root, "Expanded directory");
      const workspaceDir = path.join(shortRoot, "workspace");
      const repoDir = path.join(shortRoot, "repo");
      const outsideDir = path.join(root, "outside");
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const nativeRealpath = fsSync.realpathSync.native;
      let realpathSpy: MockInstance<typeof fsSync.realpathSync.native> | undefined;
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(repoDir);
        await fs.mkdir(path.join(longRoot, "workspace"), { recursive: true });
        await fs.mkdir(path.join(longRoot, "repo"));
        await fs.mkdir(outsideDir);
        if (scenario === "existing") {
          await fs.mkdir(path.join(workspaceDir, "skills"));
          await fs.mkdir(path.join(longRoot, "workspace", "skills"));
        }
        if (scenario.endsWith("link")) {
          await fs.symlink(outsideDir, path.join(repoDir, "skills"), "junction");
          await fs.symlink(outsideDir, path.join(longRoot, "repo", "skills"), "junction");
        }
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        realpathSpy = vi.spyOn(fsSync.realpathSync, "native").mockImplementation((input) => {
          const resolved = nativeRealpath(input);
          return typeof resolved === "string" &&
            (resolved === shortRoot || resolved.startsWith(`${shortRoot}${path.sep}`))
            ? `${longRoot}${resolved.slice(shortRoot.length)}`
            : resolved;
        });
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: {
            skills: {
              load: {
                extraDirs: [repoDir],
                ...(scenario === "trusted-link" ? { allowSymlinkTargets: [outsideDir] } : {}),
              },
            },
          },
        });
        const normalized = (value: string) => value.replaceAll("\\", "/");
        const skillsRoot = path.join(longRoot, "workspace", "skills");
        const skillsWatch = watchForSkillRoot(skillsRoot);
        expect(skillsWatch.watchRoot).toBe(
          normalized(scenario === "existing" ? skillsRoot : path.dirname(skillsRoot)),
        );
        expect(skillsWatch.options).toMatchObject({
          depth: scenario === "existing" ? 7 : 0,
          followSymlinks: false,
        });
        const repoSkillsRoot = path.join(longRoot, "repo", "skills");
        expect(watchForSkillRoot(repoSkillsRoot).watchRoot).toBe(
          normalized(scenario.endsWith("link") ? repoSkillsRoot : path.dirname(repoSkillsRoot)),
        );
        expect(watchMock.mock.calls.some(([target]) => target === normalized(outsideDir))).toBe(
          scenario === "trusted-link",
        );
      } finally {
        realpathSpy?.mockRestore();
        Object.defineProperty(process, "platform", platform);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps a missing drive-child root anchored absolutely",
    () => {
      const driveRoot = path.parse(fixtureRoot).root;
      const missingRoot = path.join(driveRoot, `${path.basename(fixtureRoot)}-missing`);
      expect(fsSync.existsSync(missingRoot)).toBe(false);
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: { extraDirs: [missingRoot] } } },
      });
      const subscription = watchForSkillRoot(missingRoot);
      expect(subscription.watchRoot).toBe(driveRoot.replaceAll("\\", "/"));
      expect(path.isAbsolute(subscription.watchRoot)).toBe(true);
      expect(subscription.options.followSymlinks).toBe(false);
    },
  );
});
