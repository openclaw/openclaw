import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeNativeWorkerFailure } from "../infra/worker-native-error.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import { publishBootstrapFile } from "./workspace-bootstrap-publish.js";
import { runWorkspaceFilesystemOperation } from "./workspace-filesystem.js";
import { executeWorkspaceFilesystemOperation } from "./workspace-filesystem.worker.js";
import { runWorkspacePreparation } from "./workspace-preparation.js";
import { captureWorkspaceFilesystemEvidence } from "./workspace-state-guard.js";
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

// Inject I/O failures at the production filesystem owner; host fs spies do not cross workers.
async function publishAtFilesystemOwner(
  dir: string,
  name: string,
  content: string,
): Promise<boolean> {
  // Only these injected failures need the supported JavaScript backend. SQLite
  // private-directory creation still requires the native descriptor ACL checks.
  const nativeMode = process.env.FS_SAFE_NATIVE_MODE;
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  try {
    const reply = await executeWorkspaceFilesystemOperation(
      {
        type: "workspace",
        nativeMode: "off",
        operation: { kind: "publish", dir, name, content },
        filesystem: [await captureWorkspaceFilesystemEvidence(dir)],
        decision: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      },
      () => {},
    );
    if (reply.type === "workspace-failed") {
      throw decodeNativeWorkerFailure(reply.error);
    }
    if (reply.type === "workspace") {
      return reply.created;
    }
    throw new Error("Unexpected legacy cleanup reply during bootstrap publication");
  } finally {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", nativeMode);
  }
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
    await expect(
      publishAtFilesystemOwner(tempDir, DEFAULT_AGENTS_FILENAME, "Complete instructions\n"),
    ).rejects.toMatchObject({ cause: { code: "ENOSPC" } });
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

  it("publishes one complete winner without synchronous host workspace I/O", async () => {
    const contents = ["FIRST-COMPLETE\n", "SECOND-COMPLETE\n"];
    const canonical = await fs.realpath(tempDir);
    const probes = [
      vi.spyOn(syncFs, "statSync"),
      vi.spyOn(syncFs, "lstatSync"),
      vi.spyOn(syncFs.realpathSync, "native"),
      vi.spyOn(syncFs, "readdirSync"),
      vi.spyOn(syncFs, "openSync"),
    ];

    const created = await Promise.all(
      contents.map((content) =>
        runWorkspacePreparation(tempDir, (filesystem) =>
          publishBootstrapFile(agentsPath, content, { filesystem: [filesystem] }),
        ),
      ),
    );

    expect(created.filter(Boolean)).toHaveLength(1);
    for (const probe of probes) {
      expect(
        probe.mock.calls.filter(([file]) => {
          const target = nodeFilePath(file);
          return target && [tempDir, canonical].some((dir) => target.startsWith(dir));
        }),
      ).toHaveLength(0);
      probe.mockRestore();
    }
    expect(contents).toContain(await readAgents());
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await listTempSiblings(tempDir)).toEqual([]);
  });

  it.each([false, true])("retains the bootstrap destination (guarded=%s)", async (guarded) => {
    const original = path.join(tempDir, "original");
    const replacement = path.join(tempDir, "replacement");
    const alias = path.join(tempDir, "workspace-alias");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.mkdir(original);
    await fs.mkdir(replacement);
    await fs.symlink(original, alias, linkType);
    const guard = guarded
      ? { filesystem: [await captureWorkspaceFilesystemEvidence(alias)] }
      : undefined;

    const publication = publishBootstrapFile(
      path.join(alias, DEFAULT_AGENTS_FILENAME),
      async () => {
        await fs.unlink(alias);
        await fs.symlink(replacement, alias, linkType);
        return "original instructions\n";
      },
      guard,
    );

    if (guarded) {
      await expect(publication).rejects.toMatchObject({ code: "WORKSPACE_ALIAS_REPOINTED" });
      expect(await fs.readdir(original)).toEqual([]);
    } else {
      await expect(publication).resolves.toBe(true);
      expect(await fs.readFile(path.join(original, DEFAULT_AGENTS_FILENAME), "utf8")).toBe(
        "original instructions\n",
      );
    }
    expect(await fs.readdir(replacement)).toEqual([]);
  });

  it("pins a newly created workspace across worker effects", async () => {
    const dir = path.join(tempDir, "new-workspace");
    const guard = { filesystem: [await captureWorkspaceFilesystemEvidence(dir)] };
    await runWorkspaceFilesystemOperation({ kind: "mkdir", dir }, guard);
    await fs.rename(dir, path.join(tempDir, "original-workspace"));
    await fs.mkdir(dir);

    await expect(
      runWorkspaceFilesystemOperation(
        { kind: "publish", dir, name: DEFAULT_AGENTS_FILENAME, content: "retained target\n" },
        guard,
      ),
    ).rejects.toThrow("Workspace filesystem changed");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("rejects hardlinked bootstrap reads and publishes complete single-link bytes", async () => {
    await publishBootstrapFile(agentsPath, "COMPLETE\n");
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await loadAgents()).toMatchObject({ content: "COMPLETE\n", missing: false });

    const alias = path.join(tempDir, "agents-hardlink");
    await fs.link(agentsPath, alias);
    expect((await fs.lstat(agentsPath)).nlink).toBe(2);
    expect(await loadAgents()).toMatchObject({
      content: "[UNREADABLE: path must not be hardlinked]",
      missing: false,
    });
    await fs.unlink(alias);
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await loadAgents()).toMatchObject({ content: "COMPLETE\n", missing: false });
  });

  it("publishes complete bootstrap bytes without hard-link support", async () => {
    vi.spyOn(syncFs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });

    await expect(
      publishAtFilesystemOwner(tempDir, DEFAULT_AGENTS_FILENAME, "complete\n"),
    ).resolves.toBe(true);
    await expect(
      publishAtFilesystemOwner(tempDir, DEFAULT_AGENTS_FILENAME, "replacement\n"),
    ).resolves.toBe(false);
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
    ).rejects.toThrow("differs from the consented Template bootstrap");

    const bootstrapPath = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
    expect((await fs.readFile(bootstrapPath)).equals(content)).toBe(true);
    if (process.platform !== "win32") {
      const stat = await fs.stat(bootstrapPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
