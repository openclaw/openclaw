import fs from "node:fs/promises";
import { basename, join } from "node:path";
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

vi.mock("../agents/sandbox.js", () => sandboxMocks);
vi.mock("node:child_process", () => childProcessMocks);

import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
});

function setupSandboxWorkspace(home: string): {
  cfg: ReturnType<typeof createSandboxMediaStageConfig>;
  workspaceDir: string;
  sandboxDir: string;
} {
  const cfg = createSandboxMediaStageConfig(home);
  const workspaceDir = join(home, "openclaw");
  const sandboxDir = join(home, "sandboxes", "session");
  vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
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
      const { cfg, workspaceDir, sandboxDir } = setupSandboxWorkspace(home);

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

        const stagedPath = `media/inbound/${basename(mediaPath)}`;
        expect(ctx.MediaPath).toBe(stagedPath);
        expect(sessionCtx.MediaPath).toBe(stagedPath);
        expect(ctx.MediaUrl).toBe(stagedPath);
        expect(sessionCtx.MediaUrl).toBe(stagedPath);
        await expect(
          fs.stat(join(sandboxDir, "media", "inbound", basename(mediaPath))),
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

  it("blocks destination symlink escapes when staging into sandbox workspace", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = setupSandboxWorkspace(home);

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
      const { cfg, workspaceDir, sandboxDir } = setupSandboxWorkspace(home);

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
