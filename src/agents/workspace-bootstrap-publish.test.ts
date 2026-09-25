// Bootstrap publication atomicity: a failed first-time write must never leave
// a partial AGENTS.md behind, and an existing complete winner is never clobbered.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { describe, expect, it, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import {
  publishBootstrapFile,
  WorkspaceBootstrapSeedConflictError,
  type BootstrapPublicationIdentity,
} from "./workspace-bootstrap-publish.js";
import { injectPartialPublicationFailure } from "./workspace-bootstrap-publish.test-support.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";
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

async function listTempSiblings(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.startsWith("openclaw-bootstrap-")).toSorted();
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
        publishBootstrapFile(
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
      const afterPublish = vi.fn((identity: BootstrapPublicationIdentity) => {
        expect(renamed).toBe(true);
        expect(identity.birthtimeNs).toBe("202");
        expect(syncFs.readFileSync(target, "utf8")).toBe("complete\n");
      });
      try {
        await expect(
          publishBootstrapFile(
            target,
            "complete\n",
            undefined,
            (identity) => {
              expect(identity.birthtimeNs).toBe("101");
              expect(syncFs.existsSync(target)).toBe(false);
            },
            undefined,
            afterPublish,
          ),
        ).resolves.toBe(true);
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
      const publication = publishBootstrapFile(
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
        publishBootstrapFile(target, "complete\n", undefined, undefined, undefined, afterPublish),
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
    const injection = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);

    try {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      injection.assertInjected();
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      injection.restore();
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
    const injection = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);
    const realRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (filePath, options) => {
      const target = nodeFilePath(filePath);
      if (target && path.basename(target).startsWith("openclaw-bootstrap-")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      await realRm(filePath, options);
    });

    try {
      const error = await publishBootstrapFile(agentsPath, "complete\n").catch(
        (caught: unknown) => caught,
      );
      injection.assertInjected();
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toMatchObject([
        { code: "ENOSPC" },
        { code: "EACCES" },
      ]);
      expect(error).toMatchObject({
        message: expect.stringMatching(/publication and staging cleanup failed/u),
      });
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toHaveLength(1);
    } finally {
      injection.restore();
      rmSpy.mockRestore();
    }
  });

  it("fails closed without hardlinks or native no-replace publication", async () => {
    const nativeConfig = getFsSafeNativeConfig();
    configureFsSafeNative({ mode: "off" });
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const realLink = syncFs.linkSync.bind(syncFs);
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation((source, target) => {
      if (String(target) === path.join(syncFs.realpathSync(tempDir), DEFAULT_AGENTS_FILENAME)) {
        throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
      }
      return realLink(source, target);
    });

    try {
      await expect(publishBootstrapFile(agentsPath, "complete\n")).rejects.toMatchObject({
        code: "helper-unavailable",
      });
      await expectPathMissing(agentsPath);
    } finally {
      linkSpy.mockRestore();
      configureFsSafeNative(nativeConfig);
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
      (await readWorkspaceStateSnapshot(tempDir, stateOptions)).setup.bootstrapSeededAt,
    ).toBeUndefined();

    await expect(seedWorkspaceBootstrap({ dir: tempDir, content, stateOptions })).resolves.toBe(
      "already-seeded",
    );
  });
});
