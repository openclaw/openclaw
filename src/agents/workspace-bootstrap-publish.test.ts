// Bootstrap publication atomicity: a failed first-time write must never leave
// a partial AGENTS.md behind, and an existing complete winner is never clobbered.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../infra/fs-safe.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv, setTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import { publishBootstrapFile } from "./workspace-bootstrap-publish.js";
import * as workspace from "./workspace.js";

const {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
  seedWorkspaceBootstrap,
} = workspace;

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

async function injectPartialPublicationFailure(dir: string, fileName: string) {
  const realOpen = fs.open.bind(fs);
  const resolvedDir = await fs.realpath(dir);
  const targetPath = path.join(resolvedDir, fileName);
  const stagedPaths: string[] = [];
  let injected = true;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const rawPath = nodeFilePath(args[0]);
    if (!rawPath) {
      return handle;
    }
    const target = path.resolve(rawPath);
    const exclusiveCreate =
      typeof args[1] === "number" &&
      (args[1] & syncFs.constants.O_CREAT) !== 0 &&
      (args[1] & syncFs.constants.O_EXCL) !== 0;
    if (
      injected &&
      (target === targetPath || (path.dirname(target) === resolvedDir && exclusiveCreate))
    ) {
      injected = false;
      stagedPaths.push(target);
      vi.spyOn(handle, "write").mockImplementationOnce(async () => {
        await handle.writeFile("# PARTIAL\n");
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      });
    }
    return handle;
  });
  return {
    restore: () => openSpy.mockRestore(),
    stagedPaths,
  };
}

async function listTempSiblings(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.startsWith(".fs-safe-")).toSorted();
}

describe("bootstrap publication atomicity", () => {
  let nativeModeEnv: ReturnType<typeof captureEnv>;
  beforeEach(() => {
    nativeModeEnv = captureEnv(["FS_SAFE_NATIVE_MODE"]);
    // Inject actual write/publication failures through the supported JavaScript backend.
    setTestEnvValue("FS_SAFE_NATIVE_MODE", "off");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    nativeModeEnv.restore();
  });

  it("does not publish a partial AGENTS.md when the first write fails", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const failure = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);

    try {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({ cause: { code: "ENOSPC" } });
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      failure.restore();
    }

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const content = await fs.readFile(agentsPath, "utf-8");
    expect(content).not.toBe("# PARTIAL\n");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("leaves an existing complete AGENTS.md winner unchanged", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "WINNER\n", "utf-8");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    expect(await fs.readFile(agentsPath, "utf-8")).toBe("WINNER\n");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reuses an established read-only workspace without creating bootstrap files",
    async () => {
      const tempDir = await makeTempWorkspace("openclaw-workspace-readonly-");
      const files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
      for (const name of files) {
        await fs.writeFile(path.join(tempDir, name), `Authored ${name}\n`);
      }
      await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
      await fs.chmod(tempDir, 0o555);

      try {
        await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

        for (const name of files) {
          expect(await fs.readFile(path.join(tempDir, name), "utf8")).toBe(`Authored ${name}\n`);
        }
        expect((await fs.readdir(tempDir)).toSorted()).toEqual(files.toSorted());
      } finally {
        await fs.chmod(tempDir, 0o700);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "preserves an existing dangling bootstrap symlink in a read-only workspace",
    async () => {
      const tempDir = await makeTempWorkspace("openclaw-workspace-dangling-");
      const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
      await fs.symlink("missing.md", agentsPath);
      await fs.chmod(tempDir, 0o555);

      try {
        await expect(publishBootstrapFile(agentsPath, "replacement\n")).resolves.toBe(false);
        expect(await fs.readlink(agentsPath)).toBe("missing.md");
        expect(await fs.readdir(tempDir)).toEqual([DEFAULT_AGENTS_FILENAME]);
      } finally {
        await fs.chmod(tempDir, 0o700);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("publishes through a workspace symlink", async () => {
    const root = await makeTempWorkspace("openclaw-workspace-alias-");
    const workspaceDir = path.join(root, "workspace");
    const workspaceAlias = path.join(root, "workspace-alias");
    await fs.mkdir(workspaceDir);
    await fs.symlink(workspaceDir, workspaceAlias, "dir");

    await ensureAgentWorkspace({ dir: workspaceAlias, ensureBootstrapFiles: true });

    const agents = await fs.readFile(path.join(workspaceDir, DEFAULT_AGENTS_FILENAME), "utf8");
    expect(agents.trim().length).toBeGreaterThan(0);
  });

  it.each(["off", "auto"])("publishes one complete winner with native mode %s", async (mode) => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const contents = ["FIRST-COMPLETE\n", "SECOND-COMPLETE\n"];

    const created = await withEnvAsync({ FS_SAFE_NATIVE_MODE: mode }, () =>
      Promise.all(contents.map(async (content) => await publishBootstrapFile(agentsPath, content))),
    );

    expect(created.filter(Boolean)).toHaveLength(1);
    expect(contents).toContain(await fs.readFile(agentsPath, "utf8"));
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await listTempSiblings(tempDir)).toEqual([]);
  });

  it("keeps a safe reader on the complete single-link file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const realLink = syncFs.linkSync.bind(syncFs);
    let concurrentRead: ReturnType<typeof workspace.loadWorkspaceBootstrapFiles> | undefined;
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation((source, target) => {
      realLink(source, target);
      concurrentRead = workspace.loadWorkspaceBootstrapFiles(tempDir);
    });

    try {
      await publishBootstrapFile(agentsPath, "COMPLETE\n");
      if (!concurrentRead) {
        throw new Error("concurrent reader was not started");
      }
      const agents = (await concurrentRead).find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents).toMatchObject({ content: "COMPLETE\n", missing: false });
      expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("reports a staging cleanup failure with the publication error", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const failure = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      const target = nodeFilePath(filePath);
      if (target && failure.stagedPaths.includes(target)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      await realUnlink(filePath);
    });

    try {
      const error = await publishBootstrapFile(agentsPath, "complete\n").catch(
        (caught: unknown) => caught,
      );
      if (!(error instanceof FsSafeError) || !(error.cause instanceof AggregateError)) {
        throw new Error("Expected publication and cleanup failure evidence", { cause: error });
      }
      expect(error.cause.errors).toMatchObject([{ code: "ENOSPC" }, { code: "EACCES" }]);
      expect(error).toMatchObject({
        details: {
          publication: { status: "not-published" },
          cleanup: { status: "failed" },
        },
      });
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toHaveLength(1);
    } finally {
      failure.restore();
      unlinkSpy.mockRestore();
    }
  });

  it("fails closed when the workspace does not support hard links", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });

    try {
      await expect(publishBootstrapFile(agentsPath, "complete\n")).rejects.toThrow(
        /filesystem does not support atomic bootstrap publication/u,
      );
      await expectPathMissing(agentsPath);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("preserves the raw bootstrap bytes including a UTF-8 BOM", async () => {
    // The Claw bootstrap flow approves raw bytes and later re-verifies them by
    // byte equality. Writing the decoded text (TextDecoder strips a leading
    // BOM) would persist different bytes and trip the existing-winner check.
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.concat([bom, Buffer.from("# BOOTSTRAP\n")]);

    await expect(seedWorkspaceBootstrap({ dir: tempDir, content })).resolves.toBe("seeded");

    const written = await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    expect(written.equals(content)).toBe(true);
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
