// Workspace bootstrap file tests cover bootstrap loading, transient retry
// behavior, and session-based bootstrap filtering.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-bootstrap-",
  });
});

afterEach(async () => {
  await testState?.cleanup();
  testState = undefined;
});

function expectSubagentAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md", "TOOLS.md"]);
}

function expectCronAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"]);
}

describe("loadWorkspaceBootstrapFiles", () => {
  const getMemoryEntries = (files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>) =>
    files.filter((file) => file.name === DEFAULT_MEMORY_FILENAME);

  const expectSingleMemoryEntry = (
    files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>,
    content: string,
  ) => {
    const memoryEntries = getMemoryEntries(files);
    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe(content);
  };

  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expectSingleMemoryEntry(files, "memory");
  });

  it("ignores lowercase memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });

  it("treats hardlinked bootstrap aliases as missing", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-hardlink-"));
    try {
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, DEFAULT_AGENTS_FILENAME);
      const linkPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
      await fs.writeFile(outsideFile, "outside", "utf-8");
      try {
        await fs.link(outsideFile, linkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const files = await loadWorkspaceBootstrapFiles(workspaceDir);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(true);
      expect(agents?.content).toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries a transient bootstrap read instead of dropping the file for the turn", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nkeep me\n",
    });

    const originalReadFileSync = syncFs.readFileSync.bind(syncFs);
    let readFileSyncCalls = 0;
    let threwTransient = false;
    const readSpy = vi.spyOn(syncFs, "readFileSync").mockImplementation(((
      target: unknown,
      options: unknown,
    ) => {
      readFileSyncCalls += 1;
      if (!threwTransient) {
        threwTransient = true;
        throw Object.assign(new Error("Unknown system error -11: read"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return originalReadFileSync(target as never, options as never);
    }) as typeof syncFs.readFileSync);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(threwTransient).toBe(true);
      // The retry re-opens and reads again, so the failed first read is followed
      // by at least one more successful read.
      expect(readFileSyncCalls).toBeGreaterThanOrEqual(2);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("keep me");
    } finally {
      readSpy.mockRestore();
    }
  });

  it("marks a bootstrap file missing after transient read retries are exhausted", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n",
    });

    const readSpy = vi.spyOn(syncFs, "readFileSync").mockImplementation((() => {
      throw Object.assign(new Error("Unknown system error -11: read"), {
        code: "EAGAIN",
        errno: -11,
      });
    }) as typeof syncFs.readFileSync);

    try {
      // Unlike the template check, this reader returns an io failure (not a
      // throw) when the budget is exhausted, so the file surfaces as missing.
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(true);
      expect(agents?.content).toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }
  });

  it("retries a transient boundary-resolution failure before dropping a bootstrap file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nboundary retry\n",
    });

    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const originalLstat = syncFs.promises.lstat.bind(syncFs.promises);
    let agentsLstatAttempts = 0;
    const lstatSpy = vi.spyOn(syncFs.promises, "lstat").mockImplementation((async (
      target: unknown,
      options?: unknown,
    ) => {
      if (String(target) === agentsPath && ++agentsLstatAttempts === 1) {
        throw Object.assign(new Error("Unknown system error -11: lstat"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return await originalLstat(target as never, options as never);
    }) as typeof syncFs.promises.lstat);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(agentsLstatAttempts).toBe(2);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("boundary retry");
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("retries a transient open failure before dropping a bootstrap file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-bootstrap-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nopen retry\n",
    });

    // openRootFile reports a transient open failure as reason "io"; the reader
    // must retry it (re-open) rather than drop the file for the turn.
    const originalOpenSync = syncFs.openSync.bind(syncFs);
    let threwTransientOpen = false;
    const openSpy = vi.spyOn(syncFs, "openSync").mockImplementation(((
      ...args: Parameters<typeof syncFs.openSync>
    ) => {
      if (!threwTransientOpen) {
        threwTransientOpen = true;
        throw Object.assign(new Error("Unknown system error -11: open"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return originalOpenSync(...args);
    }) as typeof syncFs.openSync);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(threwTransientOpen).toBe(true);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("open retry");
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe("filterBootstrapFilesForSession", () => {
  const mockFiles: WorkspaceBootstrapFile[] = [
    { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
    { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
    { name: "TOOLS.md", path: "/w/TOOLS.md", content: "", missing: false },
    { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
    { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
    { name: "HEARTBEAT.md", path: "/w/HEARTBEAT.md", content: "", missing: false },
    { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
    { name: "MEMORY.md", path: "/w/MEMORY.md", content: "", missing: false },
  ];

  it("returns all files for main session (no sessionKey)", () => {
    const result = filterBootstrapFilesForSession(mockFiles);
    expect(result).toStrictEqual(mockFiles);
  });

  it("returns all files for normal (non-subagent, non-cron) session key", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:chat:main");
    expect(result).toStrictEqual(mockFiles);
  });

  it("filters to allowlist for subagent sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:subagent:task-1");
    expectSubagentAllowedBootstrapNames(result);
  });

  it("filters to allowlist for cron sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:cron:daily-check");
    expectCronAllowedBootstrapNames(result);
  });

  it.each([
    { key: "agent:main:telegram:group:-100123", label: "telegram group" },
    { key: "agent:main:discord:group:dev", label: "discord group" },
    { key: "agent:main:discord:channel:c1", label: "discord channel" },
    { key: "agent:main:discord:guild-123:channel-456", label: "discord guild/channel" },
    { key: "agent:main:slack:group:general", label: "slack group" },
    { key: "agent:main:feishu:group:oc-group", label: "feishu group" },
    { key: "agent:main:matrix:channel:!Room:example.org", label: "matrix channel" },
    { key: "agent:main:whatsapp:123@g.us", label: "whatsapp group" },
    { key: "agent:main:signal:group:AbC123", label: "signal group" },
  ] as const)("excludes MEMORY.md for shared channel session ($label)", ({ key }) => {
    const result = filterBootstrapFilesForSession(mockFiles, key);
    const names = result.map((f) => f.name);
    expect(names).not.toContain("MEMORY.md");
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("TOOLS.md");
    expect(names).toContain("SOUL.md");
    expect(names).toContain("USER.md");
  });

  it.each([
    { key: "agent:main:main", label: "main session" },
    { key: "agent:main:chat:main", label: "chat session" },
    { key: "agent:main:direct:user1", label: "direct session" },
    { key: "agent:main:telegram:dm:123456", label: "telegram dm" },
    { key: "agent:main:discord:direct:user1", label: "discord direct" },
  ] as const)("includes MEMORY.md for private session ($label)", ({ key }) => {
    const result = filterBootstrapFilesForSession(mockFiles, key);
    expect(result.map((f) => f.name)).toContain("MEMORY.md");
  });
});
