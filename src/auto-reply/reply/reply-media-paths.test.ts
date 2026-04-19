import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrl = vi.hoisted(() => vi.fn());
const resolveAgentScopedOutboundMediaAccess = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl,
}));

vi.mock("../../media/read-capability.js", () => ({
  resolveAgentScopedOutboundMediaAccess,
}));

import {
  createReplyMediaPathNormalizer,
  ReplyMediaNormalizationError,
} from "./reply-media-paths.js";

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    resolveOutboundAttachmentFromUrl.mockReset().mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl.replace(/^file:\/\//i, ""))),
    }));
    resolveAgentScopedOutboundMediaAccess
      .mockReset()
      .mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
        workspaceDir,
        localRoots: workspaceDir ? [workspaceDir] : undefined,
        readFile: async () => Buffer.from("image"),
      }));
    vi.unstubAllEnvs();
  });

  it("stages workspace-relative media through shared outbound attachment loading", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/tmp/outbound-media/photo.png",
      mediaUrls: ["/tmp/outbound-media/photo.png"],
    });
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledWith(
      path.join("/tmp/agent-workspace", "out", "photo.png"),
      5 * 1024 * 1024,
      expect.objectContaining({
        mediaAccess: expect.objectContaining({
          workspaceDir: "/tmp/agent-workspace",
        }),
      }),
    );
  });

  it("maps sandbox-relative media back to the host sandbox workspace before staging", async () => {
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
      mediaUrl: "/tmp/outbound-media/photo.png",
      mediaUrls: ["/tmp/outbound-media/photo.png", "/tmp/outbound-media/final.png"],
    });
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenNthCalledWith(
      1,
      path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      5 * 1024 * 1024,
      expect.any(Object),
    );
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenNthCalledWith(
      2,
      path.join("/tmp/sandboxes/session-1", "screens", "final.png"),
      5 * 1024 * 1024,
      expect.any(Object),
    );
  });

  it("fails fast when sandbox-mapped media staging fails", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("media too large"));
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["./out/photo.png"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["./out/photo.png"],
    } satisfies Partial<ReplyMediaNormalizationError>);
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledWith(
      path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      5 * 1024 * 1024,
      expect.any(Object),
    );
  });

  it("fails fast for host file URLs when no sandbox mapping applies", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["file:///Users/peter/Documents/report.pdf"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["file:///Users/peter/Documents/report.pdf"],
    } satisfies Partial<ReplyMediaNormalizationError>);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("fails fast for host file URLs even when sandbox exists", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["file:///Users/peter/Documents/report.pdf"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["file:///Users/peter/Documents/report.pdf"],
    } satisfies Partial<ReplyMediaNormalizationError>);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("fails fast for absolute host-local media paths when sandbox mapping fails", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["/Users/peter/Documents/report.pdf"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["/Users/peter/Documents/report.pdf"],
    } satisfies Partial<ReplyMediaNormalizationError>);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("maps absolute workspace media paths into the host sandbox workspace before staging", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const absolutePath = "/Users/peter/.openclaw/workspace/exports/images/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: { agents: { defaults: { mediaMaxMb: 8 } } },
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [absolutePath],
    });

    expect(result).toMatchObject({
      mediaUrl: "/tmp/outbound-media/chart.png",
      mediaUrls: ["/tmp/outbound-media/chart.png"],
    });
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledWith(
      "/tmp/sandboxes/session-1/exports/images/chart.png",
      8 * 1024 * 1024,
      expect.any(Object),
    );
  });

  it("stages absolute workspace media paths so the PR scenario now works", async () => {
    const absolutePath = "/Users/peter/.openclaw/workspace/exports/images/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: { agents: { defaults: { mediaMaxMb: 8 } } },
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [absolutePath],
    });

    expect(result).toMatchObject({
      mediaUrl: "/tmp/outbound-media/chart.png",
      mediaUrls: ["/tmp/outbound-media/chart.png"],
    });
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledWith(
      absolutePath,
      8 * 1024 * 1024,
      expect.any(Object),
    );
  });

  it("prefers channel account media limits when staging reply attachments", async () => {
    const absolutePath = "/Users/peter/.openclaw/workspace/exports/images/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: {
        channels: {
          whatsapp: {
            mediaMaxMb: 50,
            accounts: {
              work: {
                mediaMaxMb: 64,
              },
            },
          },
        },
        agents: { defaults: { mediaMaxMb: 8 } },
      },
      sessionKey: undefined,
      workspaceDir: "/Users/peter/.openclaw/workspace",
      messageProvider: "whatsapp",
      accountId: "work",
    });

    await normalize({
      mediaUrls: [absolutePath],
    });

    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledWith(
      absolutePath,
      64 * 1024 * 1024,
      expect.any(Object),
    );
  });

  it("fails fast when workspace-relative media paths escape the agent workspace", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["../../etc/passwd"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["../../etc/passwd"],
    } satisfies Partial<ReplyMediaNormalizationError>);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("fails fast when sandbox-relative media paths escape both sandbox and workspace", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["../../etc/passwd"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["../../etc/passwd"],
    } satisfies Partial<ReplyMediaNormalizationError>);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("keeps managed generated media under the shared media root", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
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
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it("fails fast when shared outbound attachment policy rejects host-local media", async () => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new Error("Local media path is not under an allowed directory"),
    );
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await expect(
      normalize({
        mediaUrls: ["/Users/peter/secrets/photo.png"],
      }),
    ).rejects.toMatchObject({
      name: "ReplyMediaNormalizationError",
      failedMedia: ["/Users/peter/secrets/photo.png"],
    } satisfies Partial<ReplyMediaNormalizationError>);
  });

  it("threads requester context into shared outbound media access", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: undefined,
      workspaceDir: "/tmp/agent-workspace",
      messageProvider: "whatsapp",
      accountId: "source-account",
      groupId: "ops",
      groupChannel: "whatsapp",
      groupSpace: "team",
      requesterSenderId: "sender-1",
      requesterSenderName: "Sender Name",
      requesterSenderUsername: "sender-user",
      requesterSenderE164: "+15551234567",
    });

    await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledWith({
      cfg: {},
      agentId: undefined,
      workspaceDir: "/tmp/agent-workspace",
      mediaSources: [path.join("/tmp/agent-workspace", "out", "photo.png")],
      sessionKey: undefined,
      messageProvider: "whatsapp",
      accountId: "source-account",
      requesterSenderId: "sender-1",
      requesterSenderName: "Sender Name",
      requesterSenderUsername: "sender-user",
      requesterSenderE164: "+15551234567",
      groupId: "ops",
      groupChannel: "whatsapp",
      groupSpace: "team",
    });
  });

  it("passes absolute local media sources into shared outbound media access", async () => {
    const absolutePath = "/Users/peter/Pictures/chart.png";
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    await normalize({
      mediaUrls: [absolutePath],
    });

    expect(resolveAgentScopedOutboundMediaAccess).toHaveBeenCalledWith({
      cfg: { tools: { fs: { workspaceOnly: false } } },
      agentId: expect.any(String),
      workspaceDir: "/tmp/agent-workspace",
      mediaSources: [absolutePath],
      sessionKey: "session-key",
      messageProvider: undefined,
      accountId: undefined,
      requesterSenderId: undefined,
      requesterSenderName: undefined,
      requesterSenderUsername: undefined,
      requesterSenderE164: undefined,
      groupId: undefined,
      groupChannel: undefined,
      groupSpace: undefined,
    });
  });
});
