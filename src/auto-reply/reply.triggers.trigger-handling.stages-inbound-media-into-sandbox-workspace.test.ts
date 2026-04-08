import fs from "node:fs/promises";
import path, { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_MAX_BYTES } from "../media/store.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const sandboxModuleId = new URL("../agents/sandbox.js", import.meta.url).pathname;
const fsSafeModuleId = new URL("../infra/fs-safe.js", import.meta.url).pathname;

let stageSandboxMedia: typeof import("./reply/stage-sandbox-media.js").stageSandboxMedia;

async function loadFreshStageSandboxMediaModuleForTest() {
  vi.resetModules();
  vi.doMock(sandboxModuleId, () => sandboxMocks);
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      spawn: childProcessMocks.spawn,
    };
  });
  vi.doMock(fsSafeModuleId, async () => {
    const actual = await vi.importActual<typeof import("../infra/fs-safe.js")>(fsSafeModuleId);
    return {
      ...actual,
      copyFileWithinRoot: vi.fn(async ({ sourcePath, rootDir, relativePath, maxBytes }) => {
        const sourceStat = await fs.stat(sourcePath);
        if (typeof maxBytes === "number" && sourceStat.size > maxBytes) {
          throw new actual.SafeOpenError(
            "too-large",
            `file exceeds limit of ${maxBytes} bytes (got ${sourceStat.size})`,
          );
        }

        await fs.mkdir(rootDir, { recursive: true });
        const rootReal = await fs.realpath(rootDir);
        const destPath = path.resolve(rootReal, relativePath);
        const rootPrefix = `${rootReal}${path.sep}`;
        if (destPath !== rootReal && !destPath.startsWith(rootPrefix)) {
          throw new actual.SafeOpenError("outside-workspace", "file is outside workspace root");
        }

        const parentDir = dirname(destPath);
        const relativeParent = path.relative(rootReal, parentDir);
        if (relativeParent && !relativeParent.startsWith("..")) {
          let cursor = rootReal;
          for (const segment of relativeParent.split(path.sep)) {
            cursor = path.join(cursor, segment);
            try {
              const stat = await fs.lstat(cursor);
              if (stat.isSymbolicLink()) {
                throw new actual.SafeOpenError("symlink", "symlink not allowed");
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                await fs.mkdir(cursor, { recursive: true });
                continue;
              }
              throw error;
            }
          }
        }

        try {
          const destStat = await fs.lstat(destPath);
          if (destStat.isSymbolicLink()) {
            throw new actual.SafeOpenError("symlink", "symlink not allowed");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }

        await fs.copyFile(sourcePath, destPath);
      }),
    };
  });
  const replyModule = await import("./reply/stage-sandbox-media.js");
  return {
    stageSandboxMedia: replyModule.stageSandboxMedia,
  };
}

async function loadStageSandboxMediaInTempHome() {
  sandboxMocks.ensureSandboxWorkspaceForSession.mockReset();
  childProcessMocks.spawn.mockClear();
  ({ stageSandboxMedia } = await loadFreshStageSandboxMediaModuleForTest());
}

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
});

async function setupSandboxWorkspace(home: string): Promise<{
  cfg: ReturnType<typeof createSandboxMediaStageConfig>;
  workspaceDir: string;
  sandboxDir: string;
}> {
  const cfg = createSandboxMediaStageConfig(home);
  const workspaceDir = join(home, "openclaw");
  const sandboxDir = join(home, "sandboxes", "session");
  await fs.mkdir(sandboxDir, { recursive: true });
  sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue({
    workspaceDir: sandboxDir,
    containerWorkdir: "/work",
  });
  return { cfg, workspaceDir, sandboxDir };
}

