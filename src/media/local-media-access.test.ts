// Local media access tests cover workspace path authorization.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import {
  assertLocalMediaAllowed,
  LocalMediaAccessError,
  readLocalMediaFile,
} from "./local-media-access.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const { hoistedRoots } = vi.hoisted(() => ({ hoistedRoots: [] as string[] }));

vi.mock("./local-roots.js", () => ({
  getDefaultMediaLocalRoots: () => hoistedRoots,
}));

async function write(file: string, contents = "png") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function denied(operation: Promise<void>, message?: string) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LocalMediaAccessError);
  expect(error).toMatchObject({
    name: "LocalMediaAccessError",
    code: "path-not-allowed",
    ...(message ? { message } : {}),
  });
}

const read = (file: string, roots: string[], inboundRoots?: string[]) =>
  readLocalMediaFile(file, roots, { maxBytes: 1024, ...(inboundRoots ? { inboundRoots } : {}) });

describe("assertLocalMediaAllowed", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    hoistedRoots.length = 0;
  });

  it("joins excluded-root preparation before reporting an allowed-root failure", async () => {
    const directory = tempDirs.make("ocl-local-media-drain-");
    const file = path.join(directory, "image.png");
    const excluded = path.join(directory, "excluded");
    await write(file);
    const roots = Promise.withResolvers<readonly string[]>();
    const excludedRoot = Promise.withResolvers<string>();
    // Containment canonicalizes through native realpath(3); hold only the excluded root.
    const originalRealpath = nodeFs.realpath.native;
    let pendingRealpaths = 0;
    type RealpathCallback = (error: NodeJS.ErrnoException | null, resolved: string) => void;
    const realpath = vi.spyOn(nodeFs.realpath, "native").mockImplementation(((
      value: string,
      callback: RealpathCallback,
    ) => {
      if (value === excluded) {
        void excludedRoot.promise.then((resolved) => callback(null, resolved));
        return;
      }
      pendingRealpaths++;
      originalRealpath(value, (error, resolved) => {
        pendingRealpaths--;
        callback(error, resolved);
      });
    }) as unknown as typeof nodeFs.realpath.native);
    const opened = vi.spyOn(fs, "open");
    const resolveRoots = vi.fn(() => roots.promise);
    let settled = false;
    const reading = readLocalMediaFile(file, [directory], {
      maxBytes: 1024,
      resolveRoots,
      excludedRoots: [excluded],
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const failure = new Error("allowed roots retired");
    try {
      await vi.waitFor(() => expect(realpath).toHaveBeenCalledWith(excluded, expect.any(Function)));
      await vi.waitFor(() => expect(resolveRoots).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(pendingRealpaths).toBe(0));
      roots.reject(failure);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(opened).not.toHaveBeenCalled();
      excludedRoot.resolve(excluded);
      expect(await reading).toBe(failure);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      roots.resolve([directory]);
      excludedRoot.resolve(excluded);
      await reading;
      realpath.mockRestore();
      opened.mockRestore();
    }
  });

  it("allows managed inbound media paths before explicit root checks", async () => {
    const stateDir = resolveStateDir();
    const id = `managed-local-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await write(filePath);

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("does not allow nested inbound paths as managed media", async () => {
    const stateDir = resolveStateDir();
    const filePath = path.join(stateDir, "media", "inbound", "nested", "hidden.png");
    await write(filePath);

    try {
      await denied(
        assertLocalMediaAllowed(filePath, []),
        `Local media path is not under an allowed directory: ${filePath}. Use a file inside the agent workspace or another allowed media folder.`,
      );
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("rejects workspace-* sibling paths when localRoots is undefined (unscoped)", async () => {
    const tmpDir = tempDirs.make("ocl-local-media-");
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await write(mediaPath, "<html>test</html>");

    hoistedRoots.length = 0;
    hoistedRoots.push(workspaceDir);

    await denied(assertLocalMediaAllowed(mediaPath, undefined));
  });

  it("allows only the explicitly scoped workspace-* path under a broad root", async () => {
    const tmpDir = tempDirs.make("ocl-local-media-");
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    const workspaceMerlinDir = path.join(tmpDir, "workspace-merlin");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });
    await fs.mkdir(workspaceMerlinDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    const siblingMediaPath = path.join(workspaceMerlinDir, "secret.html");
    await fs.writeFile(mediaPath, "<html>test</html>");
    await fs.writeFile(siblingMediaPath, "<html>secret</html>");

    const roots = [tmpDir, workspaceDir, workspaceXiaoqianDir];
    await expect(assertLocalMediaAllowed(mediaPath, roots)).resolves.toBeUndefined();
    await expect(assertLocalMediaAllowed(siblingMediaPath, roots)).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps sibling isolation when the default workspace is symlinked",
    async () => {
      const tmpDir = tempDirs.make("ocl-local-media-symlink-");
      const stateDir = path.join(tmpDir, "state");
      const workspaceDir = path.join(stateDir, "workspace");
      const realWorkspaceDir = path.join(tmpDir, "main-real");
      const ownWorkspaceDir = path.join(stateDir, "workspace-xiaoqian");
      const siblingWorkspaceDir = path.join(stateDir, "workspace-merlin");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(realWorkspaceDir, { recursive: true });
      await fs.symlink(realWorkspaceDir, workspaceDir);
      const ownMediaPath = path.join(ownWorkspaceDir, "report.html");
      const siblingMediaPath = path.join(siblingWorkspaceDir, "secret.html");
      await write(ownMediaPath, "<html>test</html>");
      await write(siblingMediaPath, "<html>secret</html>");

      const roots = [tmpDir, workspaceDir, ownWorkspaceDir];
      await expect(assertLocalMediaAllowed(ownMediaPath, roots)).resolves.toBeUndefined();
      await expect(assertLocalMediaAllowed(siblingMediaPath, roots)).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads through an in-root directory symlink but rejects a final symlink",
    async () => {
      const base = tempDirs.make("openclaw-media-root-alias-");
      const root = path.join(base, "root");
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      const realFile = path.join(realDir, "inside.bin");
      const aliasFile = path.join(aliasDir, "inside.bin");
      const finalLink = path.join(root, "final.bin");
      await write(realFile, "inside");
      await fs.symlink(realDir, aliasDir);
      await fs.symlink(realFile, finalLink);

      await expect(read(aliasFile, [root])).resolves.toEqual(Buffer.from("inside"));
      await expect(read(finalLink, [root])).rejects.toMatchObject({ code: "symlink" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects inbound-root reads through a pre-existing directory symlink outside the root",
    async () => {
      const base = tempDirs.make("openclaw-inbound-root-alias-");
      const inboundRoot = path.join(base, "inbound");
      const outsideDir = path.join(base, "outside");
      const aliasDir = path.join(inboundRoot, "alias");
      const filePath = path.join(aliasDir, "secret.bin");
      await fs.mkdir(inboundRoot, { recursive: true });
      await write(path.join(outsideDir, "secret.bin"), "outside-secret");
      await fs.symlink(outsideDir, aliasDir);

      await expect(read(filePath, [], [inboundRoot])).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects inbound wildcard reads when a nested directory symlink retargets before open",
    async () => {
      const base = tempDirs.make("openclaw-inbound-root-race-");
      const inboundRoot = path.join(base, "alice", "Attachments");
      const insideDir = path.join(inboundRoot, "inside");
      const outsideDir = path.join(base, "outside");
      const aliasDir = path.join(inboundRoot, "slot");
      const filePath = path.join(aliasDir, "report.csv");
      await write(path.join(insideDir, "report.csv"), "inside");
      await write(path.join(outsideDir, "report.csv"), "outside-secret");
      await fs.symlink(insideDir, aliasDir);
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (openedPath !== filePath) {
            return;
          }
          await fs.rm(aliasDir);
          await fs.symlink(outsideDir, aliasDir);
        },
      });

      await expect(
        read(filePath, [], [path.join(base, "*", "Attachments")]),
        // fs-safe 0.5.2 reports pre-open identity drift as path-mismatch.
      ).rejects.toMatchObject({ code: "path-mismatch" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects inbound wildcard roots whose wildcard segment already resolves outside the anchor",
    async () => {
      const base = tempDirs.make("openclaw-inbound-anchor-");
      const outside = tempDirs.make("openclaw-inbound-outside-");
      const alias = path.join(base, "alice");
      const outsideAttachments = path.join(outside, "Attachments");
      const filePath = path.join(alias, "Attachments", "secret.bin");
      await write(path.join(outsideAttachments, "secret.bin"), "outside-secret");
      await fs.symlink(outside, alias);

      await expect(read(filePath, [], [path.join(base, "*", "Attachments")])).rejects.toMatchObject(
        { code: "path-not-allowed" },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects hardlink aliases inside channel inbound roots",
    async () => {
      const base = tempDirs.make("openclaw-inbound-hardlink-");
      const inboundRoot = path.join(base, "inbound");
      const outsidePath = path.join(base, "outside.bin");
      const filePath = path.join(inboundRoot, "alias.bin");
      await fs.mkdir(inboundRoot, { recursive: true });
      await fs.writeFile(outsidePath, "outside-secret");
      await fs.link(outsidePath, filePath);

      await expect(read(filePath, [], [inboundRoot])).rejects.toMatchObject({ code: "hardlink" });
    },
  );

  it("keeps missing managed paths available to authorized custom readers", async () => {
    const stateDir = resolveStateDir();
    const inboundRoot = path.join(stateDir, "media", "inbound");
    const filePath = path.join(
      inboundRoot,
      `virtual-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
    );

    await expect(
      assertLocalMediaAllowed(filePath, [], { inboundRoots: [inboundRoot] }),
    ).resolves.toBeUndefined();
  });

  it("preserves valid root-level wildcard inbound patterns", async () => {
    const root = tempDirs.make("openclaw-inbound-root-wildcard-");
    const filePath = path.join(root, "inside.bin");
    await fs.writeFile(filePath, "inside");

    await expect(
      readLocalMediaFile(filePath, [], {
        inboundRoots: ["/*"],
        maxBytes: 1024,
      }),
    ).resolves.toEqual(Buffer.from("inside"));
  });

  it("preserves not-found and not-file errors for root-bound reads", async () => {
    const root = tempDirs.make("openclaw-media-read-errors-");
    await expect(read(path.join(root, "missing.bin"), [root])).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(read(root, [root])).rejects.toMatchObject({
      code: "not-file",
    });
  });
});

