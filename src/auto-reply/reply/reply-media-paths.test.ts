import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as globals from "../../globals.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import { HostReadMediaTypeError, LocalMediaAccessError } from "../../media/local-media-access.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyMediaAttachment,
  type ReplyPayload,
} from "../reply-payload.js";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrl = vi.hoisted(() => vi.fn());
const resolveAgentScopedHostOutboundMediaAccess = vi.hoisted(() => vi.fn());
const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

vi.mock("../../agents/sandbox/context.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/sandbox/context.js")>(
    "../../agents/sandbox/context.js",
  )),
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function expectMedia(result: ReplyPayload, mediaUrl: string, mediaUrls = [mediaUrl]): void {
  expect([result.mediaUrl, result.mediaUrls]).toEqual([mediaUrl, mediaUrls]);
}

function expectNoMedia(result: ReplyPayload): void {
  expect([result.mediaUrl, result.mediaUrls]).toEqual([undefined, undefined]);
}

function expectOutboundAttachmentCall(
  index: number,
  mediaUrl: string,
  mediaMaxBytes = 5 * 1024 * 1024,
): Record<string, unknown> {
  const call = resolveOutboundAttachmentFromUrl.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing outbound attachment call ${index + 1}`);
  }
  expect(call[0]).toBe(mediaUrl);
  expect(call[1]).toBe(mediaMaxBytes);
  return requireRecord(call[2], "outbound attachment options");
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

const normalizeMedia = (mediaUrls: string[], options?: Partial<NormalizerOptions>) =>
  createTestReplyMediaNormalizer(options)({ mediaUrls });

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
  vi.restoreAllMocks();
});

it("stages workspace-relative media and preserves reply metadata", async () => {
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
  const expectedMirror = structuredClone(mirror);
  const result = await createTestReplyMediaNormalizer()(payload);
  expect(result).not.toBe(payload);
  expect(getReplyPayloadMetadata(result)?.sourceReplyTranscriptMirror).toEqual(expectedMirror);
  expectMedia(result, "/tmp/outbound-media/photo.png");
  const options = expectOutboundAttachmentCall(
    0,
    path.join("/tmp/agent-workspace", "out", "photo.png"),
  );
  const mediaAccess = requireRecord(options.mediaAccess, "media access");
  expect(mediaAccess.workspaceDir).toBe("/tmp/agent-workspace");
  expect(result.trustedLocalMedia).toBe(true);
  expect(result.attachments).toEqual([
    { name: "photo.png", mimeType: "image/png", trustedLocalMedia: true },
  ]);
});

it("stages encoded file URL directives without allowing raw host file URLs", async () => {
  const workspaceDir = path.resolve("agent-workspace");
  const fileName = "café 100% image.png";
  const filePath = path.join(workspaceDir, fileName);
  const fileUrl = pathToFileURL(filePath).href;
  const normalize = createReplyMediaPathNormalizer({ cfg: {}, workspaceDir });

  const result = await normalize(parseReplyDirectives(`Caption\nMEDIA:${fileUrl}`));

  const stagedPath = path.join("/tmp/outbound-media", fileName);
  expectMedia(result, stagedPath, [stagedPath]);
  expect(result.text).toBe("Caption");
  expectOutboundAttachmentCall(0, filePath);

  expectNoMedia(await normalize({ mediaUrls: [fileUrl] }));
  expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
});

it("does not grant local-media trust to remote-only replies", async () => {
  const result = await normalizeMedia(["https://example.com/voice.mp3"]);
  expect(result.trustedLocalMedia).toBeUndefined();
});

it("maps a custom backend workdir to the host sandbox workspace before staging", async () => {
  const containerWorkdir = "/remote/agent";
  ensureSandboxWorkspaceForSession.mockResolvedValue({ ...sandboxWorkspace, containerWorkdir });
  const fileUrl = `file://${containerWorkdir}/screens/final%20image.png`;
  const result = await normalizeMedia(
    ["./out/photo.png", fileUrl, ...(parseReplyDirectives(`MEDIA:${fileUrl}`).mediaUrls ?? [])],
    { agentId: "finance" },
  );

  expect(ensureSandboxWorkspaceForSession).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "finance" }),
    undefined,
  );
  expectMedia(result, "/tmp/outbound-media/photo.png", [
    "/tmp/outbound-media/photo.png",
    "/tmp/outbound-media/final image.png",
  ]);
  expectOutboundAttachmentCall(0, path.join("/tmp/sandboxes/session-1", "out", "photo.png"));
  expectOutboundAttachmentCall(
    1,
    path.join("/tmp/sandboxes/session-1", "screens", "final image.png"),
  );
  expect(resolveAgentScopedHostOutboundMediaAccess).toHaveBeenCalledWith(
    expect.objectContaining({ sessionWorkspaceDir: "/tmp/sandboxes/session-1" }),
  );
});

it("maps explicitly supplied backend workdirs without rediscovering the sandbox", async () => {
  const result = await normalizeMedia(["/sandbox/screens/final.png"], {
    sandboxRoot: "/tmp/sandboxes/session-1",
    sandboxContainerWorkdir: "/sandbox",
  });

  expectMedia(result, "/tmp/outbound-media/final.png");
  expectOutboundAttachmentCall(0, path.join("/tmp/sandboxes/session-1", "screens", "final.png"));
  expect(ensureSandboxWorkspaceForSession).not.toHaveBeenCalled();
});

