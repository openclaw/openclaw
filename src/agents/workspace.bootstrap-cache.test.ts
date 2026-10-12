/**
 * Integration coverage for workspace bootstrap cache reads.
 * Uses temp workspaces to verify real file loading through the cache layer.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeWorkspaceFile } from "../test-helpers/workspace.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import * as workspaceBootstrapRead from "./workspace-bootstrap-read.js";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";
import { loadWorkspaceBootstrapFiles, DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("workspace bootstrap file caching", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = tempDirs.make("openclaw-bootstrap-cache-test-");
  });

  const loadAgentsFile = async (dir: string) => {
    const result = await loadWorkspaceBootstrapFiles(dir);
    return result.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
  };

  const loadSessionAgentsFile = async (dir: string, sessionKey: string) => {
    const result = await getOrLoadBootstrapFiles({ workspaceDir: dir, sessionKey });
    return result.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
  };

  const expectAgentsContent = (
    agentsFile: Awaited<ReturnType<typeof loadAgentsFile>>,
    content: string,
  ) => {
    expect(agentsFile?.content).toBe(content);
    expect(agentsFile?.missing).toBe(false);
  };

  it("evicts the oldest cached file after 64 empty entries", async () => {
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    try {
      const workspaces: string[] = [];
      for (let index = 0; index <= 64; index += 1) {
        const dir = path.join(workspaceDir, String(index));
        await fs.mkdir(dir);
        await writeWorkspaceFile({ dir, name: DEFAULT_AGENTS_FILENAME, content: "" });
        expectAgentsContent(await loadAgentsFile(dir), "");
        workspaces.push(dir);
      }
      expect(readFile).toHaveBeenCalledTimes(65);

      expectAgentsContent(await loadAgentsFile(workspaces[0]!), "");
      expect(readFile).toHaveBeenCalledTimes(66);
    } finally {
      readFile.mockRestore();
    }
  });

  it("shares one cache entry across canonical workspace aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const realWorkspace = path.join(workspaceDir, "real");
    const aliasWorkspace = path.join(workspaceDir, "alias");
    await fs.mkdir(realWorkspace);
    await fs.symlink(realWorkspace, aliasWorkspace, "dir");
    await writeWorkspaceFile({
      dir: realWorkspace,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# shared",
    });
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    try {
      expectAgentsContent(await loadAgentsFile(realWorkspace), "# shared");
      expectAgentsContent(await loadAgentsFile(aliasWorkspace), "# shared");
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
    }
  });

  it("invalidates cache when content changes in-place with restored mtime", async () => {
    if (process.platform === "win32") {
      return;
    }
    const content1 = "# old guidance";
    const content2 = "# new guidance";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });
    // Use integer-second mtime so utimes can restore it exactly, isolating ctime as the
    // only changed stat field after the in-place edit.
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(filePath, cleanTime, cleanTime);
    const originalStat = await fs.stat(filePath);

    const agentsFile1 = await loadSessionAgentsFile(workspaceDir, "agent:main:content-refresh");
    expectAgentsContent(agentsFile1, content1);

    await fs.writeFile(filePath, content2, "utf-8");
    await fs.utimes(filePath, originalStat.atime, originalStat.mtime);

    const editedStat = await fs.stat(filePath);
    expect(editedStat.dev).toBe(originalStat.dev);
    expect(editedStat.ino).toBe(originalStat.ino);
    expect(editedStat.size).toBe(originalStat.size);
    expect(editedStat.mtimeMs).toBe(originalStat.mtimeMs);

    const originalFstatSync = fsSync.fstatSync;
    const fstatSync = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd, options) => {
      const stat = originalFstatSync(fd, options);
      // Filesystems may coalesce rapid ctime updates; isolate the identity contract.
      if ("ctimeNs" in stat) {
        stat.ctimeNs = BigInt(Math.trunc(originalStat.ctimeMs + 1)) * 1_000_000n;
      } else {
        stat.ctimeMs = originalStat.ctimeMs + 1;
      }
      return stat;
    });
    try {
      const agentsFile2 = await loadSessionAgentsFile(workspaceDir, "agent:main:content-refresh");
      expectAgentsContent(agentsFile2, content2);
    } finally {
      fstatSync.mockRestore();
    }
  });

  it("replaces a session snapshot when inode changes with identical bytes", async () => {
    if (process.platform === "win32") {
      return;
    }
    const content = "# stable-content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
    const tempPath = path.join(workspaceDir, ".AGENTS.replacement");
    const sessionKey = "agent:main:identity-refresh";

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content,
    });
    const originalStat = await fs.stat(filePath);
    const agentsFile1 = await loadSessionAgentsFile(workspaceDir, sessionKey);
    expectAgentsContent(agentsFile1, content);

    await fs.writeFile(tempPath, content, "utf-8");
    await fs.utimes(tempPath, originalStat.atime, originalStat.mtime);
    await fs.rename(tempPath, filePath);
    await fs.utimes(filePath, originalStat.atime, originalStat.mtime);

    const agentsFile2 = await loadSessionAgentsFile(workspaceDir, sessionKey);
    expectAgentsContent(agentsFile2, content);
    expect(agentsFile2).not.toBe(agentsFile1);
  });
});

describe("workspace file cache retention", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = tempDirs.make("openclaw-file-cache-test-");
  });

  afterEach(() => {
    retireWorkspaceFileCache(workspaceRoot);
  });

  function cacheFile(name: string, sizeBytes: number, identity = name): string {
    const filePath = path.join(workspaceRoot, name);
    writeWorkspaceFileCache({
      filePath,
      content: "é".repeat(sizeBytes / 2),
      identity,
    });
    return filePath;
  }

  it("retires contained entries without evicting sibling roots", () => {
    const contained = cacheFile("contained", 2);
    const siblingRoot = `${workspaceRoot}-sibling`;
    const sibling = path.join(siblingRoot, "sibling");
    writeWorkspaceFileCache({ filePath: sibling, content: "s", identity: "sibling" });

    try {
      retireWorkspaceFileCache(workspaceRoot);

      expect(readWorkspaceFileCache(contained, "contained")).toBeUndefined();
      expect(readWorkspaceFileCache(sibling, "sibling")).toBe("s");
    } finally {
      retireWorkspaceFileCache(siblingRoot);
    }
  });
});
