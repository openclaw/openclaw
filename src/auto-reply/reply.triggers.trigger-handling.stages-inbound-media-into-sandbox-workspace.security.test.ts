import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext, TemplateContext } from "../templating.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => sandboxMocks);

import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(async (home) => await fn(home), { prefix: "openclaw-triggers-bypass-" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stageSandboxMedia security", () => {
  it("rejects staging host files from outside the media directory", async () => {
    await withTempHome(async (home) => {
      // Sensitive host file outside .openclaw
      const sensitiveFile = join(home, "secrets.txt");
      await fs.writeFile(sensitiveFile, "SENSITIVE DATA");

      const sandboxDir = join(home, "sandboxes", "session");
      vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
        workspaceDir: sandboxDir,
        containerWorkdir: "/work",
      });

      const ctx: MsgContext = {
        Body: "hi",
        From: "whatsapp:group:demo",
        To: "+2000",
        ChatType: "group",
        Provider: "whatsapp",
        MediaPath: sensitiveFile,
        MediaType: "image/jpeg",
        MediaUrl: sensitiveFile,
      };
      const sessionCtx: TemplateContext = { ...ctx };

      // This should fail or skip the file
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg: {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "openclaw"),
              sandbox: {
                mode: "non-main",
                workspaceRoot: join(home, "sandboxes"),
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: join(home, "sessions.json") },
        },
        sessionKey: "agent:main:main",
        workspaceDir: join(home, "openclaw"),
      });

      const stagedFullPath = join(sandboxDir, "media", "inbound", basename(sensitiveFile));
      // Expect the file NOT to be staged
      await expect(fs.stat(stagedFullPath)).rejects.toThrow();

      // Context should NOT be rewritten to a sandbox path if it failed to stage
      expect(ctx.MediaPath).toBe(sensitiveFile);
    });
  });
});
