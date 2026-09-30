import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

const sandboxMocks = vi.hoisted(() => ({ ensureSandboxWorkspaceForSession: vi.fn() }));
vi.mock("../../agents/sandbox.js", () => sandboxMocks);
beforeEach(() => sandboxMocks.ensureSandboxWorkspaceForSession.mockReset());

it.each([
  { sandbox: false, reference: "path-only" },
  { sandbox: false, reference: "physical-alias" },
  { sandbox: false, reference: "managed-alias" },
  { sandbox: false, reference: "file-alias" },
  { sandbox: true, reference: "path-only" },
  { sandbox: true, reference: "physical-alias" },
  { sandbox: true, reference: "managed-alias" },
  { sandbox: true, reference: "file-alias" },
])(
  "keeps $reference image fetchable in history (sandbox=$sandbox)",
  async ({ sandbox, reference }) => {
    await withSandboxMediaTempHome("openclaw-staged-history-", async (home) => {
      const source = path.join(home, ".openclaw", "media", "inbound", "synthetic-test.png");
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "synthetic image bytes");
      const uri = "media://inbound/synthetic-test.png";
      const workspaceDir = path.join(home, "workspace");
      const sandboxDir = path.join(home, "sandbox");
      sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(
        sandbox ? { workspaceDir: sandboxDir, containerWorkdir: "/work" } : null,
      );
      const { ctx, sessionCtx } = createSandboxMediaContexts(source);
      ctx.media = [
        {
          path: reference === "managed-alias" ? uri : source,
          ...(reference === "physical-alias" ? { url: source } : {}),
          ...(reference === "managed-alias" ? { url: uri } : {}),
          ...(reference === "file-alias" ? { url: pathToFileURL(source).href } : {}),
          contentType: "image/png",
          kind: "image",
        },
      ];
      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg: createSandboxMediaStageConfig(home),
        sessionKey: "agent:main:main",
        workspaceDir,
      });
      const stagedPath = result.staged.get(0)!;
      expect(stagedPath).toBeTruthy();
      expect(stagedPath).not.toBe(source);
      expect(
        await fs.readFile(path.resolve(sandbox ? sandboxDir : workspaceDir, stagedPath), "utf8"),
      ).toBe("synthetic image bytes");
      expect(sessionCtx.media).toEqual(ctx.media);

      const persisted = buildPersistedUserTurnMessage({
        text: "Synthetic attachment",
        media: ctx.media,
      });
      const [history] = sanitizeChatHistoryMessages([persisted]);
      expect(history).toMatchObject({
        __openclaw: { media: [{ url: uri, contentType: "image/png", kind: "image" }] },
      });
      expect(JSON.stringify(history)).not.toContain(home);
      expect(JSON.stringify(history)).not.toContain("openclaw-staged-");
    });
  },
);
