import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { consumePendingToolMediaIntoReply } from "../../agents/embedded-agent-subscribe.handlers.messages.replies.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { saveMediaBuffer } from "../../media/store.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createManagedOutgoingMediaBlocks as createManagedOutgoingImageBlocks } from "../managed-image-attachments.js";
import {
  buildAssistantReplyContent,
  buildAssistantReplyContentFromInputs,
} from "./chat-assistant-content.js";
import {
  captureWebchatReplyMediaScope,
  normalizeWebchatReplyMediaPathsForDisplay,
} from "./chat-reply-media.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const TEST_SESSION_KEY = "agent:main:webchat:direct:user";

let storeSaveSpy: MockInstance<typeof import("../../media/fetch.js").saveRemoteMedia> | undefined;

beforeAll(async () => {
  // Spy after graph evaluation: importOriginal(fetch) can pull store into its mock cycle.
  const mediaFetch = await import("../../media/fetch.js");
  const saveRemoteMedia = mediaFetch.saveRemoteMedia;
  storeSaveSpy = vi.spyOn(mediaFetch, "saveRemoteMedia").mockImplementation(saveRemoteMedia);
});

afterAll(() => {
  storeSaveSpy?.mockRestore();
});

type ReplyMediaPayloads = Parameters<
  typeof normalizeWebchatReplyMediaPathsForDisplay
>[0]["payloads"];
type ReplyMediaPayload = ReplyMediaPayloads[number];

type MediaTestContext = {
  stateDir: string;
  agentDir: string;
  workspaceDir: string;
  cfg: OpenClawConfig;
};

