import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const saveMediaSource = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/store.js", () => ({
  saveMediaSource,
}));

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    saveMediaSource.mockReset();
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

  it("keeps host-local media paths flexible when sandbox exists and workspaceOnly is off", async () => {
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
      mediaUrl: "/Users/peter/.openclaw/media/inbound/photo.png",
      mediaUrls: ["/Users/peter/.openclaw/media/inbound/photo.png"],
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("keeps sandbox media strict when workspaceOnly is enabled", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: true } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["/Users/peter/.openclaw/media/inbound/photo.png"],
      }),
    ).rejects.toThrow(/sandbox root|outside|escapes/i);
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
