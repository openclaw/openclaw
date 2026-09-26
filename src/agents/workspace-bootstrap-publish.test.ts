// Bootstrap publication atomicity: a failed first-time write must never leave
// a partial AGENTS.md behind, and an existing complete winner is never clobbered.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import { publishBootstrapFile } from "./workspace-bootstrap-publish.js";
import { mergeWorkspaceSetupState, readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import * as workspace from "./workspace.js";

const {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
  seedWorkspaceBootstrap,
  WorkspaceBootstrapSeedConflictError,
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
  return names
    .filter((name) => name.startsWith(".fs-safe-") || name.startsWith("openclaw-bootstrap-"))
    .toSorted();
}

describe("bootstrap publication atomicity", () => {
  it("checkpoints the pinned published object after link metadata changes", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-checkpoint-");
    const target = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
    const calls: string[] = [];
    let birthtimeNs = 101n;
    const realFstat = syncFs.fstatSync.bind(syncFs);
    const realUnlink = syncFs.unlinkSync.bind(syncFs);
    // Emulate libuv's creation-time fallback without changing any identity or content fields.
    const statSpy = vi.spyOn(syncFs, "fstatSync").mockImplementation((fd, options) => {
      if (options?.bigint) {
        const observed = realFstat(fd, { bigint: true });
        if (observed.isFile()) {
          observed.birthtimeNs = birthtimeNs;
        }
        return observed;
      }
      return realFstat(fd, options);
    });
    const unlinkSpy = vi.spyOn(syncFs, "unlinkSync").mockImplementation((filePath) => {
      realUnlink(filePath);
      if (syncFs.existsSync(target) && String(filePath) !== target) {
        birthtimeNs = 202n;
        calls.push("published");
      }
    });
    try {
      await expect(
        workspace.publishBootstrapFile(
          target,
          "complete\n",
          undefined,
          (identity) => {
            expect(syncFs.existsSync(target)).toBe(false);
            expect(identity.birthtimeNs).toBe("101");
            calls.push("before");
          },
          undefined,
          (identity) => {
            expect(syncFs.readFileSync(target, "utf8")).toBe("complete\n");
            expect(syncFs.lstatSync(target).nlink).toBe(1);
            expect(identity.birthtimeNs).toBe("202");
            calls.push("after");
          },
        ),
      ).resolves.toBe(true);
      expect(calls).toEqual(["before", "published", "after"]);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      unlinkSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "checkpoints fallback birthtime after native no-replace rename",
    async () => {
      const tempDir = await makeTempWorkspace("openclaw-bootstrap-rename-checkpoint-");
      const target = path.join(syncFs.realpathSync(tempDir), DEFAULT_BOOTSTRAP_FILENAME);
      let birthtimeNs = 101n;
      let renamed = false;
      const realFstat = syncFs.fstatSync.bind(syncFs);
      const statSpy = vi.spyOn(syncFs, "fstatSync").mockImplementation((fd, options) => {
        if (options?.bigint) {
          const observed = realFstat(fd, { bigint: true });
          if (observed.isFile()) {
            observed.birthtimeNs = birthtimeNs;
          }
          return observed;
        }
        return realFstat(fd, options);
      });
      const realLink = syncFs.linkSync.bind(syncFs);
      const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation((source, destination) => {
        if (String(destination) === target) {
          throw Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" });
        }
        return realLink(source, destination);
      });
      const realRoot = fsSafe.root;
      const restoreMoves: (() => void)[] = [];
      const rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const opened = await realRoot(...args);
        const move = opened.move.bind(opened);
        const moveSpy = vi.spyOn(opened, "move").mockImplementation(async (...moveArgs) => {
          const result = await move(...moveArgs);
          if (path.join(opened.rootReal, moveArgs[1]) === target) {
            renamed = true;
            birthtimeNs = 202n;
          }
          return result;
        });
        restoreMoves.push(() => moveSpy.mockRestore());
        return opened;
      });
      const afterPublish = vi.fn((identity: workspace.BootstrapPublicationIdentity) => {
        expect(renamed).toBe(true);
        expect(identity.birthtimeNs).toBe("202");
        expect(syncFs.readFileSync(target, "utf8")).toBe("complete\n");
      });
      const beforePublish = vi.fn((identity: workspace.BootstrapPublicationIdentity) => {
        expect(identity.birthtimeNs).toBe("101");
        expect(syncFs.existsSync(target)).toBe(false);
      });
      try {
        await expect(
          workspace.publishBootstrapFile(
            target,
            "complete\n",
            undefined,
            beforePublish,
            undefined,
            afterPublish,
          ),
        ).resolves.toBe(true);
        expect(beforePublish).toHaveBeenCalledTimes(1);
        expect(afterPublish).toHaveBeenCalledTimes(1);
        expect(await listTempSiblings(tempDir)).toEqual([]);
      } finally {
        rootSpy.mockRestore();
        for (const restore of restoreMoves) {
          restore();
        }
        linkSpy.mockRestore();
        statSpy.mockRestore();
      }
    },
  );

  it("rejects an in-place same-size staging mutation even when metadata appears unchanged", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-content-change-");
    const target = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
    const realFstat = syncFs.fstatSync.bind(syncFs);
    const realLstat = syncFs.lstatSync.bind(syncFs);
    let frozenMtimeNs: bigint | undefined;
    const preserveMtime = <T extends syncFs.Stats | syncFs.BigIntStats>(observed: T): T => {
      if (observed.isFile() && "mtimeNs" in observed) {
        frozenMtimeNs ??= observed.mtimeNs;
        observed.mtimeNs = frozenMtimeNs;
      }
      return observed;
    };
    const fstatSpy = vi
      .spyOn(syncFs, "fstatSync")
      .mockImplementation((fd, options) => preserveMtime(realFstat(fd, options) as never));
    const lstatSpy = vi
      .spyOn(syncFs, "lstatSync")
      .mockImplementation((filePath, options) =>
        preserveMtime(realLstat(filePath, options) as never),
      );
    const afterPublish = vi.fn();
    try {
      await expect(
        workspace.publishBootstrapFile(
          target,
          "COMPLETE\n",
          undefined,
          () => {
            const stagingDir = syncFs
              .readdirSync(tempDir)
              .find((name) => name.startsWith("openclaw-bootstrap-"));
            if (!stagingDir) {
              throw new Error("staging directory was not created");
            }
            syncFs.writeFileSync(
              path.join(tempDir, stagingDir, DEFAULT_BOOTSTRAP_FILENAME),
              "CORRUPT!\n",
            );
          },
          undefined,
          afterPublish,
        ),
      ).rejects.toThrow("content changed during publication");
      expect(afterPublish).not.toHaveBeenCalled();
      await expectPathMissing(target);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      lstatSpy.mockRestore();
      fstatSpy.mockRestore();
    }
  });

  it.each(["existing", "racing", "failed"] as const)(
    "does not checkpoint a %s publication",
    async (boundary) => {
      const tempDir = await makeTempWorkspace("openclaw-bootstrap-no-checkpoint-");
      const target = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
      const afterPublish = vi.fn();
      if (boundary === "existing") {
        await fs.writeFile(target, "winner\n");
      }
      const beforePublish = vi.fn(() => {
        if (boundary === "racing") {
          syncFs.writeFileSync(target, "winner\n");
        } else if (boundary === "failed") {
          throw new Error("write-ahead unavailable");
        }
      });
      const publication = workspace.publishBootstrapFile(
        target,
        "complete\n",
        undefined,
        beforePublish,
        undefined,
        afterPublish,
      );
      if (boundary === "failed") {
        await expect(publication).rejects.toThrow("write-ahead unavailable");
        await expectPathMissing(target);
      } else {
        await expect(publication).resolves.toBe(false);
        expect(await fs.readFile(target, "utf8")).toBe("winner\n");
      }
      expect(beforePublish).toHaveBeenCalledTimes(boundary === "existing" ? 0 : 1);
      expect(afterPublish).not.toHaveBeenCalled();
      expect(await listTempSiblings(tempDir)).toEqual([]);
    },
  );

  it("rejects a byte-identical replacement before completion without checkpointing it", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-replaced-");
    const target = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
    const original = path.join(tempDir, "original.md");
    const afterPublish = vi.fn();
    const realUnlink = syncFs.unlinkSync.bind(syncFs);
    let replaced = false;
    const unlinkSpy = vi.spyOn(syncFs, "unlinkSync").mockImplementation((filePath) => {
      realUnlink(filePath);
      if (!replaced && syncFs.existsSync(target)) {
        replaced = true;
        syncFs.renameSync(target, original);
        syncFs.writeFileSync(target, "complete\n");
      }
    });
    try {
      await expect(
        workspace.publishBootstrapFile(
          target,
          "complete\n",
          undefined,
          undefined,
          undefined,
          afterPublish,
        ),
      ).rejects.toThrow("identity changed during publication");
      expect(replaced).toBe(true);
      expect(afterPublish).not.toHaveBeenCalled();
      expect(await fs.readFile(target, "utf8")).toBe("complete\n");
      expect((await fs.stat(target)).ino).not.toBe((await fs.stat(original)).ino);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("does not publish a partial AGENTS.md when the first write fails", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const failure = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);

    try {
      await expect(
        withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
          ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
        ),
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
        await expect(workspace.publishBootstrapFile(agentsPath, "replacement\n")).resolves.toBe(
          false,
        );
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
      await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
        publishBootstrapFile(agentsPath, "COMPLETE\n"),
      );
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
      const error = await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
        publishBootstrapFile(agentsPath, "complete\n").catch((caught: unknown) => caught),
      );
      if (!(error instanceof fsSafe.FsSafeError) || !(error.cause instanceof AggregateError)) {
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
      await expect(
        withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
          publishBootstrapFile(agentsPath, "complete\n"),
        ),
      ).rejects.toThrow(/filesystem does not support atomic bootstrap publication/u);
      await expectPathMissing(agentsPath);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("rejects a nested publication parent redirected outside its boundary", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-boundary-");
    const outsideDir = await makeTempWorkspace("openclaw-workspace-outside-");
    const nestedDir = path.join(tempDir, "nested");
    await fs.mkdir(nestedDir);
    await fs.rm(nestedDir, { recursive: true });
    await fs.symlink(outsideDir, nestedDir, process.platform === "win32" ? "junction" : "dir");

    await expect(
      workspace.publishBootstrapFile(
        path.join(nestedDir, DEFAULT_BOOTSTRAP_FILENAME),
        "complete\n",
        undefined,
        undefined,
        undefined,
        undefined,
        tempDir,
      ),
    ).rejects.toThrow("escaped its publication boundary");
    await expectPathMissing(path.join(outsideDir, DEFAULT_BOOTSTRAP_FILENAME));
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

  it("refuses a pre-existing BOOTSTRAP.md in conflict mode without stamping the seed state", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const stateOptions = {
      env: { OPENCLAW_STATE_DIR: await makeTempWorkspace("openclaw-state-") },
    };
    const content = Buffer.from("# BOOTSTRAP\n");
    await fs.writeFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), content);

    // A caller that never wrote the file must not adopt it as its seed, and the identical bytes
    // must not turn into a bootstrapSeededAt stamp that a later seed would read as consumed.
    await expect(
      seedWorkspaceBootstrap({
        dir: tempDir,
        content,
        existingFile: "conflict",
        stateOptions,
      }),
    ).rejects.toBeInstanceOf(WorkspaceBootstrapSeedConflictError);
    expect(
      // readWorkspaceStateSnapshot is synchronous on this base and awaited on newer ones; resolve both.
      (await Promise.resolve(readWorkspaceStateSnapshot(tempDir, stateOptions))).setup
        .bootstrapSeededAt,
    ).toBeUndefined();

    await expect(seedWorkspaceBootstrap({ dir: tempDir, content, stateOptions })).resolves.toBe(
      "already-seeded",
    );
  });

  it("refuses a BOOTSTRAP.md that appears after preview for a completed workspace", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const stateOptions = {
      env: { OPENCLAW_STATE_DIR: await makeTempWorkspace("openclaw-state-") },
    };
    const content = Buffer.from("# BOOTSTRAP\n");
    await mergeWorkspaceSetupState(
      tempDir,
      { setupCompletedAt: "2026-09-24T00:00:00.000Z" },
      1,
      stateOptions,
    );
    await fs.writeFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), content);

    await expect(
      seedWorkspaceBootstrap({
        dir: tempDir,
        content,
        existingFile: "conflict",
        stateOptions,
      }),
    ).rejects.toBeInstanceOf(WorkspaceBootstrapSeedConflictError);
  });
});