describe("normalizeWebchatReplyMediaPathsForDisplay", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-reply-media-",
    });
  });

  afterEach(async () => {
    await drainGlobalSingletonLifecycleState();
    await testState.cleanup();
  });

  function createConfig(params: {
    agentDir: string;
    workspaceDir: string;
    allowRead: boolean;
  }): OpenClawConfig {
    return {
      tools: params.allowRead ? { allow: ["read"] } : { fs: { workspaceOnly: true } },
      agents: {
        entries: {
          main: {
            agentDir: params.agentDir,
            workspace: params.workspaceDir,
          },
        },
      },
    };
  }

  function createMediaTestContext(params: { allowRead: boolean }): MediaTestContext {
    const stateDir = testState.stateDir;
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(stateDir, "workspace");
    return {
      stateDir,
      agentDir,
      workspaceDir,
      cfg: createConfig({ agentDir, workspaceDir, allowRead: params.allowRead }),
    };
  }

  async function createCodexHomeImage(params: { agentDir: string }): Promise<string> {
    const imagePath = path.join(params.agentDir, "codex-home", "outputs", "chart.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, PNG_BYTES);
    return imagePath;
  }

  async function createAudioFile(audioPath: string): Promise<void> {
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  }

  function requireString(value: string | undefined, label: string): string {
    if (!value) {
      throw new Error(`expected ${label}`);
    }
    return value;
  }

  function dataImageUrl(): string {
    return `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
  }

  async function normalizeReplyMedia(params: {
    cfg: OpenClawConfig;
    payloads: ReplyMediaPayloads;
  }) {
    const scope = captureWebchatReplyMediaScope({
      cfg: params.cfg,
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      sessionLoadOptions: { agentId: "main" },
    });
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: params.payloads,
    });
    return payload;
  }

  async function createManagedImageBlocks(params: {
    cfg: OpenClawConfig;
    mediaUrls: string[] | undefined;
  }) {
    return createManagedOutgoingImageBlocks({
      sessionKey: TEST_SESSION_KEY,
      items: (params.mediaUrls ?? []).map((url) => ({ url, trustedLocal: false })),
      localRoots: getAgentScopedMediaLocalRoots(params.cfg, "main"),
    });
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fs.stat(targetPath);
      throw new Error(`expected ${targetPath} to be missing`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ENOENT");
    }
  }

  async function expectOutboundMediaMissing(stateDir: string): Promise<void> {
    await expectPathMissing(path.join(stateDir, "media", "outbound"));
  }

  it("reports a rejected final MEDIA directive without exposing its URL", async () => {
    const source = "https://user:synthetic-password@example.com/movie.mp4";
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [`Here is the movie.\nMEDIA:${source}`],
      lastAssistant: undefined,
      sessionKey: TEST_SESSION_KEY,
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("public HTTPS URL without credentials");
    expect(payloads[0]?.text).not.toContain(source);
    expect(payloads[0]?.text).not.toContain("MEDIA:");
    expect(payloads[0]?.mediaUrls).toBeUndefined();

    const { assistantContent, persistedAssistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      payloads,
    });
    expect(assistantContent).toEqual([
      { type: "text", text: "Here is the movie." },
      {
        type: "attachment_error",
        attachment: {
          code: "invalid-reference",
          kind: "document",
          label: "Media not attached",
        },
      },
    ]);
    expect(persistedAssistantContent).toEqual(assistantContent);
  });

  it("stages workspace documents above the 5 MB channel default for WebChat download", async () => {
    const { workspaceDir, cfg } = createMediaTestContext({ allowRead: true });
    const archivePath = path.join(workspaceDir, "exports", "pack.zip");
    const archiveBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(6 * 1024 * 1024),
    ]);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, archiveBytes);

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ text: "Here it is:", mediaUrls: [archivePath] }],
    });
    expect(payload?.text).toBe("Here it is:");
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: payload ? [payload] : [],
      managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
    });
    expect(assistantContent).toEqual([
      { type: "text", text: "Here it is:" },
      expect.objectContaining({
        type: "attachment",
        attachment: expect.objectContaining({
          kind: "document",
          label: "pack.zip",
          sizeBytes: archiveBytes.byteLength,
        }),
      }),
    ]);
  });

  it("publishes a canonical inbound image from a directive reply", async () => {
    const { cfg } = createMediaTestContext({ allowRead: true });
    const saved = await saveMediaBuffer(PNG_BYTES, "image/png", "inbound", undefined, "photo.png");
    const source = `media://inbound/${saved.id}`;
    const caption = "Here it is again.";
    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [parseReplyDirectives(`[[reply_to_current]] ${caption}\nMEDIA:${source}`)],
    });

    expect(payload?.text).toBe(caption);
    expect(payload?.replyToCurrent).toBe(true);
    const normalizedPath = requireString(payload?.mediaUrls?.[0], "normalized media path");
    expect(await fs.readFile(normalizedPath)).toEqual(PNG_BYTES);
    const blocks = await createManagedImageBlocks({ cfg, mediaUrls: payload?.mediaUrls });
    expect(blocks).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.length,
      }),
    ]);
  });

  it("does not give inbound URIs broader sandbox access than their stored paths", async () => {
    const { cfg, stateDir, workspaceDir } = createMediaTestContext({ allowRead: true });
    const saved = await saveMediaBuffer(PNG_BYTES, "image/png", "inbound", undefined, "photo.png");
    const normalize = createReplyMediaPathNormalizer({
      cfg,
      sessionKey: TEST_SESSION_KEY,
      workspaceDir,
      sandboxRoot: path.join(stateDir, "sandbox"),
    });

    for (const source of [saved.path, `media://inbound/${saved.id}`]) {
      const payload = await normalize({ mediaUrls: [source] });
      expect(payload.mediaUrls).toBeUndefined();
      expect(payload.text).toContain("Delivery failed");
    }
    await expectOutboundMediaMissing(stateDir);
  });

  it("keeps deferred tool media rejection visible", async () => {
    const mediaUrl = "file://attacker/share/probe.mp3";
    const { cfg, stateDir } = createMediaTestContext({ allowRead: true });
    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ text: "NO_REPLY", mediaUrls: [mediaUrl] }],
    });
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: payload ? [payload] : [],
      managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
    });
    expect(assistantContent).toEqual([
      expect.objectContaining({
        type: "attachment_error",
        attachment: expect.objectContaining({
          code: "delivery-failed",
          label: path.basename(new URL(mediaUrl).pathname),
        }),
      }),
    ]);
    await expectOutboundMediaMissing(stateDir);
  });

  it("preserves named rejection outcomes and metadata beside trusted local audio", async () => {
    const { workspaceDir, cfg } = createMediaTestContext({ allowRead: true });
    const documentPath = path.join(workspaceDir, "report.json");
    const unsupportedPath = path.join(workspaceDir, "script.js");
    const audioPath = path.join(workspaceDir, "voice.mp3");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(documentPath, '{"ready":true}\n');
    await fs.writeFile(unsupportedPath, "export default true;\n");
    await createAudioFile(audioPath);

    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [
        {
          text: "Artifacts ready",
          mediaUrls: [documentPath, unsupportedPath, audioPath],
          attachments: [
            { name: "report.json", mimeType: "application/json", trustedLocalMedia: true },
            { name: "script.js", mimeType: "text/javascript", trustedLocalMedia: true },
            { name: "voice.mp3", mimeType: "audio/mpeg", trustedLocalMedia: true },
          ],
          trustedLocalMedia: true,
        },
      ],
    });

    expect(payload).toMatchObject({
      text: "Artifacts ready\n⚠️ script.js: Rejected by the local attachment allowlist. Send a supported file type.",
      mediaUrls: [expect.stringMatching(/\.json$/u), audioPath],
      attachments: [
        expect.objectContaining({ name: "report.json", mimeType: "application/json" }),
        expect.objectContaining({ name: "voice.mp3", mimeType: "audio/mpeg" }),
      ],
    });

    if (!payload) {
      throw new Error("Expected a prepared mixed-media payload");
    }
    const preparedMediaUrls = payload.mediaUrls ?? [];
    const missingDocument = path.join(workspaceDir, "missing.json");
    payload.mediaUrls = [...preparedMediaUrls, missingDocument];
    payload.attachments = [
      ...(payload.attachments ?? []),
      { name: "missing.json", mimeType: "application/json" },
    ];
    const finalized = await normalizeReplyMedia({ cfg, payloads: [payload] });
    expect(finalized?.mediaUrls).toEqual(preparedMediaUrls);
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: finalized ? [finalized] : [],
      managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
    });
    expect(assistantContent?.filter((block) => block.type === "text")).toEqual([
      { type: "text", text: "Artifacts ready" },
    ]);
    expect(assistantContent?.filter((block) => block.type === "attachment_error")).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "unsupported-format",
          kind: "document",
          label: "script.js",
          mimeType: "text/javascript",
        },
      },
      {
        type: "attachment_error",
        attachment: {
          code: "file-not-found",
          kind: "document",
          label: "missing.json",
          mimeType: "application/json",
        },
      },
    ]);
  });

  it("preserves sensitive images without staging", async () => {
    const { stateDir, agentDir, cfg } = createMediaTestContext({ allowRead: true });
    const source = await createCodexHomeImage({ agentDir });
    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [{ mediaUrls: [source], sensitiveMedia: true }],
    });
    expect(payload?.mediaUrl).toBeUndefined();
    expect(payload?.mediaUrls).toEqual([source]);
    expect(payload?.sensitiveMedia).toBe(true);
    await expectOutboundMediaMissing(stateDir);
  });

  it.each(["invalid data", "unknown file"] as const)(
    "projects a named failure for %s without exposing its source",
    async (kind) => {
      const { workspaceDir } = createMediaTestContext({ allowRead: true });
      const source =
        kind === "invalid data"
          ? "data:audio/mpeg;base64,not-valid!"
          : path.join(workspaceDir, "mystery.blob");
      if (kind === "unknown file") {
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(source, Buffer.from([0, 1, 2, 3]));
      }
      const errors: string[] = [];
      const { assistantContent: content, persistedAssistantContent } =
        await buildAssistantReplyContent({
          sessionKey: TEST_SESSION_KEY,
          agentId: "main",
          payloads: [
            {
              mediaUrls: [source],
              ...(kind === "unknown file"
                ? {
                    text: "Artifact result",
                    attachments: [{ name: "mystery.blob", trustedLocalMedia: true }],
                  }
                : {}),
            },
          ],
          managedMediaLocalRoots: [workspaceDir],
          onManagedMediaPrepareError: (message) => errors.push(message),
        });
      expect(content).toEqual([
        ...(kind === "unknown file" ? [{ type: "text", text: "Artifact result" }] : []),
        {
          type: "attachment_error",
          attachment: {
            code: "delivery-failed",
            kind: kind === "invalid data" ? "audio" : "document",
            label: kind === "invalid data" ? "Generated audio 1" : "mystery.blob",
          },
        },
      ]);
      expect(persistedAssistantContent).toEqual(content);
      expect(JSON.stringify(content)).not.toContain(source);
      expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThan(256);
      if (kind === "invalid data") {
        expect(errors).toEqual(["Invalid image data URL"]);
      }
    },
  );

  it.each(["paragraphs", "reply caption"] as const)(
    "preserves %s beside the corresponding image in saved replies",
    async (kind) => {
      const paragraphs = kind === "paragraphs";
      const replyToCurrent = kind === "reply caption";
      const payloads = paragraphs
        ? [{ text: "First paragraph" }, { text: "Second paragraph", mediaUrl: dataImageUrl() }]
        : [{ mediaUrl: dataImageUrl(), replyToCurrent }, { text: "Following paragraph" }];
      const { assistantContent, persistedAssistantContent } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads,
        transcriptMediaMessage: await buildWebchatAssistantMessageFromReplyPayloads(payloads),
      });
      expect(assistantContent?.map((block) => block.type)).toEqual(
        paragraphs ? ["text", "image"] : ["image", "text"],
      );
      expect(persistedAssistantContent?.map((block) => block.type)).toEqual(
        paragraphs ? ["text", "text", "image"] : ["text", "image", "text"],
      );
      expect(
        persistedAssistantContent
          ?.filter((block) => block.type === "text")
          .map((block) => block.text),
      ).toEqual(
        paragraphs
          ? ["First paragraph", "Second paragraph"]
          : [`${replyToCurrent ? "[[reply_to_current]]" : ""}Image reply`, "Following paragraph"],
      );
    },
  );

  it.each([
    { operation: "raw", media: "audio" },
    { operation: "prepared", media: "image" },
  ] as const)(
    "aligns $media metadata by URL without mutation ($operation)",
    async ({ operation, media }) => {
      const { workspaceDir } = createMediaTestContext({ allowRead: true });
      const audio = media === "audio";
      const first = audio ? path.join(workspaceDir, "first.mp3") : "https://example.test/first.png";
      const second = audio
        ? path.join(workspaceDir, "second.mp3")
        : "https://example.test/second.png";
      if (audio) {
        await createAudioFile(first);
        await fs.writeFile(second, Buffer.from([0xff, 0xfb, 0x90, 0x01]));
      }
      const payload: ReplyMediaPayload = audio
        ? {
            mediaUrl: second,
            mediaUrls: [first, first],
            trustedLocalMedia: true,
            attachments: [
              { type: "audio", path: first, name: "first.mp3", durationMs: 1_000 },
              { type: "audio", path: first, name: "wrong.mp3", durationMs: 9_999 },
              { type: "audio", name: "second.mp3", durationMs: 2_000 },
            ],
          }
        : {
            mediaUrls: [first, second],
            attachments: [{ url: second, name: "Second chart.png", mimeType: "image/png" }],
          };
      const originalPayload = structuredClone(payload);
      const preparationErrors: string[] = [];
      const requestedUrls: string[] = [];
      const saveRemoteMedia = storeSaveSpy;
      const previousSaveRemoteMedia = saveRemoteMedia?.getMockImplementation();
      if (!saveRemoteMedia || !previousSaveRemoteMedia) {
        throw new Error("expected the store remote-media spy to be installed");
      }
      if (!audio) {
        saveRemoteMedia.mockImplementation(async (options) => {
          expect(payload.mediaUrls).toContain(options.url);
          requestedUrls.push(options.url);
          return await saveMediaBuffer(
            PNG_BYTES,
            "image/png",
            options.subdir,
            options.maxBytes,
            options.originalFilename,
            options.filePathHint,
          );
        });
      }
      try {
        const { assistantContent: content } = await buildAssistantReplyContentFromInputs({
          sessionKey: TEST_SESSION_KEY,
          agentId: "main",
          inputs:
            operation === "prepared"
              ? createStructuredOutboundPayloadPlan([payload]).map((plan) => ({
                  kind: "prepared" as const,
                  plan,
                }))
              : [{ kind: "raw", payload }],
          ...(audio ? { managedMediaLocalRoots: [workspaceDir] } : {}),
          onManagedMediaPrepareError: (message) => preparationErrors.push(message),
        });
        expect(preparationErrors).toEqual([]);
        expect(content).toEqual(
          audio
            ? [
                expect.objectContaining({
                  type: "audio",
                  fileName: "first.mp3",
                  durationMs: 1_000,
                }),
                expect.objectContaining({
                  type: "audio",
                  fileName: "second.mp3",
                  durationMs: 2_000,
                }),
              ]
            : [
                expect.objectContaining({ type: "image", alt: "first.png", mimeType: "image/png" }),
                expect.objectContaining({
                  type: "image",
                  alt: "Second chart.png",
                  mimeType: "image/png",
                }),
              ],
        );
        if (!audio) {
          expect(requestedUrls).toEqual(payload.mediaUrls);
        }
        expect(payload).toEqual(originalPayload);
      } finally {
        saveRemoteMedia.mockImplementation(previousSaveRemoteMedia);
      }
    },
  );

  it("preserves per-item trust in a pending batch", async () => {
    const { workspaceDir } = createMediaTestContext({ allowRead: true });
    const first = path.join(workspaceDir, "trusted.mp3");
    const second = path.join(workspaceDir, "untrusted.mp3");
    await createAudioFile(first);
    await fs.writeFile(second, Buffer.from([0xff, 0xfb, 0x90, 0x01]));
    const payload = consumePendingToolMediaIntoReply(
      {
        pendingToolMediaUrls: [first, second],
        pendingToolMediaTrustByUrl: new Map([
          [first, true],
          [second, false],
        ]),
        pendingToolAudioAsVoice: false,
      },
      {},
    );
    const { assistantContent: content } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [payload],
      managedMediaLocalRoots: [workspaceDir],
    });
    expect(content).toEqual([
      expect.objectContaining({ type: "audio", mimeType: "audio/mpeg" }),
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "audio",
          label: "untrusted.mp3",
          mimeType: "audio/mpeg",
        },
      },
    ]);
  });
});
