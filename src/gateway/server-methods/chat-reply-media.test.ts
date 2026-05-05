import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { createManagedOutgoingImageBlocks } from "../managed-image-attachments.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("normalizeWebchatReplyMediaPathsForDisplay", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webchat-reply-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(rootDir, "state"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  function createConfig(params: {
    agentDir: string;
    workspaceDir: string;
    allowRead: boolean;
  }): OpenClawConfig {
    return {
      tools: params.allowRead ? { allow: ["read"] } : { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            agentDir: params.agentDir,
            workspace: params.workspaceDir,
          },
        ],
      },
    };
  }

  async function createCodexHomeImage(params: { agentDir: string }): Promise<string> {
    const imagePath = path.join(params.agentDir, "codex-home", "outputs", "chart.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, PNG_BYTES);
    return imagePath;
  }

  it("stages Codex-home image paths before Gateway managed-image display", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(stateDir, "workspace");
    const sourcePath = await createCodexHomeImage({ agentDir });
    const cfg = createConfig({ agentDir, workspaceDir, allowRead: true });

    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      sessionKey: "agent:main:webchat:direct:user",
      agentId: "main",
      payloads: [{ mediaUrls: [sourcePath] }],
    });

    const normalizedPath = payload?.mediaUrls?.[0];
    expect(normalizedPath).toBeTruthy();
    expect(normalizedPath).not.toBe(sourcePath);
    expect(normalizedPath?.startsWith(path.join(stateDir, "media"))).toBe(true);
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:webchat:direct:user",
      mediaUrls: payload?.mediaUrls ?? [],
      localRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
    });

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type?: string }).type).toBe("image");
  });

  it("does not expose Codex-home media when host read policy is not enabled", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(stateDir, "workspace");
    const sourcePath = await createCodexHomeImage({ agentDir });
    const cfg = createConfig({ agentDir, workspaceDir, allowRead: false });

    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      sessionKey: "agent:main:webchat:direct:user",
      agentId: "main",
      payloads: [{ mediaUrls: [sourcePath] }],
    });

    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toBeUndefined();
    expect(payload?.text).toBeTruthy();
  });
});
