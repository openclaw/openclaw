import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import { publishBootstrapFile } from "./workspace-bootstrap-publish.js";
import * as workspace from "./workspace.js";

const {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
  seedWorkspaceBootstrap,
} = workspace;

async function injectPartialPublicationFailure(dir: string, fileName: string) {
  const realOpen = fs.open.bind(fs);
  const resolvedDir = await fs.realpath(dir);
  let injected = true;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, ...rest) => {
    const handle = await realOpen(file, flags, ...rest);
    const rawPath = nodeFilePath(file);
    const target = rawPath && path.resolve(rawPath);
    const exclusiveCreate =
      typeof flags === "number" &&
      (flags & syncFs.constants.O_CREAT) !== 0 &&
      (flags & syncFs.constants.O_EXCL) !== 0;
    if (
      injected &&
      target &&
      (target === path.join(resolvedDir, fileName) ||
        (path.dirname(target) === resolvedDir && exclusiveCreate))
    ) {
      injected = false;
      vi.spyOn(handle, "write").mockImplementationOnce(async () => {
        await handle.writeFile("# PARTIAL\n");
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      });
    }
    return handle;
  });
  return () => openSpy.mockRestore();
}

async function listTempSiblings(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.startsWith(".fs-safe-")).toSorted();
}

describe("bootstrap publication atomicity", () => {
  const readOnly = process.platform !== "win32" && process.getuid?.() !== 0;
  let tempDir: string;
  let agentsPath: string;
  const ensure = () => ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
  const readAgents = () => fs.readFile(agentsPath, "utf8");
  const loadAgents = async () =>
    (await workspace.loadWorkspaceBootstrapFiles(tempDir)).find(
      (file) => file.name === DEFAULT_AGENTS_FILENAME,
    );
  beforeEach(async () => {
    // Inject actual write/publication failures through the supported JavaScript backend.
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    tempDir = await makeTempWorkspace("openclaw-workspace-");
    agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.chmod(tempDir, 0o700);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not publish a partial AGENTS.md when the first write fails", async () => {
    const restore = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);
    await expect(ensure()).rejects.toMatchObject({ cause: { code: "ENOSPC" } });
    await expect(fs.access(agentsPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(await listTempSiblings(tempDir)).toEqual([]);
    restore();
    await ensure();
    const content = await readAgents();
    expect(content).not.toBe("# PARTIAL\n");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it.runIf(readOnly)("reuses read-only workspaces", async () => {
    const files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
    for (const name of files) {
      await fs.writeFile(path.join(tempDir, name), `Authored ${name}\n`);
    }
    await ensure();
    await fs.chmod(tempDir, 0o555);
    await ensure();
    for (const name of files) {
      expect(await fs.readFile(path.join(tempDir, name), "utf8")).toBe(`Authored ${name}\n`);
    }
    expect((await fs.readdir(tempDir)).toSorted()).toEqual(files.toSorted());
  });

  it.runIf(readOnly)("preserves read-only dangling symlinks", async () => {
    await fs.symlink("missing.md", agentsPath);
    await fs.chmod(tempDir, 0o555);

    await expect(publishBootstrapFile(agentsPath, "replacement\n")).resolves.toBe(false);
    expect(await fs.readlink(agentsPath)).toBe("missing.md");
    expect(await fs.readdir(tempDir)).toEqual([DEFAULT_AGENTS_FILENAME]);
  });

  it("publishes one complete winner", async () => {
    const contents = ["FIRST-COMPLETE\n", "SECOND-COMPLETE\n"];

    const created = await Promise.all(
      contents.map((content) => publishBootstrapFile(agentsPath, content)),
    );

    expect(created.filter(Boolean)).toHaveLength(1);
    expect(contents).toContain(await readAgents());
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await listTempSiblings(tempDir)).toEqual([]);
  });

  it("rejects observable two-link reads and publishes complete single-link bytes", async () => {
    const realLink = syncFs.linkSync.bind(syncFs);
    let concurrentRead: ReturnType<typeof workspace.loadWorkspaceBootstrapFiles> | undefined;
    vi.spyOn(syncFs, "linkSync").mockImplementation((source, target) => {
      realLink(source, target);
      concurrentRead = workspace.loadWorkspaceBootstrapFiles(tempDir);
    });

    await publishBootstrapFile(agentsPath, "COMPLETE\n");
    expect(concurrentRead).toBeDefined();
    const intervalAgents = (await concurrentRead!).find(
      (file) => file.name === DEFAULT_AGENTS_FILENAME,
    );
    // Windows removes the staging link synchronously before this async read resumes.
    expect(intervalAgents).toMatchObject({
      content:
        process.platform === "win32" ? "COMPLETE\n" : "[UNREADABLE: path must not be hardlinked]",
      missing: false,
    });
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await loadAgents()).toMatchObject({ content: "COMPLETE\n", missing: false });
  });

  it("publishes complete bootstrap bytes without hard-link support", async () => {
    vi.spyOn(syncFs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });

    await expect(publishBootstrapFile(agentsPath, "complete\n")).resolves.toBe(true);
    await expect(publishBootstrapFile(agentsPath, "replacement\n")).resolves.toBe(false);
    expect(await readAgents()).toBe("complete\n");
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await listTempSiblings(tempDir)).toEqual([]);
  });

  it("preserves the raw bootstrap bytes including a UTF-8 BOM", async () => {
    // TextDecoder strips the BOM, but approval and existing-winner checks require raw bytes.
    const content = Buffer.from("\ufeff# BOOTSTRAP\n", "utf8");

    await expect(seedWorkspaceBootstrap({ dir: tempDir, content })).resolves.toBe("seeded");
    await expect(seedWorkspaceBootstrap({ dir: tempDir, content })).resolves.toBe("already-seeded");
    await expect(
      seedWorkspaceBootstrap({ dir: tempDir, content: Buffer.from("# Different bootstrap\n") }),
    ).rejects.toThrow("differs from the consented Claw bootstrap");

    const bootstrapPath = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
    expect((await fs.readFile(bootstrapPath)).equals(content)).toBe(true);
    if (process.platform !== "win32") {
      const stat = await fs.stat(bootstrapPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
