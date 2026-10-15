import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import * as workspaceBootstrapRead from "./workspace-bootstrap-read.js";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";
import { loadWorkspaceBootstrapFiles, DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("workspace bootstrap file caching", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = tempDirs.make("openclaw-bootstrap-cache-test-");
  });

  const agentsPath = (dir = workspaceDir) => path.join(dir, DEFAULT_AGENTS_FILENAME);
  const writeAgents = (content: string, dir = workspaceDir) =>
    fs.writeFile(agentsPath(dir), content);
  async function expectAgents(content: string, dir = workspaceDir) {
    const files = await loadWorkspaceBootstrapFiles(dir);
    expect(files.find((f) => f.name === DEFAULT_AGENTS_FILENAME)).toMatchObject({
      content,
      missing: false,
    });
  }

  it("evicts the oldest cached file after 64 empty entries", async () => {
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    for (let index = 0; index <= 64; index += 1) {
      const dir = path.join(workspaceDir, String(index));
      await fs.mkdir(dir);
      await writeAgents("", dir);
      await expectAgents("", dir);
    }
    expect(readFile).toHaveBeenCalledTimes(65);
    await expectAgents("", path.join(workspaceDir, "0"));
    expect(readFile).toHaveBeenCalledTimes(66);
  });

  it("shares one cache entry across canonical workspace aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const realWorkspace = path.join(workspaceDir, "real");
    const aliasWorkspace = path.join(workspaceDir, "alias");
    await fs.mkdir(realWorkspace);
    await fs.symlink(realWorkspace, aliasWorkspace, "dir");
    await writeAgents("# shared", realWorkspace);
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    await expectAgents("# shared", realWorkspace);
    await expectAgents("# shared", aliasWorkspace);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache when content changes in-place with restored mtime", async () => {
    if (process.platform === "win32") {
      return;
    }
    const content1 = "# old guidance";
    const content2 = "# new guidance";
    const filePath = agentsPath();
    await writeAgents(content1);
    // Use integer-second mtime so utimes can restore it exactly, isolating ctime as the
    // only changed stat field after the in-place edit.
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(filePath, cleanTime, cleanTime);
    const originalStat = await fs.stat(filePath);

    await expectAgents(content1);

    await fs.writeFile(filePath, content2, "utf-8");
    await fs.utimes(filePath, originalStat.atime, originalStat.mtime);

    const editedStat = await fs.stat(filePath);
    const { dev, ino, size, mtimeMs } = originalStat;
    expect(editedStat).toMatchObject({ dev, ino, size, mtimeMs });

    const originalFstatSync = fsSync.fstatSync;
    vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd, options) => {
      const stat = originalFstatSync(fd, options);
      // Filesystems may coalesce rapid ctime updates; isolate the identity contract.
      if ("ctimeNs" in stat) {
        stat.ctimeNs = BigInt(Math.trunc(originalStat.ctimeMs + 1)) * 1_000_000n;
      } else {
        stat.ctimeMs = originalStat.ctimeMs + 1;
      }
      return stat;
    });
    await expectAgents(content2);
  });

  it("invalidates cached content when distinct exact file IDs have the same numeric value", async () => {
    const filePath = agentsPath();
    await writeAgents("# old guidance");
    let fileId = 9_007_199_254_740_992n;
    const openRootFile = boundaryFileRead.openRootFile;
    vi.spyOn(boundaryFileRead, "openRootFile").mockImplementation(async (params) => {
      const opened = await openRootFile(params);
      if (!opened.ok || params.absolutePath !== filePath) {
        return opened;
      }
      return {
        ...opened,
        stat: Object.assign(opened.stat, { ino: Number(fileId), mtimeMs: 1, ctimeMs: 1 }),
        exactIdentity: { ...opened.exactIdentity, ino: fileId },
      };
    });
    await expectAgents("# old guidance");
    await expectAgents("# old guidance");
    await writeAgents("# new guidance");
    fileId += 1n;
    expect(Number(fileId)).toBe(Number(fileId - 1n));
    await expectAgents("# new guidance");
  });
});

it("retires contained cache entries without evicting sibling roots", () => {
  const workspaceRoot = tempDirs.make("openclaw-file-cache-test-");
  const contained = path.join(workspaceRoot, "contained");
  writeWorkspaceFileCache({ filePath: contained, content: "é", identity: "contained" });
  const siblingRoot = `${workspaceRoot}-sibling`;
  const sibling = path.join(siblingRoot, "sibling");
  writeWorkspaceFileCache({ filePath: sibling, content: "s", identity: "sibling" });

  try {
    retireWorkspaceFileCache(workspaceRoot);

    expect(readWorkspaceFileCache(contained, "contained")).toBeUndefined();
    expect(readWorkspaceFileCache(sibling, "sibling")).toBe("s");
  } finally {
    retireWorkspaceFileCache(workspaceRoot);
    retireWorkspaceFileCache(siblingRoot);
  }
});

it("accounts for the prepared identity prompt while retaining the raw avatar", () => {
  const workspaceRoot = tempDirs.make("openclaw-identity-prompt-cache-test-");
  const identityPath = path.join(workspaceRoot, "IDENTITY.md");
  const oldest = path.join(workspaceRoot, "oldest");
  const recent = path.join(workspaceRoot, "recent");
  const raw = `- Avatar: data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}\n${"x".repeat(1024 * 1024)}`;
  try {
    writeWorkspaceFileCache({ filePath: identityPath, content: raw, identity: "avatar" });
    writeWorkspaceFileCache({
      filePath: oldest,
      content: "é".repeat(2 * 1024 * 1024),
      identity: "oldest",
    });
    writeWorkspaceFileCache({
      filePath: recent,
      content: "é".repeat(2 * 1024 * 1024),
      identity: "recent",
    });

    const prompt = readWorkspaceFileCache(identityPath, "avatar", "IDENTITY.md");

    expect(prompt).toBe(`- Avatar: [inline image omitted]\n${"x".repeat(1024 * 1024)}`);
    expect(readWorkspaceFileCache(oldest, "oldest")).toBeUndefined();
    expect(readWorkspaceFileCache(recent, "recent")).toBeDefined();
    expect(readWorkspaceFileCache(identityPath, "avatar")).toBe(raw);
    expect(readWorkspaceFileCache(identityPath, "avatar", "IDENTITY.md")).toBe(prompt);
  } finally {
    retireWorkspaceFileCache(workspaceRoot);
  }
});