it("drops sandbox-mapped media when staging fails instead of retrying the workspace fallback", async () => {
  ensureSandboxWorkspaceForSession.mockResolvedValue(sandboxWorkspace);
  resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(new Error("media too large"));
  const result = await normalizeMedia(["./out/photo.png"]);
  expectNoMedia(result);
  expect(resolveOutboundAttachmentFromUrl).toHaveBeenCalledTimes(1);
  expectOutboundAttachmentCall(0, path.join("/tmp/sandboxes/session-1", "out", "photo.png"));
  expect(result.text).toBe("⚠️ photo.png: Delivery failed. Try sending this file again.");
});

it.each<
  [
    string,
    string,
    (typeof sandboxWorkspace & { workspaceAccess?: "none" })?,
    Partial<NormalizerOptions>?,
  ]
>([
  ["host file URL with sandbox", "file:///Users/peter/Documents/report.pdf", sandboxWorkspace],
  [
    "unmapped absolute host path",
    "/Users/peter/Documents/report.pdf",
    sandboxWorkspace,
    { cfg: { tools: { fs: { workspaceOnly: false } } } },
  ],
  [
    "unmounted host workspace",
    "/Users/peter/.openclaw/workspace/reports/screenshot.png",
    { ...sandboxWorkspace, workspaceAccess: "none" },
    { workspaceDir: "/Users/peter/.openclaw/workspace" },
  ],
  ["workspace traversal", "../../etc/passwd"],
  ["sandbox traversal", "../../etc/passwd", sandboxWorkspace],
])("rejects %s before attachment loading", async (_name, mediaUrl, sandbox, options) => {
  ensureSandboxWorkspaceForSession.mockResolvedValue(sandbox ?? null);
  const result = await normalizeMedia([mediaUrl], options);
  expectNoMedia(result);
  expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
});

it("stages media using mounted workspace before sandbox mapping", async () => {
  const source = "/Users/peter/.openclaw/workspace/reports/screenshot.png";
  ensureSandboxWorkspaceForSession.mockResolvedValue({
    ...sandboxWorkspace,
    workspaceAccess: "rw",
  });
  const workspaceDir = "/Users/peter/.openclaw/workspace";
  const result = await normalizeMedia([source], { workspaceDir });
  const stagedPath = path.join("/tmp/outbound-media", path.basename(source));
  expectMedia(result, stagedPath, [stagedPath]);
  expectOutboundAttachmentCall(0, path.resolve(workspaceDir, source));
});

it("keeps managed media and source spelling", async () => {
  const source = "/Users/peter/.openclaw/media/tool-image-generation/./generated.png";
  const normalized = "/Users/peter/.openclaw/media/tool-image-generation/generated.png";
  setTestEnvValue("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
  const result = await normalizeMedia([source]);
  expectMedia(result, normalized);
  expect(
    collectReplyMediaEntries(result, result.mediaUrls).map((entry) => entry.sourceUrls),
  ).toEqual([[source]]);
  expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
});

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
    const result = await normalizeMedia([symlinkPath]);
    expectNoMedia(result);
    expect(resolveOutboundAttachmentFromUrl).not.toHaveBeenCalled();
  } finally {
    await fs.rm(symlinkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it("drops media for host-read media type rejection", async () => {
  const logSpy = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
  resolveOutboundAttachmentFromUrl.mockRejectedValueOnce(
    new HostReadMediaTypeError("private_media_error"),
  );
  const result = await normalizeMedia(["./private_media_source/settings.toml"]);
  expectNoMedia(result);
  expect(result.text).toBe(
    "⚠️ settings.toml: Rejected by the local attachment allowlist. Send a supported file type.",
  );
  expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toMatchObject([
    { code: "unsupported-format", label: "settings.toml" },
  ]);
  expect(logSpy).toHaveBeenCalledWith("dropping blocked reply media: reason=unsupported-format");
  expect(JSON.stringify(logSpy.mock.calls)).not.toContain("private_media_");
});

it("keeps surviving media and appends a named receipt for each dropped item", async () => {
  const localSource = "./out/clip.mp4";
  const stagedSource = "/tmp/outbound-media/clip.mp4";
  const remoteSource = "https://example.com/ok.png";
  resolveOutboundAttachmentFromUrl
    .mockRejectedValueOnce(new LocalMediaAccessError("not-found", "missing test fixture"))
    .mockResolvedValueOnce({ path: stagedSource, contentType: "video/mp4" });
  const localAttachment: ReplyMediaAttachment = {
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
  };
  const remoteAttachment = { url: remoteSource, name: "Remote chart.png", mimeType: "image/png" };
  const payload: ReplyPayload = {
    text: "Here is the surviving attachment",
    mediaUrls: ["./out/missing.png", remoteSource, localSource],
    attachments: [localAttachment, remoteAttachment],
  };
  const original = structuredClone(payload);

  const result = await createTestReplyMediaNormalizer()(payload);

  expect(result.text).toBe(
    "Here is the surviving attachment\n⚠️ missing.png: File not found. Check the path and try again.",
  );
  expectMedia(result, remoteSource, [remoteSource, stagedSource]);
  expect(result.attachments).toEqual([
    remoteAttachment,
    {
      ...localAttachment,
      path: stagedSource,
      url: stagedSource,
      mediaUrl: stagedSource,
      filePath: stagedSource,
      trustedLocalMedia: true,
    },
  ]);
  expect(payload).toEqual(original);
});

it("threads requester context into shared outbound media access", async () => {
  const requester = {
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
  };
  const expectedRequest = structuredClone({
    ...requester,
    agentId: undefined,
    mediaSources: [path.join("/tmp/agent-workspace", "out", "photo.png")],
  });
  await createReplyMediaPathNormalizer(requester)({ mediaUrls: ["./out/photo.png"] });
  expect(resolveAgentScopedHostOutboundMediaAccess).toHaveBeenCalledExactlyOnceWith(
    expectedRequest,
  );
});