describe.runIf(process.platform !== "win32")(
  "missing descendants under symlinked roots (#194406)",
  () => {
    type Verdict = "ok" | "not-found" | "path-not-allowed";
    type Short = "ok" | "missing" | "deny";
    const full = { ok: "ok", missing: "not-found", deny: "path-not-allowed" } as const;
    // [name, raw target (P = prefix, B = base; never path.join, which folds ".."), assert, read]
    const cases: [string, string, Short, Short][] = [
      ["inside / file exists", "P/workspace/exists.png", "ok", "ok"],
      ["inside / parent exists", "P/workspace/dir/missing.png", "ok", "missing"],
      ["inside / only an ancestor exists", "P/workspace/tmp-view/deep/p-1.png", "ok", "missing"],
      ["inside / under a missing root", "P/missing-root/a/p-1.png", "ok", "missing"],
      ["inside / .. through an existing folder", "P/workspace/dir/../exists.png", "ok", "ok"],
      ["outside / file exists", "B/outside/secret.png", "deny", "deny"],
      ["outside / parent exists", "B/outside/missing.png", "deny", "deny"],
      ["outside / nothing exists", "B/nowhere/deep/p-1.png", "deny", "deny"],
      [".. escape after missing", "P/workspace/gone/../../../outside/secret.png", "deny", "deny"],
      [".. after missing, lexically inside", "P/workspace/gone/../exists.png", "deny", "deny"],
      ["outward symlink / file exists", "P/workspace/out-link/secret.png", "deny", "deny"],
      ["outward symlink / missing below", "P/workspace/out-link/gone/p.png", "deny", "deny"],
      ["dangling outward symlink", "P/workspace/dangling/p-1.png", "deny", "deny"],
      ["outward symlink then ..", "P/workspace/out-link/../exists.png", "deny", "deny"],
      ["dangling in-root folder link", "P/workspace/dangling-in/p.png", "ok", "missing"],
    ];

    async function layout() {
      const base = await fs.realpath(tempDirs.make("ocl-local-media-matrix-"));
      const real = path.join(base, "state");
      const alias = path.join(base, "state-alias");
      await write(path.join(real, "workspace", "exists.png"));
      await fs.mkdir(path.join(real, "workspace", "dir"));
      await write(path.join(base, "outside", "secret.png"), "outside-secret");
      await fs.symlink(path.join(base, "outside"), path.join(real, "workspace", "out-link"));
      await fs.symlink(
        path.join(base, "outside", "gone"),
        path.join(real, "workspace", "dangling"),
      );
      await fs.symlink(
        path.join(real, "workspace", "gone-dir"),
        path.join(real, "workspace", "dangling-in"),
      );
      await fs.symlink(real, alias);
      return { base, real, alias };
    }

    async function verdict(operation: Promise<unknown>): Promise<Verdict> {
      try {
        await operation;
        return "ok";
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const code = (error as { code?: unknown }).code;
        if (code === "not-found" || code === "path-not-allowed") {
          return code;
        }
        throw error;
      }
    }

    for (const spelling of ["plain", "symlinked"] as const) {
      it.each(cases)(`${spelling} prefix: %s`, async (_name, raw, assertVerdict, readVerdict) => {
        const { base, real, alias } = await layout();
        const prefix = spelling === "plain" ? real : alias;
        const roots = [path.join(prefix, "workspace"), path.join(prefix, "missing-root")];
        const target = raw.replace(/^P/, prefix).replace(/^B/, base);
        expect(await verdict(assertLocalMediaAllowed(target, roots))).toBe(full[assertVerdict]);
        expect(await verdict(read(target, roots))).toBe(full[readVerdict]);
      });
    }

    it("names an in-root broken link when the read finds nothing", async () => {
      const { alias } = await layout();
      const target = `${alias}/workspace/dangling-in/p.png`;
      await expect(read(target, [path.join(alias, "workspace")])).rejects.toThrow(
        `${alias}/workspace/dangling-in is a symbolic link to a target that does not exist`,
      );
    });

    it("does not reveal whether an outside path exists", async () => {
      const { base, alias } = await layout();
      const roots = [path.join(alias, "workspace")];
      const existing = await assertLocalMediaAllowed(`${base}/outside/secret.png`, roots).catch(
        (error: unknown) => error,
      );
      const missing = await assertLocalMediaAllowed(`${base}/outside/missing.png`, roots).catch(
        (error: unknown) => error,
      );
      expect(existing).toMatchObject({ code: "path-not-allowed" });
      expect(missing).toMatchObject({ code: "path-not-allowed" });
      expect((missing as Error).message).toBe(
        (existing as Error).message.replace("secret.png", "missing.png"),
      );
    });
  },
);
