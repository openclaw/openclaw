// Skill refresh tests cover runtime reload events and refresh-state updates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsChangeEvent } from "./refresh.js";

type WatchEvent = "add" | "change" | "unlink" | "unlinkDir" | "error";
type WatchCallback = (watchPath: string) => void;

function createMockWatcher() {
  const handlers = new Map<WatchEvent, WatchCallback[]>();
  const watcher = {
    on: vi.fn((event: WatchEvent, callback: WatchCallback) => {
      handlers.set(event, [...(handlers.get(event) ?? []), callback]);
      return watcher;
    }),
    close: vi.fn(async () => undefined),
    emit: (event: WatchEvent, watchPath: string) => {
      for (const callback of handlers.get(event) ?? []) {
        callback(watchPath);
      }
    },
  };
  return watcher;
}

const createdWatchers: Array<ReturnType<typeof createMockWatcher>> = [];
const watchMock = vi.fn(() => {
  const watcher = createMockWatcher();
  createdWatchers.push(watcher);
  return watcher;
});

let refreshModule: typeof import("./refresh.js");

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillDirs: vi.fn(() => []),
}));

const SKILLS_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.skillsNativeWatchFactory");

type NativeWatchCall = {
  path: string;
  options: { recursive?: boolean } | undefined;
  listener: (eventType: string, filename: string | null) => void;
  emit: (event: string, ...args: unknown[]) => void;
  close: ReturnType<typeof vi.fn>;
};

// Capture the skills watcher's native fs.watch usage by injecting a fake factory
// through the same test hook the production code consults (see
// resolveSkillsNativeWatchFactory in refresh.ts).
function installNativeWatchCapture(): { calls: NativeWatchCall[]; restore: () => void } {
  const calls: NativeWatchCall[] = [];
  (globalThis as Record<PropertyKey, unknown>)[SKILLS_NATIVE_WATCH_FACTORY_KEY] = (
    watchPath: unknown,
    options: unknown,
    listener: unknown,
  ) => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const close = vi.fn();
    const watcher = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers.set(event, cb);
        return watcher;
      }),
      close,
    };
    calls.push({
      path: String(watchPath),
      options: options as { recursive?: boolean } | undefined,
      listener: listener as NativeWatchCall["listener"],
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      close,
    });
    return watcher;
  };
  return {
    calls,
    restore: () => {
      delete (globalThis as Record<PropertyKey, unknown>)[SKILLS_NATIVE_WATCH_FACTORY_KEY];
    },
  };
}

