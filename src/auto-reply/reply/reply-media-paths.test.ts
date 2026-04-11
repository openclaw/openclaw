import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const saveMediaSource = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/store.js", () => ({
  saveMediaSource,
}));

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

function asOpenClawConfig(config: OpenClawConfig): OpenClawConfig {
  return config;
}

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    saveMediaSource.mockReset();
    vi.unstubAllEnvs();
  });

  it("resolves workspace-relative media against the agent workspace", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/agent-workspace", "out", "photo.png"),
      mediaUrls: [path.join("/tmp/agent-workspace", "out", "photo.png")],
    });
  });

  it("maps sandbox-relative media back to the host sandbox workspace", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png", "file:///workspace/screens/final.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      mediaUrls: [
        path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
        path.join("/tmp/sandboxes/session-1", "screens", "final.png"),
      ],
    });
  });

  it("drops arbitrary host-local media paths when sandbox exists", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/inbound/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("drops relative sandbox escapes when tools.fs.workspaceOnly is enabled", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: asOpenClawConfig({ tools: { fs: { workspaceOnly: true } } }),
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["../sandboxes/session-1/screens/final.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("keeps managed generated media under the shared media root", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("drops absolute file URLs outside managed reply media roots", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["file:///Users/peter/.openclaw/media/inbound/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("keeps tool-generated media under the OpenClaw tmp root when sandbox mode is off", async () => {
    const tmpAudioPath = path.join(resolvePreferredOpenClawTmpDir(), "tts-abc123", "reply.opus");
    const normalize = createReplyMediaPathNormalizer({
      cfg: asOpenClawConfig({}),
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [tmpAudioPath],
      audioAsVoice: true,
    });

    expect(result).toMatchObject({
      mediaUrl: tmpAudioPath,
      mediaUrls: [tmpAudioPath],
      audioAsVoice: true,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("still drops absolute host-local media outside the OpenClaw tmp root when sandbox mode is off", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: asOpenClawConfig({}),
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/tmp/not-openclaw/reply.opus"],
      audioAsVoice: true,
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: true,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("still drops non-media files under the OpenClaw tmp root", async () => {
    const tmpPromptPath = path.join(
      resolvePreferredOpenClawTmpDir(),
      "openclaw-cli-system-prompt-abc123",
      "system-prompt.md",
    );
    const normalize = createReplyMediaPathNormalizer({
      cfg: asOpenClawConfig({}),
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [tmpPromptPath],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("persists volatile agent-state media from the workspace into host outbound media", async () => {
    saveMediaSource.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/persisted.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [
        "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      ],
    });

    expect(saveMediaSource).toHaveBeenCalledWith(
      "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      undefined,
      "outbound",
    );
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/persisted.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/persisted.png"],
    });
  });
});
