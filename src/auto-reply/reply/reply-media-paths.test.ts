import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const readPathWithinRoot = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDir = vi.hoisted(() => vi.fn(() => "/private/tmp/openclaw-501"));
const saveMediaBuffer = vi.hoisted(() => vi.fn());
const saveMediaSource = vi.hoisted(() => vi.fn());
const fsSafeRuntime = vi.hoisted(() => ({
  actualReadPathWithinRoot: undefined as
    | ((params: {
        rootDir: string;
        filePath: string;
        rejectHardlinks?: boolean;
        maxBytes?: number;
      }) => Promise<unknown>)
    | undefined,
}));

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../infra/tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir,
  };
});

vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/fs-safe.js")>();
  fsSafeRuntime.actualReadPathWithinRoot = actual.readPathWithinRoot;
  return {
    ...actual,
    readPathWithinRoot,
  };
});

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return {
    ...actual,
    saveMediaBuffer,
    saveMediaSource,
  };
});

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    readPathWithinRoot.mockReset().mockResolvedValue({
      buffer: Buffer.from("mock-media"),
      realPath: "/tmp/mock-media",
      stat: { size: 10 } as never,
    });
    resolvePreferredOpenClawTmpDir.mockReset().mockReturnValue("/private/tmp/openclaw-501");
    saveMediaBuffer.mockReset();
    saveMediaSource.mockReset();
    vi.unstubAllEnvs();
  });

  it("resolves workspace-relative media against the agent workspace", async () => {
    saveMediaBuffer.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/photo.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/photo.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/photo.png"],
    });
  });

  it("maps sandbox-relative media back to the host sandbox workspace", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    saveMediaBuffer
      .mockResolvedValueOnce({
        path: "/Users/peter/.openclaw/media/outbound/photo.png",
      })
      .mockResolvedValueOnce({
        path: "/Users/peter/.openclaw/media/outbound/final.png",
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
      mediaUrl: "/Users/peter/.openclaw/media/outbound/photo.png",
      mediaUrls: [
        "/Users/peter/.openclaw/media/outbound/photo.png",
        "/Users/peter/.openclaw/media/outbound/final.png",
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

  it("persists volatile agent-state media from the workspace into host outbound media", async () => {
    saveMediaBuffer.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/persisted.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: { agents: { defaults: { mediaMaxMb: 8 } } },
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [
        "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      ],
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      undefined,
      "outbound",
      8 * 1024 * 1024,
      "generated.png",
    );
    expect(readPathWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/Users/peter/.openclaw/workspace",
        filePath:
          "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
        maxBytes: 8 * 1024 * 1024,
      }),
    );
    expect(saveMediaSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/persisted.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/persisted.png"],
    });
  });

  it("persists TTS voice output from the preferred OpenClaw temp directory", async () => {
    const tmpVoicePath = path.join(
      "/private/tmp/openclaw-501",
      "tts-abc123",
      "voice-1234567890.opus",
    );
    saveMediaSource.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/tts-voice.opus",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [tmpVoicePath],
    });

    expect(saveMediaSource).toHaveBeenCalledWith(tmpVoicePath, undefined, "outbound", undefined);
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/tts-voice.opus",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/tts-voice.opus"],
    });
  });

  it("falls back to the original preferred tmp path when persisting TTS media fails", async () => {
    const tmpVoicePath = path.join(
      "/private/tmp/openclaw-501",
      "tts-fallback",
      "voice-1234567890.opus",
    );
    saveMediaSource.mockRejectedValue(new Error("disk full"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: [tmpVoicePath],
    });

    expect(result).toMatchObject({
      mediaUrl: tmpVoicePath,
      mediaUrls: [tmpVoicePath],
    });
  });

  it("drops host tmp paths outside the preferred OpenClaw temp directory", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/private/tmp/not-openclaw/voice-1234567890.opus"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("persists workspace-rooted absolute paths before outbound delivery (#66635)", async () => {
    saveMediaBuffer.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/chart.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/home/user/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: ["/home/user/.openclaw/workspace/exports/images/chart.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/chart.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/chart.png"],
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      undefined,
      "outbound",
      undefined,
      "chart.png",
    );
    expect(readPathWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/home/user/.openclaw/workspace",
        filePath: "/home/user/.openclaw/workspace/exports/images/chart.png",
        maxBytes: 5 * 1024 * 1024,
      }),
    );
  });

  it("persists sandbox-rooted absolute paths before outbound delivery (#66635)", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    saveMediaBuffer.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/generated-chart.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/tmp/sandboxes/session-1/output/generated-chart.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/generated-chart.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/generated-chart.png"],
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      undefined,
      "outbound",
      undefined,
      "generated-chart.png",
    );
  });

  it("drops workspace-rooted absolute paths when safe persistence rejects them", async () => {
    saveMediaBuffer.mockRejectedValue(new Error("symlink not allowed"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/home/user/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: ["/home/user/.openclaw/workspace/exports/images/chart.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it.runIf(process.platform !== "win32")(
    "drops workspace-rooted symlink escapes instead of falling back to the raw path",
    async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-media-"));
      try {
        const stateDir = path.join(tempRoot, ".openclaw");
        const workspaceDir = path.join(stateDir, "workspace");
        const outsideDir = path.join(tempRoot, "outside");
        const escapedPath = path.join(workspaceDir, "exports", "leak", "secret.txt");
        await fs.mkdir(path.dirname(path.dirname(escapedPath)), { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, "secret.txt"), "TOP_SECRET");
        await fs.symlink(outsideDir, path.join(workspaceDir, "exports", "leak"));
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        readPathWithinRoot.mockImplementation(fsSafeRuntime.actualReadPathWithinRoot!);

        const normalize = createReplyMediaPathNormalizer({
          cfg: {},
          sessionKey: "session-key",
          workspaceDir,
        });

        const result = await normalize({
          mediaUrls: [escapedPath],
        });

        expect(result).toMatchObject({
          mediaUrl: undefined,
          mediaUrls: undefined,
        });
        expect(saveMediaBuffer).not.toHaveBeenCalled();
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "drops sandbox-rooted symlink escapes when sandbox validation rejects them",
    async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-sandbox-"));
      try {
        const workspaceDir = path.join(tempRoot, "workspace");
        const sandboxDir = path.join(tempRoot, "sandbox");
        const outsideDir = path.join(tempRoot, "outside");
        const escapedPath = path.join(sandboxDir, "output", "leak", "secret.txt");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(path.dirname(path.dirname(escapedPath)), { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, "secret.txt"), "TOP_SECRET");
        await fs.symlink(outsideDir, path.join(sandboxDir, "output", "leak"));
        ensureSandboxWorkspaceForSession.mockResolvedValue({
          workspaceDir: sandboxDir,
          containerWorkdir: "/workspace",
        });
        readPathWithinRoot.mockImplementation(fsSafeRuntime.actualReadPathWithinRoot!);

        const normalize = createReplyMediaPathNormalizer({
          cfg: {},
          sessionKey: "session-key",
          workspaceDir,
        });

        const result = await normalize({
          mediaUrls: [escapedPath],
        });

        expect(result).toMatchObject({
          mediaUrl: undefined,
          mediaUrls: undefined,
        });
        expect(saveMediaSource).not.toHaveBeenCalled();
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("still drops absolute paths outside workspace and all allowed roots", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/home/user/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: ["/etc/passwd"],
    });

    expect(result).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });
});