async function withPlatform(
  value: NodeJS.Platform,
  run: () => void | Promise<void>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value });
  try {
    await run();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    watchMock.mockClear();
    createdWatchers.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("watches skill roots and filters non-skill churn", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-root-"));
    try {
      refreshModule.ensureSkillsWatcher({ workspaceDir });

      // Each unique directory gets its own watcher (one path argument per call).
      const calls = watchMock.mock.calls as unknown as Array<
        [string, { depth?: number; followSymlinks?: boolean; ignored?: unknown }]
      >;
      expect(calls.length).toBeGreaterThan(0);
      const targets = calls.map((call) => call[0]);
      const opts = calls[0]?.[1] ?? {};
      const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");

      expect(opts.ignored).toBe(refreshModule.shouldIgnoreSkillsWatchPath);
      expect(opts.followSymlinks).toBe(false);
      const posix = (p: string) => p.replaceAll("\\", "/");
      expect(targets).toContain(workspaceSkillsRoot);
      expect(targets).toContain(posix(path.join(workspaceDir, ".agents", "skills")));
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === workspaceSkillsRoot)?.[1].depth).toBe(
        7,
      );
      expect(targets).toContain(posix(path.join(os.homedir(), ".agents", "skills")));
      const wildcardTargets = targets.filter((target) => target.includes("*"));
      expect(wildcardTargets).toStrictEqual([]);
      const ignored = refreshModule.shouldIgnoreSkillsWatchPath;

      // Node/JS paths
      expect(ignored("/tmp/workspace/skills/node_modules/pkg/index.js")).toBe(true);
      expect(ignored("/tmp/workspace/skills/dist/index.js")).toBe(true);
      expect(ignored("/tmp/workspace/skills/.git/config")).toBe(true);

      // Python virtual environments and caches
      expect(ignored("/tmp/workspace/skills/scripts/.venv/bin/python")).toBe(true);
      expect(ignored("/tmp/workspace/skills/venv/lib/python3.10/site.py")).toBe(true);
      expect(ignored("/tmp/workspace/skills/__pycache__/module.pyc")).toBe(true);
      expect(ignored("/tmp/workspace/skills/.mypy_cache/3.10/foo.json")).toBe(true);
      expect(ignored("/tmp/workspace/skills/.pytest_cache/v/cache")).toBe(true);

      // Build artifacts and caches
      expect(ignored("/tmp/workspace/skills/build/output.js")).toBe(true);
      expect(ignored("/tmp/workspace/skills/.cache/data.json")).toBe(true);

      // Should NOT ignore normal skill files
      expect(ignored("/tmp/.hidden/skills/index.md")).toBe(false);
      expect(ignored("/tmp/workspace/skills/my-skill", { isDirectory: () => true })).toBe(false);
      expect(ignored("/tmp/workspace/skills/my-skill", { isSymbolicLink: () => true })).toBe(false);
      expect(ignored("/tmp/workspace/skills/my-skill/README.md", {})).toBe(true);
      expect(ignored("/tmp/workspace/skills/my-skill/SKILL.md", {})).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps grouped skill folders within the watcher traversal depth", async () => {
    vi.useFakeTimers();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-depth-"));
    const seen: SkillsChangeEvent[] = [];
    try {
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        config: { skills: { load: { watchDebounceMs: 10 } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<
        [string, { depth?: number; ignored?: unknown }]
      >;
      const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");
      const firstIndex = calls.findIndex(([p]) => p.replaceAll("\\", "/") === workspaceSkillsRoot);
      expect(calls[firstIndex]?.[1]?.depth).toBe(7);

      const changedPath = path.join(workspaceDir, "skills", "group", "demo", "SKILL.md");
      createdWatchers[firstIndex]?.emit("change", changedPath);
      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toEqual([
        {
          workspaceDir,
          reason: "watch",
          changedPath,
        },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "watches allowed symlink skill targets without following every root symlink",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-symlink-"));
      const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-symlink-target-"));
      try {
        const workspaceSkillsDir = path.join(workspaceDir, "skills");
        const targetSkillDir = path.join(targetRoot, "linked-skill");
        const groupedLinkDir = path.join(workspaceSkillsDir, "group");
        await fs.mkdir(groupedLinkDir, { recursive: true });
        await fs.mkdir(targetSkillDir, { recursive: true });
        await fs.writeFile(
          path.join(targetSkillDir, "SKILL.md"),
          "---\nname: linked-skill\ndescription: Linked\n---\n",
        );
        await fs.symlink(targetSkillDir, path.join(groupedLinkDir, "linked-skill"), "dir");

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { allowSymlinkTargets: [targetRoot] } } },
        });

        const calls = watchMock.mock.calls as unknown as Array<
          [string, { followSymlinks?: boolean }]
        >;
        const target = (await fs.realpath(targetSkillDir)).replaceAll("\\", "/");
        expect(calls.find(([p]) => p.replaceAll("\\", "/") === target)?.[1].followSymlinks).toBe(
          false,
        );
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(targetRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("watches symlinked skill root targets", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-root-link-"));
    const targetSkillsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-watch-root-link-target-"),
    );
    try {
      await fs.writeFile(
        path.join(targetSkillsDir, "SKILL.md"),
        "---\nname: linked-root\ndescription: Linked root\n---\n",
      );
      await fs.symlink(targetSkillsDir, path.join(workspaceDir, "skills"), "dir");

      refreshModule.ensureSkillsWatcher({ workspaceDir });

      const calls = watchMock.mock.calls as unknown as Array<
        [string, { followSymlinks?: boolean }]
      >;
      const target = (await fs.realpath(targetSkillsDir)).replaceAll("\\", "/");
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === target)?.[1].followSymlinks).toBe(
        false,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(targetSkillsDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not watch untrusted companion skills symlink targets",
    async () => {
      const workspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-watch-untrusted-link-"),
      );
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-untrusted-repo-"));
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-watch-untrusted-target-"),
      );
      try {
        await fs.writeFile(
          path.join(outsideDir, "SKILL.md"),
          "---\nname: untrusted\ndescription: Untrusted\n---\n",
        );
        await fs.symlink(outsideDir, path.join(repoDir, "skills"), "dir");

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { extraDirs: [repoDir] } } },
        });

        const target = (await fs.realpath(outsideDir)).replaceAll("\\", "/");
        const targets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(targets).not.toContain(target);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(repoDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("watches nested skills roots for repo-style extra dirs", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-"));
    try {
      await fs.mkdir(path.join(repoDir, "skills", "group", "demo"), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, "skills", "group", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n",
      );

      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { extraDirs: [repoDir] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
      const repoRoot = repoDir.replaceAll("\\", "/");
      const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
      expect(targets).toContain(nestedRoot);
      expect(targets).toContain(repoRoot);
      expect(targets).not.toContain(path.join(repoDir, "SKILL.md").replaceAll("\\", "/"));
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(2);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(6);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it("watches nested skills roots for built-in workspace skill dirs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-skills-"));
    try {
      await fs.mkdir(path.join(workspaceDir, "skills", "skills", "group", "demo"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workspaceDir, "skills", "skills", "group", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n",
      );

      refreshModule.ensureSkillsWatcher({ workspaceDir });

      const targets = (watchMock.mock.calls as unknown as Array<[string, object]>).map(([p]) =>
        p.replaceAll("\\", "/"),
      );
      expect(targets).toContain(path.join(workspaceDir, "skills").replaceAll("\\", "/"));
      expect(targets).toContain(path.join(workspaceDir, "skills", "skills").replaceAll("\\", "/"));
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reuses watch roots while config is unchanged", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-cache-"));
    try {
      await fs.mkdir(path.join(repoDir, "skills", "group", "demo"), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, "skills", "group", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n",
      );
      const config = { skills: { load: { extraDirs: [repoDir] } } };

      refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace", config });
      const firstCallCount = watchMock.mock.calls.length;
      await fs.rm(path.join(repoDir, "skills"), { recursive: true, force: true });
      refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace", config });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
      const repoRoot = repoDir.replaceAll("\\", "/");
      const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
      expect(watchMock).toHaveBeenCalledTimes(firstCallCount);
      expect(targets).toContain(nestedRoot);
      expect(targets).toContain(repoRoot);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(2);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(6);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it("watches extra-dir roots and companion skills folders without resolving them", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-pair-"));
    try {
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { extraDirs: [repoDir] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
      const repoRoot = repoDir.replaceAll("\\", "/");
      const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
      expect(targets).toContain(nestedRoot);
      expect(targets).toContain(repoRoot);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(2);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(7);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it("bumps missing configured root depth for first nested skill creation", async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-missing-skill-root-"));
    try {
      const missingRoot = path.join(parentDir, "repo");
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { extraDirs: [missingRoot] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const root = missingRoot.replaceAll("\\", "/");
      const nestedRoot = path.join(missingRoot, "skills").replaceAll("\\", "/");
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === root)?.[1].depth).toBe(3);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(8);
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });

  it("watches configured roots named skills at grouped depth", async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-configured-skills-root-"));
    try {
      const skillsDir = path.join(parentDir, "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { extraDirs: [skillsDir] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const root = skillsDir.replaceAll("\\", "/");
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === root)?.[1].depth).toBe(6);
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });

  it("dedupes overlapping watch roots by path while keeping the deepest depth", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-dedupe-"));
    try {
      const skillsDir = path.join(workspaceDir, "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        config: { skills: { load: { extraDirs: [skillsDir] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const root = skillsDir.replaceAll("\\", "/");
      const overlapping = calls.filter(([p]) => p.replaceAll("\\", "/") === root);
      expect(overlapping).toHaveLength(1);
      expect(overlapping[0]?.[1].depth).toBe(6);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not downgrade a shared watcher when a shallow subscriber arrives later", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-share-a-"));
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-share-b-"));
    try {
      const skillsDir = path.join(workspaceDir, "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      refreshModule.ensureSkillsWatcher({ workspaceDir });
      const firstCalls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const root = skillsDir.replaceAll("\\", "/");
      const firstIndex = firstCalls.findIndex(([p]) => p.replaceAll("\\", "/") === root);

      refreshModule.ensureSkillsWatcher({
        workspaceDir: otherDir,
        config: { skills: { load: { extraDirs: [skillsDir] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const overlapping = calls.filter(([p]) => p.replaceAll("\\", "/") === root);
      expect(overlapping).toHaveLength(1);
      expect(overlapping[0]?.[1].depth).toBe(6);
      expect(createdWatchers[firstIndex]?.close).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it("watches extra-dir skills folders for first nested skill creation", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-create-"));
    try {
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { extraDirs: [repoDir] } } },
      });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
      const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
      expect(targets).toContain(repoDir.replaceAll("\\", "/"));
      expect(targets).toContain(nestedRoot);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(7);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it("watches nested skills roots for plugin skill dirs", async () => {
    const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-skills-watch-"));
    try {
      await fs.mkdir(path.join(pluginDir, "skills", "group", "demo"), { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "skills", "group", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n",
      );
      const pluginSkills = await import("../loading/plugin-skills.js");
      vi.mocked(pluginSkills.resolvePluginSkillDirs).mockReturnValueOnce([pluginDir]);

      refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
      const pluginRoot = pluginDir.replaceAll("\\", "/");
      const nestedRoot = path.join(pluginDir, "skills").replaceAll("\\", "/");
      expect(targets).toContain(nestedRoot);
      expect(targets).toContain(pluginRoot);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === pluginRoot)?.[1].depth).toBe(2);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(6);
    } finally {
      await fs.rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("watches plugin skills folders for first nested skill creation", async () => {
    const pluginDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-plugin-skills-watch-create-"),
    );
    try {
      const pluginSkills = await import("../loading/plugin-skills.js");
      vi.mocked(pluginSkills.resolvePluginSkillDirs).mockReturnValueOnce([pluginDir]);

      refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

      const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
      const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
      const nestedRoot = path.join(pluginDir, "skills").replaceAll("\\", "/");
      expect(targets).toContain(pluginDir.replaceAll("\\", "/"));
      expect(targets).toContain(nestedRoot);
      expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(7);
    } finally {
      await fs.rm(pluginDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not watch untrusted plugin skill symlink targets",
    async () => {
      const pluginDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-plugin-skills-untrusted-link-"),
      );
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-plugin-skills-untrusted-target-"),
      );
      try {
        await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });
        await fs.writeFile(
          path.join(outsideDir, "SKILL.md"),
          "---\nname: untrusted-plugin\ndescription: Untrusted plugin\n---\n",
        );
        await fs.symlink(outsideDir, path.join(pluginDir, "skills", "untrusted"), "dir");
        const pluginSkills = await import("../loading/plugin-skills.js");
        vi.mocked(pluginSkills.resolvePluginSkillDirs).mockReturnValueOnce([pluginDir]);

        refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

        const target = (await fs.realpath(outsideDir)).replaceAll("\\", "/");
        const targets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(targets).not.toContain(target);
      } finally {
        await fs.rm(pluginDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["add", "change", "unlink", "unlinkDir"] as const)(
    "refreshes skills snapshots on %s",
    async (event) => {
      vi.useFakeTimers();
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { watchDebounceMs: 10 } } },
      });

      createdWatchers[0]?.emit(event, "/tmp/workspace/skills/demo/SKILL.md");
      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toEqual([
        {
          workspaceDir: "/tmp/workspace",
          reason: "watch",
          changedPath: "/tmp/workspace/skills/demo/SKILL.md",
        },
      ]);
    },
  );

  it("refreshes skills snapshots when watched skill roots change", () => {
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { extraDirs: ["/tmp/shared-a"] } } },
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { extraDirs: ["/tmp/shared-b"] } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedAIndex = callPaths.findIndex((target) => target.includes("/tmp/shared-a"));
    // The dropped extra dir is unsubscribed and its watcher closed; the new dir
    // gets a fresh watcher.
    expect(sharedAIndex).toBeGreaterThanOrEqual(0);
    expect(createdWatchers[sharedAIndex]?.close).toHaveBeenCalledTimes(1);
    expect(callPaths.some((target) => target.includes("/tmp/shared-b"))).toBe(true);
    expect(seen).toEqual([
      {
        workspaceDir: "/tmp/workspace",
        reason: "watch-targets",
        changedPath: expect.stringContaining("/tmp/shared-b"),
      },
    ]);
  });

  it("reuses one watcher when multiple workspaces watch the same shared skill root", () => {
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"] } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"] } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    // Each shared target is watched exactly once even though two workspaces
    // include it, instead of one watcher per workspace (the EMFILE root cause).
    expect(callPaths.filter((target) => target === "/tmp/shared")).toHaveLength(1);
    expect(callPaths.filter((target) => target === "/tmp/shared/skills")).toHaveLength(1);
  });

  it("fans out a shared-directory change to every subscribed workspace", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedIndex = callPaths.findIndex((target) => target.includes("/tmp/shared"));
    expect(sharedIndex).toBeGreaterThanOrEqual(0);

    createdWatchers[sharedIndex]?.emit("change", "/tmp/shared/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-a",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-b",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
  });

  it("stops fanning a shared-directory change to a workspace after it unsubscribes", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });

    // ws-a turns watching off: it unsubscribes, but the shared watcher stays
    // alive for ws-b (torn down only when the last subscriber leaves).
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watch: false } } },
    });
    seen.length = 0;

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedIndex = callPaths.findIndex((target) => target.includes("/tmp/shared"));
    expect(sharedIndex).toBeGreaterThanOrEqual(0);

    createdWatchers[sharedIndex]?.emit("change", "/tmp/shared/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-b",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
    expect(seen.some((change) => change.workspaceDir === "/tmp/ws-a")).toBe(false);
  });

  it("clears workspace version state on watch disable without losing pending invalidation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const workspaceDir = "/tmp/workspace-version-cleanup";
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    const firstVersion = refreshModule.bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch",
      changedPath: `${workspaceDir}/skills/demo/SKILL.md`,
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    const nextVersion = refreshModule.getSkillsSnapshotVersion(workspaceDir);
    expect(nextVersion).toBeGreaterThan(firstVersion);
    expect(refreshModule.shouldRefreshSnapshotForVersion(firstVersion, nextVersion)).toBe(true);
    vi.setSystemTime(new Date(nextVersion));
    const followupVersion = refreshModule.bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch",
    });
    expect(followupVersion).toBeGreaterThan(nextVersion);
  });

  it("evicts idle workspace subscriptions on a later ensure call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const idleWorkspaceDir = "/tmp/workspace-idle";
    refreshModule.ensureSkillsWatcher({
      workspaceDir: idleWorkspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });
    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const idleSkillsIndex = callPaths.findIndex(
      (target) => target === `${idleWorkspaceDir}/skills`,
    );
    expect(idleSkillsIndex).toBeGreaterThanOrEqual(0);
    const firstVersion = refreshModule.bumpSkillsSnapshotVersion({
      workspaceDir: idleWorkspaceDir,
      reason: "watch",
    });

    vi.advanceTimersByTime(60 * 60_000 + 1_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace-active",
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    expect(createdWatchers[idleSkillsIndex]?.close).toHaveBeenCalledTimes(1);
    const evictedVersion = refreshModule.getSkillsSnapshotVersion(idleWorkspaceDir);
    expect(evictedVersion).toBeGreaterThan(firstVersion);
    expect(refreshModule.shouldRefreshSnapshotForVersion(firstVersion, evictedVersion)).toBe(true);
    vi.setSystemTime(new Date(evictedVersion));
    const followupVersion = refreshModule.bumpSkillsSnapshotVersion({
      workspaceDir: idleWorkspaceDir,
    });
    expect(followupVersion).toBeGreaterThan(evictedVersion);
  });

  it("keeps refreshed workspace subscriptions within the idle TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const activeWorkspaceDir = "/tmp/workspace-active-refresh";
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });
    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const activeSkillsIndex = callPaths.findIndex(
      (target) => target === `${activeWorkspaceDir}/skills`,
    );
    expect(activeSkillsIndex).toBeGreaterThanOrEqual(0);

    vi.advanceTimersByTime(30 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });
    vi.advanceTimersByTime(31 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace-other",
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    expect(createdWatchers[activeSkillsIndex]?.close).not.toHaveBeenCalled();
  });

  it("rebuilds a shared watcher with last-writer debounce while preserving subscribers", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });
    const callPaths1 = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const firstSharedIndex = callPaths1.findIndex((target) => target === "/tmp/shared");

    // ws-b subscribes to the same path with a different debounce: the shared
    // watcher is rebuilt once, the previous instance closed, and both
    // workspaces remain subscribed.
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 50 } } },
    });

    expect(createdWatchers[firstSharedIndex]?.close).toHaveBeenCalledTimes(1);
    const callPaths2 = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedIndices = callPaths2
      .map((target, index) => (target === "/tmp/shared" ? index : -1))
      .filter((index) => index >= 0);
    expect(sharedIndices).toHaveLength(2);
    expect(callPaths2.filter((target) => target === "/tmp/shared/skills")).toHaveLength(2);
    const liveSharedIndex = sharedIndices[sharedIndices.length - 1] ?? -1;

    createdWatchers[liveSharedIndex]?.emit("change", "/tmp/shared/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(50);

    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-a",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-b",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
  });

  it.each(["darwin", "win32"] as const)(
    "watches each skill root with one native recursive fs.watch, not one per SKILL.md on %s (#90578)",
    async (platform) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-native-"));
      const capture = installNativeWatchCapture();
      try {
        await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, "skills", "demo", "SKILL.md"),
          "---\nname: demo\ndescription: Demo\n---\n",
        );
        const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");

        await withPlatform(platform, () => {
          refreshModule.ensureSkillsWatcher({ workspaceDir });
        });

        // The existing on-disk skill root is covered by a single native recursive
        // watcher (one fd per tree), not chokidar's per-file fan-out.
        const rootCall = capture.calls.find(
          (call) => call.path.replaceAll("\\", "/") === workspaceSkillsRoot,
        );
        expect(rootCall?.options?.recursive).toBe(true);
        const chokidarTargets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(chokidarTargets).not.toContain(workspaceSkillsRoot);

        // The #90578 regression: zero native watchers are opened on a SKILL.md
        // file (that per-file fan-out was the leaked descriptor).
        const nativeSkillMdWatchers = capture.calls
          .map((call) => call.path.replaceAll("\\", "/"))
          .filter((p) => p.endsWith("SKILL.md"));
        expect(nativeSkillMdWatchers).toStrictEqual([]);
      } finally {
        capture.restore();
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["add", "change", "unlink"] as const)(
    "detects a skill %s through the native macOS watcher, not just directory churn",
    async (kind) => {
      vi.useFakeTimers();
      const seen: SkillsChangeEvent[] = [];
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-native-evt-"));
      const capture = installNativeWatchCapture();
      try {
        const skillFile = path.join(workspaceDir, "skills", "demo", "SKILL.md");
        await fs.mkdir(path.dirname(skillFile), { recursive: true });
        await fs.writeFile(skillFile, "---\nname: demo\ndescription: Demo\n---\n");
        const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");

        refreshModule.registerSkillsChangeListener((change) => seen.push(change));
        await withPlatform("darwin", () => {
          refreshModule.ensureSkillsWatcher({
            workspaceDir,
            config: { skills: { load: { watchDebounceMs: 10 } } },
          });
        });

        const rootCall = capture.calls.find(
          (call) =>
            call.options?.recursive === true &&
            call.path.replaceAll("\\", "/") === workspaceSkillsRoot,
        );
        expect(rootCall).toBeDefined();

        if (kind === "unlink") {
          await fs.rm(skillFile);
        }
        // Native fs.watch reports a path relative to the watched root; the handler
        // re-stats and refreshes for SKILL.md adds, in-place edits, and removals
        // alike (a directory-only watch would miss the in-place edit).
        rootCall?.listener(kind === "change" ? "change" : "rename", "demo/SKILL.md");
        await vi.advanceTimersByTimeAsync(10);

        expect(seen).toEqual([
          {
            workspaceDir,
            reason: "watch",
            changedPath: skillFile,
          },
        ]);
      } finally {
        capture.restore();
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps the chokidar watcher on non-native platforms", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-linux-"));
    const capture = installNativeWatchCapture();
    try {
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");

      await withPlatform("linux", () => {
        refreshModule.ensureSkillsWatcher({ workspaceDir });
      });

      // Native recursive fs.watch is never consulted on Linux (it would fan out to
      // every file); the directory is watched through chokidar instead.
      expect(capture.calls).toStrictEqual([]);
      const chokidarTargets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
        p.replaceAll("\\", "/"),
      );
      expect(chokidarTargets).toContain(workspaceSkillsRoot);
    } finally {
      capture.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("falls back to a single chokidar watcher when the native skill watcher errors (#90578)", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-watch-native-fallback-"),
    );
    const capture = installNativeWatchCapture();
    try {
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");

      await withPlatform("darwin", () => {
        refreshModule.ensureSkillsWatcher({ workspaceDir });
      });
      const rootCall = capture.calls.find(
        (call) =>
          call.options?.recursive === true &&
          call.path.replaceAll("\\", "/") === workspaceSkillsRoot,
      );
      expect(rootCall).toBeDefined();
      const chokidarTargetsBefore = (watchMock.mock.calls as unknown as Array<[string]>)
        .map(([p]) => p.replaceAll("\\", "/"))
        .filter((p) => p === workspaceSkillsRoot);
      expect(chokidarTargetsBefore).toStrictEqual([]);

      // A native error tears the native watcher down and restores coverage through a
      // single chokidar watcher on the same root (no leaked or duplicated watcher).
      rootCall?.emit("error", new Error("native watcher died"));

      expect(rootCall?.close).toHaveBeenCalled();
      const chokidarTargetsAfter = (watchMock.mock.calls as unknown as Array<[string]>)
        .map(([p]) => p.replaceAll("\\", "/"))
        .filter((p) => p === workspaceSkillsRoot);
      expect(chokidarTargetsAfter).toHaveLength(1);
    } finally {
      capture.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not re-attach a watcher after the skill watcher is torn down (#90578)", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-watch-native-disposed-"),
    );
    const capture = installNativeWatchCapture();
    try {
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const workspaceSkillsRoot = path.join(workspaceDir, "skills").replaceAll("\\", "/");

      await withPlatform("darwin", () => {
        refreshModule.ensureSkillsWatcher({ workspaceDir });
      });
      const rootCall = capture.calls.find(
        (call) =>
          call.options?.recursive === true &&
          call.path.replaceAll("\\", "/") === workspaceSkillsRoot,
      );
      const parentCall = capture.calls.find((call) => call.options?.recursive === false);
      expect(rootCall).toBeDefined();

      // Disable watching: the state is torn down and dropped from the watcher map.
      await withPlatform("darwin", () => {
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { watch: false } } },
        });
      });

      // A stale native error / parent event arriving after teardown must not
      // re-attach a watcher onto the orphaned state (that leak re-creates #90578).
      watchMock.mockClear();
      rootCall?.emit("error", new Error("stale native error"));
      parentCall?.listener("rename", "skills");

      expect(watchMock).not.toHaveBeenCalled();
    } finally {
      capture.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
