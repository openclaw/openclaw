import { once } from "node:events";
import fs from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import * as mediaMime from "@openclaw/media-core/mime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  handleManagedOutgoingMediaHttpRequest,
} from "../managed-image-attachments.js";
import {
  prepareManagedSessionStore,
  requireAttachmentIdFromUrl,
  requireManagedOriginalPath,
} from "../managed-image-attachments.test-support.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";

const { getRuntimeConfig, readMessages, runFfprobe, runFfmpeg } = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(() => ({})),
  readMessages: vi.fn<() => Promise<unknown[]>>(),
  runFfprobe: vi.fn(async () =>
    JSON.stringify({
      format: { duration: "60" },
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" }],
    }),
  ),
  runFfmpeg: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({ getRuntimeConfig }));
vi.mock("../../media/ffmpeg-exec.js", () => ({ runFfprobe, runFfmpeg }));
vi.mock("../session-transcript-readers.js", () => ({
  readSessionMessagesMatchingIdAsync: readMessages,
}));
vi.mock("../http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: async () => ({ ok: true, assertCurrent: () => {} }),
  resolveSharedSecretHttpOperatorScopes: () => ["operator.read"],
  resolveOpenAiCompatibleHttpSenderIsOwner: () => true,
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
const SESSION_KEY = "agent:main:main";
let stateDir: string;
let cfg: OpenClawConfig;

beforeAll(async () => {
  stateDir = tempDirs.make("openclaw-large-webchat-video-");
  cfg = {
    session: { store: await prepareManagedSessionStore(stateDir) },
    tools: { allow: ["read"] },
    agents: { entries: { main: { workspace: path.join(stateDir, "workspace") } } },
  };
  getRuntimeConfig.mockReturnValue(cfg);
});

it("streams a trusted owner webchat video over 16 MiB into managed storage and serves a seek range", async () => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sourcePath = path.join(workspaceDir, "movie.mp4");
    const size = 32 * 1024 * 1024;
    const marker = Buffer.from("seek target");
    const seekStart = size - marker.length;
    // A real MP4 signature plus sparse payload exercises size and seek without a movie fixture.
    await using source = await fs.open(sourcePath, "w");
    const header = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
    await source.write(header);
    await source.truncate(size);
    await source.write(marker, 0, marker.length, seekStart);

    const directive = parseReplyDirectives(`Here is the movie.\nMEDIA:${sourcePath}`);
    const channelReply = await createReplyMediaPathNormalizer({
      cfg,
      sessionKey: SESSION_KEY,
      workspaceDir,
      messageProvider: "discord",
    })(directive);
    expect(channelReply.mediaUrls).toBeUndefined();

    await expect(
      createManagedOutgoingMediaBlocks({
        sessionKey: SESSION_KEY,
        items: [{ url: sourcePath, trustedLocal: false }],
        localRoots: [workspaceDir],
      }),
    ).rejects.toThrow(/Managed video attachment.*could not be prepared/u);

    let largestAllocation = 0;
    const allocateSafe = Buffer.alloc.bind(Buffer);
    const allocate = Buffer.allocUnsafe.bind(Buffer);
    const allocateSlow = Buffer.allocUnsafeSlow.bind(Buffer);
    const safeSpy = vi.spyOn(Buffer, "alloc").mockImplementation((bytes, fill, encoding) => {
      largestAllocation = Math.max(largestAllocation, bytes);
      return allocateSafe(bytes, fill, encoding);
    });
    const fastSpy = vi.spyOn(Buffer, "allocUnsafe").mockImplementation((bytes) => {
      largestAllocation = Math.max(largestAllocation, bytes);
      return allocate(bytes);
    });
    const slowSpy = vi.spyOn(Buffer, "allocUnsafeSlow").mockImplementation((bytes) => {
      largestAllocation = Math.max(largestAllocation, bytes);
      return allocateSlow(bytes);
    });
    const detectMime = mediaMime.detectMime;
    let sourceHeaderChanged = false;
    const mimeSpy = vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
      const mime = await detectMime(params);
      if (!sourceHeaderChanged && !params.filePath && mime === "video/mp4") {
        sourceHeaderChanged = true;
        await source.write(Buffer.alloc(header.length, 0x20), 0, header.length, 0);
      }
      return mime;
    });
    try {
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        sessionKey: SESSION_KEY,
        agentId: "main",
        sessionEntry: undefined,
        payloads: [directive],
      });
      expect(payloads[0]).toMatchObject({
        text: "Here is the movie.",
        trustedLocalMedia: true,
        mediaUrls: [expect.stringContaining(`${path.sep}media${path.sep}outbound${path.sep}`)],
      });
      expect(sourceHeaderChanged).toBe(true);
      const preparedPath = payloads[0]?.mediaUrls?.[0];
      if (!preparedPath) {
        throw new Error("Expected a prepared video path");
      }
      await using prepared = await fs.open(preparedPath, "r");
      const persistedHeader = Buffer.alloc(header.length);
      await prepared.read(persistedHeader, 0, persistedHeader.length, 0);
      expect(persistedHeader).toEqual(header);
      const { assistantContent, persistedAssistantContent } = await buildAssistantReplyContent({
        sessionKey: SESSION_KEY,
        payloads,
        managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
      });
      const block = assistantContent?.find((item) => item.type === "video");
      expect(block).toMatchObject({ type: "video", mimeType: "video/mp4", playback: "native" });
      if (!block || typeof block.url !== "string") {
        throw new Error("Expected an inline managed video URL");
      }
      const attachmentId = requireAttachmentIdFromUrl(block.url);
      const originalPath = await requireManagedOriginalPath(stateDir, attachmentId);
      expect((await fs.stat(originalPath)).size).toBe(size);
      await attachManagedOutgoingMediaToMessage({
        messageId: "movie-reply",
        blocks: persistedAssistantContent,
        stateDir,
      });
      readMessages.mockResolvedValue([
        {
          role: "assistant",
          content: persistedAssistantContent,
          __openclaw: { id: "movie-reply" },
        },
      ]);

      const req = new IncomingMessage(new Socket());
      req.method = "GET";
      req.url = block.url;
      req.headers.range = `bytes=${seekStart}-${size - 1}`;
      const { res, setHeader } = makeMockHttpResponse();
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      const finished = once(res, "finish");
      expect(
        await handleManagedOutgoingMediaHttpRequest(req, res, {
          auth: { mode: "none", allowTailscale: false },
          stateDir,
        }),
      ).toBe(true);
      await finished;
      expect(res.statusCode).toBe(206);
      expect(setHeader).toHaveBeenCalledWith(
        "Content-Range",
        `bytes ${seekStart}-${size - 1}/${size}`,
      );
      expect(setHeader).toHaveBeenCalledWith("Accept-Ranges", "bytes");
      expect(Buffer.concat(chunks)).toEqual(marker);
      expect(largestAllocation).toBeLessThan(size);
      expect(runFfprobe).toHaveBeenCalledWith(expect.any(Array), {
        stdinFileDescriptor: expect.any(Number),
      });
      expect(runFfmpeg).not.toHaveBeenCalled();
    } finally {
      mimeSpy.mockRestore();
      safeSpy.mockRestore();
      fastSpy.mockRestore();
      slowSpy.mockRestore();
    }
  });
});