async function writeInboundMedia(
  home: string,
  fileName: string,
  payload: string | Buffer,
): Promise<string> {
  const inboundDir = join(home, ".openclaw", "media", "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  const mediaPath = join(inboundDir, fileName);
  await fs.writeFile(mediaPath, payload);
  return mediaPath;
}

describe("stageSandboxMedia", () => {
  it("stages allowed media and blocks unsafe paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      await loadStageSandboxMediaInTempHome();
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      {
        const mediaPath = await writeInboundMedia(home, "photo.jpg", "test");
        const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        expect(ctx.MediaPath).toMatch(/^media\/inbound\/photo-[a-f0-9]{8}\.jpg$/);
        expect(sessionCtx.MediaPath).toBe(ctx.MediaPath);
        expect(ctx.MediaUrl).toBe(ctx.MediaPath);
        expect(sessionCtx.MediaUrl).toBe(ctx.MediaPath);
        const stagedFileName = path.basename(ctx.MediaPath ?? "");
        await expect(
          fs.stat(join(sandboxDir, "media", "inbound", stagedFileName)),
        ).resolves.toBeTruthy();
      }

      {
        const sensitiveFile = join(home, "secrets.txt");
        await fs.writeFile(sensitiveFile, "SENSITIVE DATA");
        const { ctx, sessionCtx } = createSandboxMediaContexts(sensitiveFile);

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        await expect(
          fs.stat(join(sandboxDir, "media", "inbound", basename(sensitiveFile))),
        ).rejects.toThrow();
        expect(ctx.MediaPath).toBe(sensitiveFile);
      }

      {
        childProcessMocks.spawn.mockClear();
        const { ctx, sessionCtx } = createSandboxMediaContexts("/etc/passwd");
        ctx.Provider = "imessage";
        ctx.MediaRemoteHost = "user@gateway-host";
        sessionCtx.Provider = "imessage";
        sessionCtx.MediaRemoteHost = "user@gateway-host";

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        expect(childProcessMocks.spawn).not.toHaveBeenCalled();
        expect(ctx.MediaPath).toBe("/etc/passwd");
      }
    });
  });

  it("uses unique staged filenames across turns for repeated inbound basenames", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      await loadStageSandboxMediaInTempHome();
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(home, "image.png", "FIRST");
      const first = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx: first.ctx,
        sessionCtx: first.sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      await fs.writeFile(mediaPath, "SECOND");
      const second = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx: second.ctx,
        sessionCtx: second.sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      expect(first.ctx.MediaPath).toMatch(/^media\/inbound\/image-[a-f0-9]{8}\.png$/);
      expect(second.ctx.MediaPath).toMatch(/^media\/inbound\/image-[a-f0-9]{8}\.png$/);
      expect(second.ctx.MediaPath).not.toBe(first.ctx.MediaPath);

      const firstStaged = join(sandboxDir, first.ctx.MediaPath ?? "");
      const secondStaged = join(sandboxDir, second.ctx.MediaPath ?? "");
      await expect(fs.readFile(firstStaged, "utf8")).resolves.toBe("FIRST");
      await expect(fs.readFile(secondStaged, "utf8")).resolves.toBe("SECOND");
    });
  });

  it("truncates long staged filenames to filesystem-safe length", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      await loadStageSandboxMediaInTempHome();
      const { cfg, workspaceDir } = await setupSandboxWorkspace(home);

      const longName = `${"a".repeat(240)}.png`;
      const mediaPath = await writeInboundMedia(home, longName, "LONG");
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      const stagedName = path.basename(ctx.MediaPath ?? "");
      expect(Buffer.byteLength(stagedName, "utf8")).toBeLessThanOrEqual(255);
      expect(stagedName).toMatch(/\.png$/);
      expect(stagedName).toMatch(/-[a-f0-9]{8}\.png$/);
    });
  });

  it("blocks destination symlink escapes when staging into sandbox workspace", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      await loadStageSandboxMediaInTempHome();
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(home, "payload.txt", "PAYLOAD");

      const outsideDir = join(home, "outside");
      const outsideInboundDir = join(outsideDir, "inbound");
      await fs.mkdir(outsideInboundDir, { recursive: true });
      const victimPath = join(outsideDir, "victim.txt");
      await fs.writeFile(victimPath, "ORIGINAL");

      await fs.mkdir(sandboxDir, { recursive: true });
      await fs.symlink(outsideDir, join(sandboxDir, "media"));
      await fs.symlink(victimPath, join(outsideInboundDir, basename(mediaPath)));

      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      await expect(fs.readFile(victimPath, "utf8")).resolves.toBe("ORIGINAL");
      expect(ctx.MediaPath).toBe(mediaPath);
      expect(sessionCtx.MediaPath).toBe(mediaPath);
    });
  });

  it("skips oversized media staging and keeps original media paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      await loadStageSandboxMediaInTempHome();
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(
        home,
        "oversized.bin",
        Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x41),
      );

      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      await expect(
        fs.stat(join(sandboxDir, "media", "inbound", basename(mediaPath))),
      ).rejects.toThrow();
      expect(ctx.MediaPath).toBe(mediaPath);
      expect(sessionCtx.MediaPath).toBe(mediaPath);
    });
  });
});
