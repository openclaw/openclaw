// Local media access tests cover workspace path authorization.
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
        `Local media path is not under an allowed directory: ${filePath}`,
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
