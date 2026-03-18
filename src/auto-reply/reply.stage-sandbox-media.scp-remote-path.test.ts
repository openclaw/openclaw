import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
});

function createRemoteStageParams(home: string): {
  cfg: ReturnType<typeof createSandboxMediaStageConfig>;
  workspaceDir: string;
  sessionKey: string;
  remoteCacheDir: string;
} {
  const sessionKey = "agent:main:main";
  vi.mocked(sandboxMocks.ensureSandboxWorkspaceForSession).mockResolvedValue(null);
  return {
    cfg: createSandboxMediaStageConfig(home),
    workspaceDir: join(home, "openclaw"),
    sessionKey,
    remoteCacheDir: join(home, ".openclaw", "media", "remote-cache", sessionKey),
  };
}

function createRemoteContexts(remotePath: string) {
  const { ctx, sessionCtx } = createSandboxMediaContexts(remotePath);
  ctx.Provider = "imessage";
  ctx.MediaRemoteHost = "user@gateway-host";
  sessionCtx.Provider = "imessage";
  sessionCtx.MediaRemoteHost = "user@gateway-host";
  return { ctx, sessionCtx };
}

describe("stageSandboxMedia scp remote paths", () => {
  it("rejects remote attachment filenames with shell metacharacters before spawning scp", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sessionKey, remoteCacheDir } = createRemoteStageParams(home);
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/evil$(touch pwned).jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      });

      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
      await expect(fs.stat(join(remoteCacheDir, basename(remotePath)))).rejects.toThrow();
      expect(ctx.MediaPath).toBe(remotePath);
      expect(sessionCtx.MediaPath).toBe(remotePath);
      expect(ctx.MediaUrl).toBe(remotePath);
      expect(sessionCtx.MediaUrl).toBe(remotePath);
    });
  });
});
