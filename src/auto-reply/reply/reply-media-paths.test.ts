import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const saveMediaSource = vi.hoisted(() => vi.fn());
const ensureMediaHosted = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/store.js", () => ({
  saveMediaSource,
}));

vi.mock("../../media/host.js", () => ({
  ensureMediaHosted,
}));

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    saveMediaSource.mockReset();
    ensureMediaHosted.mockReset();
    // Default: ensureMediaHosted converts local paths to gateway URLs
    ensureMediaHosted.mockImplementation(async (source: string) => ({
      url: `https://tailnet-host.example/media/${path.basename(source)}`,
      id: path.basename(source),
      size: 1024,
    }));
    vi.unstubAllEnvs();
  });

  it("resolves workspace-relative media against the agent workspace and converts to gateway URL", async () => {
    const resolvedPath = path.join("/tmp/agent-workspace", "out", "photo.png");
    ensureMediaHosted.mockResolvedValue({
      url: `https://tailnet-host.example/media/photo.png`,
      id: "photo.png",
      size: 1024,
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(ensureMediaHosted).toHaveBeenCalledWith(resolvedPath, { startServer: false });
    expect(result).toMatchObject({
      mediaUrl: "https://tailnet-host.example/media/photo.png",
      mediaUrls: ["https://tailnet-host.example/media/photo.png"],
    });
  });

  it("maps sandbox-relative media back to the host sandbox workspace and converts to gateway URLs", async () => {
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

    expect(ensureMediaHosted).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      mediaUrl: expect.stringContaining("https://"),
      mediaUrls: [
        expect.stringContaining("https://"),
        expect.stringContaining("https://"),
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
      cfg: { tools: { fs: { workspaceOnly: true } } },
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

  it("converts managed generated media under the shared media root to gateway URL", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    ensureMediaHosted.mockResolvedValue({
      url: "https://tailnet-host.example/media/generated.png",
      id: "generated.png",
      size: 2048,
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });

    expect(saveMediaSource).not.toHaveBeenCalled();
    expect(ensureMediaHosted).toHaveBeenCalledWith(
      "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      { startServer: false },
    );
    expect(result).toMatchObject({
      mediaUrl: "https://tailnet-host.example/media/generated.png",
      mediaUrls: ["https://tailnet-host.example/media/generated.png"],
    });
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

  it("persists volatile agent-state media from the workspace and converts to gateway URL", async () => {
    saveMediaSource.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/persisted.png",
    });
    ensureMediaHosted.mockResolvedValue({
      url: "https://tailnet-host.example/media/persisted.png",
      id: "persisted.png",
      size: 4096,
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
    expect(ensureMediaHosted).toHaveBeenCalledWith(
      "/Users/peter/.openclaw/media/outbound/persisted.png",
      { startServer: false },
    );
    expect(result).toMatchObject({
      mediaUrl: "https://tailnet-host.example/media/persisted.png",
      mediaUrls: ["https://tailnet-host.example/media/persisted.png"],
    });
  });

  it("preserves HTTP URLs without calling ensureMediaHosted", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["https://cdn.example.com/image.png"],
    });

    expect(ensureMediaHosted).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mediaUrl: "https://cdn.example.com/image.png",
      mediaUrls: ["https://cdn.example.com/image.png"],
    });
  });

  it("falls back to local path when ensureMediaHosted fails (graceful degradation)", async () => {
    ensureMediaHosted.mockRejectedValue(new Error("Media hosting requires the webhook server"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/audio.ogg"],
    });

    const expectedPath = path.join("/tmp/agent-workspace", "out", "audio.ogg");
    expect(ensureMediaHosted).toHaveBeenCalledWith(expectedPath, { startServer: false });
    expect(result).toMatchObject({
      mediaUrl: expectedPath,
      mediaUrls: [expectedPath],
    });
  });

  it("converts multiple mixed local/remote media correctly", async () => {
    ensureMediaHosted.mockImplementation(async (source: string) => ({
      url: `https://tailnet-host.example/media/${path.basename(source)}`,
      id: path.basename(source),
      size: 1024,
    }));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [
        "https://cdn.example.com/remote.png",
        "./local-photo.jpg",
      ],
    });

    // Only the local path should trigger ensureMediaHosted
    expect(ensureMediaHosted).toHaveBeenCalledTimes(1);
    expect(ensureMediaHosted).toHaveBeenCalledWith(
      path.join("/tmp/agent-workspace", "local-photo.jpg"),
      { startServer: false },
    );
    expect(result).toMatchObject({
      mediaUrl: "https://cdn.example.com/remote.png",
      mediaUrls: [
        "https://cdn.example.com/remote.png",
        "https://tailnet-host.example/media/local-photo.jpg",
      ],
    });
  });
});
