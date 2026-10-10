// Tests media path normalization and attachment metadata generation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import { HostReadMediaTypeError, LocalMediaAccessError } from "../../media/local-media-access.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrl = vi.hoisted(() => vi.fn());
const resolveAgentScopedHostOutboundMediaAccess = vi.hoisted(() => vi.fn());
const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl,
}));

vi.mock("../../media/read-capability.js", () => ({
  resolveAgentScopedHostOutboundMediaAccess,
}));

import { parseReplyDirectives } from "./reply-directives.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

type NormalizedReply = {
  attachments?: Array<{ name?: string; trustedLocalMedia?: boolean }>;
  mediaUrl?: string;
  mediaUrls?: string[];
  text?: string;
  trustedLocalMedia?: boolean;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isObjectRecord(value)).toBe(true);
  if (!isObjectRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function expectMedia(result: NormalizedReply, mediaUrl: string, mediaUrls: string[]): void {
  expect(result.mediaUrl).toBe(mediaUrl);
  expect(result.mediaUrls).toEqual(mediaUrls);
}

function expectNoMedia(result: NormalizedReply): void {
  expect(result.mediaUrl).toBeUndefined();
  expect(result.mediaUrls).toBeUndefined();
}

function expectOutboundAttachmentCall(
  index: number,
  mediaUrl: string,
  mediaMaxBytes: number,
): Record<string, unknown> {
  const call = resolveOutboundAttachmentFromUrl.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing outbound attachment call ${index + 1}`);
  }
  expect(call[0]).toBe(mediaUrl);
  expect(call[1]).toBe(mediaMaxBytes);
  return requireRecord(call[2], "outbound attachment options");
}

function expectAgentScopedMediaAccessCall(): Record<string, unknown> {
  const call = resolveAgentScopedHostOutboundMediaAccess.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("missing agent scoped media access call");
  }
  return requireRecord(call[0], "agent scoped media access request");
}

type NormalizerOptions = Parameters<typeof createReplyMediaPathNormalizer>[0];
const sandboxWorkspace = {
  workspaceDir: "/tmp/sandboxes/session-1",
  containerWorkdir: "/workspace",
};

function createTestReplyMediaNormalizer(overrides: Partial<NormalizerOptions> = {}) {
  return createReplyMediaPathNormalizer({
    cfg: {},
    sessionKey: "session-key",
    workspaceDir: "/tmp/agent-workspace",
    ...overrides,
  });
}

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    resolveOutboundAttachmentFromUrl.mockReset().mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl.replace(/^file:\/\//i, ""))),
      contentType: mediaUrl.endsWith(".mp3") ? "audio/mpeg" : "image/png",
    }));
    resolveAgentScopedHostOutboundMediaAccess
      .mockReset()
      .mockImplementation(({ workspaceDir }: { workspaceDir?: string }) => ({
        workspaceDir,
        localRoots: workspaceDir ? [workspaceDir] : undefined,
        readFile: async () => Buffer.from("image"),
      }));
  });

  afterEach(() => {
    stateDirEnvSnapshot.restore();
  });

  it("stages workspace-relative media and preserves reply metadata", async () => {
    const normalize = createTestReplyMediaNormalizer();
    const mirror = {
      sessionKey: "main",
      text: "Here is the image",
      mediaUrls: ["./out/photo.png"],
      idempotencyKey: "source-reply:0",
    };
    const payload = setReplyPayloadMetadata(
      { text: mirror.text, mediaUrls: ["./out/photo.png"] },
      { sourceReplyTranscriptMirror: mirror },
    );
    const result = await normalize(payload);
    expect(result).not.toBe(payload);
    expect(getReplyPayloadMetadata(result)?.sourceReplyTranscriptMirror).toEqual({
      sessionKey: "main",
      text: "Here is the image",
      mediaUrls: ["./out/photo.png"],
      idempotencyKey: "source-reply:0",
    });
    expectMedia(result, "/tmp/outbound-media/photo.png", ["/tmp/outbound-media/photo.png"]);
    const options = expectOutboundAttachmentCall(
      0,
      path.join("/tmp/agent-workspace", "out", "photo.png"),
      5 * 1024 * 1024,
    );
    const mediaAccess = requireRecord(options.mediaAccess, "media access");
    expect(mediaAccess.workspaceDir).toBe("/tmp/agent-workspace");
    expect(result.trustedLocalMedia).toBe(true);
    expect(result.attachments).toEqual([
      { name: "photo.png", mimeType: "image/png", trustedLocalMedia: true },
    ]);
  });

  it.each([
    { name: "encoded", fileName: "café 100% image.png", prefix: "file://" },
    { name: "localhost", fileName: "café 100% image.png", prefix: "file://localhost" },
    { name: "uppercase single-slash", fileName: "café 100% image.png", prefix: "FILE:" },
  ])("stages $name file URL directives without allowing raw host file URLs", async (testCase) => {
    const workspaceDir = path.resolve("agent-workspace");
    const filePath = path.join(workspaceDir, testCase.fileName);
    const fileUrl = pathToFileURL(filePath).href.replace(/^file:\/\//u, testCase.prefix);
    const normalize = createReplyMediaPathNormalizer({ cfg: {}, workspaceDir });

    const result = await normalize(parseReplyDirectives(`Caption\nMEDIA:${fileUrl}`));

    const stagedPath = path.join("/tmp/outbound-media", testCase.fileName);
    expectMedia(result, stagedPath, [stagedPath]);
    expect(result.text).toBe("Caption");
    expectOutboundAttachmentCall(0, filePath, 5 * 1024 * 1024);

    expectNoMedia(await normalize({ mediaUrls: [fileUrl] }));
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
  });

  it("does not grant local-media trust to remote-only replies", async () => {
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({ mediaUrls: ["https://example.com/voice.mp3"] });

    expect(result.trustedLocalMedia).toBeUndefined();
  });

  it("maps a custom backend workdir to the host sandbox workspace before staging", async () => {
    const containerWorkdir = "/remote/agent";
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir,
    });
    const normalize = createTestReplyMediaNormalizer({ agentId: "finance" });
    const fileUrl = `file://${containerWorkdir}/screens/final%20image.png`;

    const result = await normalize({
      mediaUrls: [
        "./out/photo.png",
        fileUrl,
        ...(parseReplyDirectives(`MEDIA:${fileUrl}`).mediaUrls ?? []),
      ],
    });

    expect(ensureSandboxWorkspaceForSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "finance" }),
      undefined,
    );
    expectMedia(result, "/tmp/outbound-media/photo.png", [
      "/tmp/outbound-media/photo.png",
      "/tmp/outbound-media/final image.png",
    ]);
    expectOutboundAttachmentCall(
      0,
      path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      5 * 1024 * 1024,
    );
    expectOutboundAttachmentCall(
      1,
      path.join("/tmp/sandboxes/session-1", "screens", "final image.png"),
      5 * 1024 * 1024,
    );
    expect(resolveAgentScopedHostOutboundMediaAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sessionWorkspaceDir: "/tmp/sandboxes/session-1" }),
    );
  });

  it("maps explicitly supplied backend workdirs without rediscovering the sandbox", async () => {
    const normalize = createTestReplyMediaNormalizer({
      sandboxRoot: "/tmp/sandboxes/session-1",
      sandboxContainerWorkdir: "/sandbox",
    });

    const result = await normalize({
      mediaUrls: ["/sandbox/screens/final.png"],
    });

    expectMedia(result, "/tmp/outbound-media/final.png", ["/tmp/outbound-media/final.png"]);
    expectOutboundAttachmentCall(
      0,
      path.join("/tmp/sandboxes/session-1", "screens", "final.png"),
      5 * 1024 * 1024,
    );
    expect(ensureSandboxWorkspaceForSession).not.toHaveBeenCalled();
  });

  it("drops sandbox-mapped media when staging fails instead of retrying the workspace fallback", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("media too large"));
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
    expectOutboundAttachmentCall(
      0,
      path.join("/tmp/sandboxes/session-1", "out", "photo.png"),
      5 * 1024 * 1024,
    );
    expect(result.text).toBe("⚠️ photo.png: Delivery failed. Try sending this file again.");
  });

  it.each<{
    name: string;
    mediaUrl: string;
    sandbox?: typeof sandboxWorkspace & { workspaceAccess?: "none" };
    options?: Partial<NormalizerOptions>;
  }>([
    { name: "uppercase file URL", mediaUrl: "FILE:/Users/peter/Documents/report.pdf" },
    { name: "remote-host file URL", mediaUrl: "file://server/share/report.pdf" },
    {
      name: "host file URL with sandbox",
      mediaUrl: "file:///Users/peter/Documents/report.pdf",
      sandbox: sandboxWorkspace,
    },
    {
      name: "unmapped absolute host path",
      mediaUrl: "/Users/peter/Documents/report.pdf",
      sandbox: sandboxWorkspace,
      options: { cfg: { tools: { fs: { workspaceOnly: false } } } },
    },
    {
      name: "unmounted host workspace",
      mediaUrl: "/Users/peter/.openclaw/workspace/reports/screenshot.png",
      sandbox: { ...sandboxWorkspace, workspaceAccess: "none" },
      options: { workspaceDir: "/Users/peter/.openclaw/workspace" },
    },
    { name: "workspace traversal", mediaUrl: "../../etc/passwd" },
    {
      name: "sandbox traversal",
      mediaUrl: "../../etc/passwd",
      sandbox: sandboxWorkspace,
    },
  ])("rejects $name before attachment loading", async ({ mediaUrl, sandbox, options }) => {
    ensureSandboxWorkspaceForSession.mockResolvedValue(sandbox ?? null);
    const result = await createTestReplyMediaNormalizer(options)({ mediaUrls: [mediaUrl] });
    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    source: string;
    maxMb: number;
    options?: Partial<NormalizerOptions>;
    mounted?: boolean;
  }>([
    {
      name: "mounted workspace before sandbox mapping",
      source: "/Users/peter/.openclaw/workspace/reports/screenshot.png",
      maxMb: 5,
      mounted: true,
    },
    {
      name: "agent default limit",
      source: "/Users/peter/.openclaw/workspace/exports/images/chart.png",
      maxMb: 8,
      options: { cfg: { agents: { defaults: { mediaMaxMb: 8 } } } },
    },
    {
      name: "account limit over channel and agent limits",
      source: "/Users/peter/.openclaw/workspace/exports/images/chart.png",
      maxMb: 64,
      options: {
        cfg: {
          channels: { whatsapp: { mediaMaxMb: 50, accounts: { work: { mediaMaxMb: 64 } } } },
          agents: { defaults: { mediaMaxMb: 8 } },
        },
        sessionKey: undefined,
        messageProvider: "whatsapp",
        accountId: "work",
      },
    },
    {
      name: "Telegram transport default",
      source: "./exports/video.mp4",
      maxMb: 100,
      options: {
        cfg: { channels: { telegram: {} } },
        sessionKey: undefined,
        messageProvider: "telegram",
      },
    },
  ])("stages media using $name", async ({ source, maxMb, options, mounted }) => {
    if (mounted) {
      ensureSandboxWorkspaceForSession.mockResolvedValue({
        ...sandboxWorkspace,
        workspaceAccess: "rw",
      });
    }
    const workspaceDir = "/Users/peter/.openclaw/workspace";
    const result = await createTestReplyMediaNormalizer({ workspaceDir, ...options })({
      mediaUrls: [source],
    });
    const stagedPath = path.join("/tmp/outbound-media", path.basename(source));
    expectMedia(result, stagedPath, [stagedPath]);
    expectOutboundAttachmentCall(0, path.resolve(workspaceDir, source), maxMb * 1024 * 1024);
  });

  it.each<{
    source: string;
    normalized: string;
    sourceUrls?: string[];
    sandbox?: boolean;
  }>([
    {
      source: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      normalized: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
    },
    {
      source: "/Users/peter/.openclaw/media/tool-image-generation/./generated.png",
      normalized: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      sourceUrls: ["/Users/peter/.openclaw/media/tool-image-generation/./generated.png"],
    },
    {
      source: "/Users/peter/.openclaw/media/outbound/generated.png",
      normalized: "/Users/peter/.openclaw/media/outbound/generated.png",
      sandbox: true,
    },
  ])(
    "keeps managed media and source spelling: $source",
    async ({ source, normalized, sourceUrls, sandbox }) => {
      if (sandbox) {
        ensureSandboxWorkspaceForSession.mockResolvedValue(sandboxWorkspace);
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
      const normalize = createTestReplyMediaNormalizer();
      const result = await normalize({ mediaUrls: [source] });
      expectMedia(result, normalized, [normalized]);
      expect(
        collectReplyMediaEntries(result, result.mediaUrls).map((entry) => entry.sourceUrls),
      ).toEqual([sourceUrls]);
      expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
    },
  );

  it("drops managed outbound media symlinks escaping the shared media root without sandbox mapping", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-media-state-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-media-outside-"));
    const outsideFile = path.join(outsideDir, "secret.png");
    const symlinkPath = path.join(stateDir, "media", "outbound", "linked-secret.png");
    try {
      await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
      await fs.writeFile(outsideFile, "secret", "utf8");
      await fs.symlink(outsideFile, symlinkPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const normalize = createTestReplyMediaNormalizer();

      const result = await normalize({
        mediaUrls: [symlinkPath],
      });

      expectNoMedia(result);
      expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(symlinkPath, { force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each<{
    name: string;
    error: Error;
    mediaUrl: string;
    text?: string;
    expectedText?: string;
    verifyMetadata?: (result: ReplyPayload) => void;
  }>([
    {
      name: "outbound policy rejection",
      error: new Error("Local media path is not under an allowed directory"),
      mediaUrl: "/Users/peter/secrets/photo.png",
    },
    {
      name: "missing file with caption",
      error: new LocalMediaAccessError("not-found", "missing test fixture"),
      mediaUrl: "./out/missing.png",
      text: "WA_MEDIA_DM_07",
      expectedText: "WA_MEDIA_DM_07\n⚠️ missing.png: File not found. Check the path and try again.",
    },
    {
      name: "missing file without caption",
      error: new LocalMediaAccessError("not-found", "missing test fixture"),
      mediaUrl: "./out/missing.png",
      expectedText: "⚠️ missing.png: File not found. Check the path and try again.",
      verifyMetadata: (result) => {
        expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toEqual([
          { code: "file-not-found", kind: "image", label: "missing.png", mimeType: "image/png" },
        ]);
      },
    },
    {
      name: "host-read media type rejection",
      error: new HostReadMediaTypeError("unsupported test fixture"),
      mediaUrl: "./out/settings.toml",
      expectedText:
        "⚠️ settings.toml: Rejected by the local attachment allowlist. Send a supported file type.",
      verifyMetadata: (result) => {
        expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toMatchObject([
          { code: "unsupported-format", label: "settings.toml" },
        ]);
      },
    },
  ])("drops media for $name", async ({ error, mediaUrl, text, expectedText, verifyMetadata }) => {
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(error);
    const result = await createTestReplyMediaNormalizer()({ text, mediaUrls: [mediaUrl] });
    expectNoMedia(result);
    if (expectedText !== undefined) {
      expect(result.text).toBe(expectedText);
    }
    verifyMetadata?.(result);
  });

  it("keeps surviving media and appends a named receipt for each dropped item", async () => {
    const localSource = "./out/clip.mp4";
    const stagedSource = "/tmp/outbound-media/clip.mp4";
    const remoteSource = "https://example.com/ok.png";
    resolveOutboundAttachmentFromUrl
      .mockRejectedValueOnce(new LocalMediaAccessError("not-found", "missing test fixture"))
      .mockResolvedValueOnce({ path: stagedSource, contentType: "video/mp4" });
    const normalize = createTestReplyMediaNormalizer();
    const payload: ReplyPayload = {
      text: "Here is the surviving attachment",
      mediaUrls: ["./out/missing.png", remoteSource, localSource],
      attachments: [
        {
          type: "video",
          path: localSource,
          url: localSource,
          mediaUrl: localSource,
          filePath: localSource,
          name: "Local clip.mp4",
          mimeType: "video/mp4",
          durationMs: 1_500,
          width: 640,
          height: 360,
        },
        { url: remoteSource, name: "Remote chart.png", mimeType: "image/png" },
      ],
    };
    const original = structuredClone(payload);

    const result = await normalize(payload);

    expect(result.text).toBe(
      "Here is the surviving attachment\n⚠️ missing.png: File not found. Check the path and try again.",
    );
    expectMedia(result, remoteSource, [remoteSource, stagedSource]);
    expect(result.attachments).toEqual([
      { url: remoteSource, name: "Remote chart.png", mimeType: "image/png" },
      {
        type: "video",
        path: stagedSource,
        url: stagedSource,
        mediaUrl: stagedSource,
        filePath: stagedSource,
        name: "Local clip.mp4",
        mimeType: "video/mp4",
        durationMs: 1_500,
        width: 640,
        height: 360,
        trustedLocalMedia: true,
      },
    ]);
    expect(payload).toEqual(original);
  });

  it("does not reuse dropped positional metadata for surviving media", async () => {
    const remoteSource = "https://example.com/surviving.png";
    resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
      new LocalMediaAccessError("not-found", "missing test fixture"),
    );
    const normalize = createTestReplyMediaNormalizer();

    const result = await normalize({
      mediaUrls: ["./out/missing.pdf", remoteSource],
      attachments: [{ name: "first-only", mimeType: "application/pdf" }],
    });

    expectMedia(result, remoteSource, [remoteSource]);
    const [entry] = collectReplyMediaEntries(result, [remoteSource]);
    expect(entry?.url).toBe(remoteSource);
    expect(entry?.attachment?.name).toBeUndefined();
    expect(entry?.attachment?.mimeType).toBeUndefined();
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

    expect(resolveAgentScopedHostOutboundMediaAccess).toHaveBeenCalledTimes(1);
    expect(expectAgentScopedMediaAccessCall()).toEqual({
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

  it.each(["/Users/peter/Pictures/chart.png", "~/Pictures/chart.png"])(
    "passes local source %s into shared outbound media access",
    async (mediaSource) => {
      const normalize = createReplyMediaPathNormalizer({
        cfg: { tools: { fs: { workspaceOnly: false } } },
        sessionKey: "session-key",
        workspaceDir: "/tmp/agent-workspace",
      });

      const result = await normalize({
        mediaUrls: [mediaSource],
      });

      expectMedia(result, "/tmp/outbound-media/chart.png", ["/tmp/outbound-media/chart.png"]);
      expect(resolveAgentScopedHostOutboundMediaAccess).toHaveBeenCalledTimes(1);
      const accessRequest = expectAgentScopedMediaAccessCall();
      expect(typeof accessRequest.agentId).toBe("string");
      expect({ ...accessRequest, agentId: undefined }).toEqual({
        cfg: { tools: { fs: { workspaceOnly: false } } },
        agentId: undefined,
        workspaceDir: "/tmp/agent-workspace",
        mediaSources: [mediaSource],
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
    },
  );
});
