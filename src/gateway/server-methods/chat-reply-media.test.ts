import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../../media/store-network.test-support.js";
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
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
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
  storeSaveSpy = vi
    .spyOn(mediaFetch, "saveRemoteMedia")
    .mockImplementation(wrapStoreSaveRemoteMedia(saveRemoteMedia));
});

afterAll(() => {
  try {
    disposeStoreRemoteFixtures();
  } finally {
    storeSaveSpy?.mockRestore();
  }
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
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg: params.cfg,
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      sessionEntry: undefined,
      payloads: params.payloads,
    });
    return payload;
  }

  async function normalizeCodexHomeImage(params: {
    allowRead: boolean;
    payload: (sourcePath: string) => ReplyMediaPayload;
  }) {
    const context = createMediaTestContext({ allowRead: params.allowRead });
    const sourcePath = await createCodexHomeImage({ agentDir: context.agentDir });
    const payload = await normalizeReplyMedia({
      cfg: context.cfg,
      payloads: [params.payload(sourcePath)],
    });
    return { ...context, sourcePath, payload };
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

  it.each([
    "http://192.168.1.138:64384/movie.mp4?openclaw_portal=synthetic-test-token",
    "https://127.0.0.1/movie.mp4",
    "https://user:synthetic-password@example.com/movie.mp4",
  ])("reports a rejected final MEDIA directive without exposing its URL: %s", async (source) => {
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

  it.each(["directive", "structured"])(
    "publishes a canonical inbound image from a %s reply",
    async (kind) => {
      const { cfg } = createMediaTestContext({ allowRead: true });
      const saved = await saveMediaBuffer(
        PNG_BYTES,
        "image/png",
        "inbound",
        undefined,
        "photo.png",
      );
      const source = `media://inbound/${saved.id}`;
      const caption = "Here it is again.";
      const payload = await normalizeReplyMedia({
        cfg,
        payloads: [
          kind === "directive"
            ? parseReplyDirectives(`[[reply_to_current]] ${caption}\nMEDIA:${source}`)
            : { text: caption, replyToCurrent: true, mediaUrls: [source] },
        ],
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
    },
  );

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

  it.each(["image", "audio", "image before inline", "image after inline"] as const)(
    "reports denied %s without leaking or staging its path",
    async (kind) => {
      const { stateDir, agentDir, cfg } = createMediaTestContext({ allowRead: false });
      const source =
        kind === "audio"
          ? path.join(testState.root, "outside", "voice.mp3")
          : await createCodexHomeImage({ agentDir });
      if (kind === "audio") {
        await createAudioFile(source);
      }
      const inline = kind.includes("inline");
      const dataUrl = dataImageUrl();
      const mediaUrls = !inline
        ? [source]
        : kind === "image before inline"
          ? [source, dataUrl]
          : [dataUrl, source];
      const payload = await normalizeReplyMedia({ cfg, payloads: [{ mediaUrls }] });
      expect(payload?.mediaUrl).toBe(inline ? dataUrl : undefined);
      expect(payload?.mediaUrls).toEqual(inline ? [dataUrl] : undefined);
      expect(requireString(payload?.text, "suppressed media text")).toBe(
        `⚠️ ${path.basename(source)}: Delivery failed. Try sending this file again.`,
      );
      expect(payload?.text).not.toContain(source);
      expect(Buffer.byteLength(payload?.text ?? "")).toBeLessThan(256);
      await expectOutboundMediaMissing(stateDir);
    },
  );

  it.each(["file://attacker/share/probe.mp3", "file:///outside/secret.png"])(
    "keeps deferred tool media rejection visible for %s",
    async (mediaUrl) => {
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
    },
  );

  it("preserves ordered document and image metadata beside one rejected SVG", async () => {
    const { workspaceDir, cfg } = createMediaTestContext({ allowRead: true });
    const documentPath = path.join(workspaceDir, "artifact.json");
    const localImagePath = path.join(workspaceDir, "local.png");
    const unsupportedPath = path.join(workspaceDir, "vector.svg");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(documentPath, '{"ready":true}\n');
    await fs.writeFile(localImagePath, PNG_BYTES);
    await fs.writeFile(unsupportedPath, "<svg><script/></svg>\n");
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe("/remote.png?sig=secret");
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(PNG_BYTES);
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address() as AddressInfo;

    try {
      const remoteImageUrl = `http://127.0.0.1:${address.port}/remote.png?sig=secret`;
      const payload = await normalizeReplyMedia({
        cfg,
        payloads: [
          {
            text: "Artifacts ready",
            mediaUrls: [documentPath, remoteImageUrl, localImagePath, unsupportedPath],
          },
        ],
      });

      expect(payload).toMatchObject({
        text: "Artifacts ready\n⚠️ vector.svg: Rejected by the local attachment allowlist. Send a supported file type.",
        attachments: [
          expect.objectContaining({ name: "artifact.json", mimeType: "application/json" }),
          {},
          expect.objectContaining({ name: "local.png", mimeType: "image/png" }),
        ],
      });
      expect(payload?.mediaUrls).toHaveLength(3);
      const matchedUrls: string[] = [];
      const { assistantContent: content } = await withStoreRemoteFixture(
        { url: remoteImageUrl, onMatch: (url) => matchedUrls.push(url) },
        () =>
          buildAssistantReplyContent({
            sessionKey: TEST_SESSION_KEY,
            agentId: "main",
            payloads: payload ? [payload] : [],
            managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
          }),
      );
      expect(matchedUrls).toEqual([remoteImageUrl]);
      expect(content).toEqual([
        { type: "text", text: "Artifacts ready" },
        expect.objectContaining({
          type: "attachment",
          attachment: expect.objectContaining({
            label: "artifact.json",
            mimeType: "application/json",
          }),
        }),
        expect.objectContaining({ type: "image", alt: "remote.png", mimeType: "image/png" }),
        expect.objectContaining({ type: "image", alt: "local.png", mimeType: "image/png" }),
        {
          type: "attachment_error",
          attachment: {
            code: "unsupported-format",
            kind: "image",
            label: "vector.svg",
            mimeType: "image/svg+xml",
          },
        },
      ]);
      const serialized = JSON.stringify(content);
      expect(serialized).toContain("vector.svg");
      expect(serialized).not.toContain("Media failed");
      expect(serialized).not.toContain("sig=secret");
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it.each(["sensitive image", "inline image", "trusted audio"] as const)(
    "preserves %s without staging",
    async (kind) => {
      const { stateDir, agentDir, workspaceDir, cfg } = createMediaTestContext({
        allowRead: kind !== "trusted audio",
      });
      const source =
        kind === "sensitive image"
          ? await createCodexHomeImage({ agentDir })
          : kind === "inline image"
            ? dataImageUrl()
            : path.join(workspaceDir, "voice.mp3");
      if (kind === "trusted audio") {
        await createAudioFile(source);
      }
      const metadata =
        kind === "sensitive image"
          ? { sensitiveMedia: true }
          : kind === "trusted audio"
            ? { trustedLocalMedia: true, audioAsVoice: true }
            : {};
      const payload = await normalizeReplyMedia({
        cfg,
        payloads: [{ mediaUrls: [source], ...metadata }],
      });
      expect(payload?.mediaUrl).toBeUndefined();
      expect(payload?.mediaUrls).toEqual([source]);
      expect(payload).toMatchObject(metadata);
      await expectOutboundMediaMissing(stateDir);
    },
  );

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

  it.each(["paragraphs", "caption", "reply caption"] as const)(
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
    {
      directive: false,
      kind: "audio" as const,
      fileName: "generated-theme.mp3",
      bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      mimeType: "audio/mpeg",
    },
    {
      directive: false,
      kind: "video" as const,
      fileName: "generated-clip.mp4",
      bytes: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
      mimeType: "video/mp4",
    },
    {
      directive: true,
      kind: "audio" as const,
      fileName: "directive.mp3",
      bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      mimeType: "audio/mpeg",
    },
  ])(
    "projects generated $kind into a managed history block (directive=$directive)",
    async ({ kind, fileName, bytes, mimeType, directive }) => {
      const { workspaceDir } = createMediaTestContext({ allowRead: true });
      const sourcePath = path.join(workspaceDir, fileName);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, bytes);

      const { assistantContent: content } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: [
          {
            text: directive ? `MEDIA:${sourcePath}` : "Generated media",
            ...(directive
              ? {}
              : {
                  mediaUrls: [sourcePath],
                  attachments: [
                    { type: kind, path: sourcePath, name: fileName, durationMs: 1_500 },
                  ],
                }),
            trustedLocalMedia: true,
          },
        ],
        managedMediaLocalRoots: [workspaceDir],
      });

      expect(content).toEqual([
        ...(directive ? [] : [{ type: "text", text: "Generated media" }]),
        expect.objectContaining({
          type: kind,
          artifactId: expect.stringMatching(/^artifact_managed_media_/u),
          fileName,
          mimeType,
          ...(directive ? {} : { durationMs: 1_500 }),
        }),
      ]);
      expect(JSON.stringify(content)).not.toContain(sourcePath);
    },
  );

  it.each([
    { operation: "raw", media: "audio" },
    { operation: "prepared", media: "audio" },
    { operation: "raw", media: "image" },
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

  it.each(["pending batch", "interleaved attachments"] as const)(
    "preserves per-item trust and ordering in %s",
    async (kind) => {
      const { workspaceDir } = createMediaTestContext({ allowRead: true });
      const first = path.join(workspaceDir, "trusted.mp3");
      const second = path.join(workspaceDir, "untrusted.mp3");
      await createAudioFile(first);
      await fs.writeFile(second, Buffer.from([0xff, 0xfb, 0x90, 0x01]));
      const pending = kind === "pending batch";
      const payload = pending
        ? consumePendingToolMediaIntoReply(
            {
              pendingToolMediaUrls: [first, second],
              pendingToolMediaTrustByUrl: new Map([
                [first, true],
                [second, false],
              ]),
              pendingToolAudioAsVoice: false,
            },
            {},
          )
        : {
            mediaUrls: [first, dataImageUrl(), second],
            attachments: [
              { type: "audio" as const, path: first, trustedLocalMedia: true },
              { type: "image" as const },
              { type: "audio" as const, path: second, trustedLocalMedia: true },
            ],
          };
      const { assistantContent: content } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: [payload],
        managedMediaLocalRoots: [workspaceDir],
      });
      if (pending) {
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
      } else {
        expect(content?.map((block) => block.type)).toEqual(["audio", "image", "audio"]);
      }
    },
  );

  it("retains earlier and newly observed failures beside an inline image", async () => {
    const { cfg, workspaceDir } = createMediaTestContext({ allowRead: false });
    const payload = await normalizeReplyMedia({
      cfg,
      payloads: [
        setReplyPayloadMetadata(
          {
            mediaUrls: [dataImageUrl(), path.join(workspaceDir, "missing.png")],
          },
          {
            assistantMediaFailures: [
              {
                code: "file-not-found",
                kind: "document",
                label: "earlier.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        ),
      ],
    });
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: payload ? [payload] : [],
      managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
    });
    expect(assistantContent?.filter((block) => block.type === "attachment_error")).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "file-not-found",
          kind: "document",
          label: "earlier.pdf",
          mimeType: "application/pdf",
        },
      },
      {
        type: "attachment_error",
        attachment: {
          code: "file-not-found",
          kind: "image",
          label: "missing.png",
          mimeType: "image/png",
        },
      },
    ]);
    expect(assistantContent?.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("keeps one named failure receipt per missing file around surviving media", async () => {
    const dataUrl = dataImageUrl();
    const { stateDir, cfg, sourcePath, payload } = await normalizeCodexHomeImage({
      allowRead: true,
      payload: (imagePath) => ({
        text: "Here is the surviving attachment",
        mediaUrls: [
          path.join(path.dirname(imagePath), "missing.png"),
          imagePath,
          dataUrl,
          path.join(path.dirname(imagePath), "private customer report.png"),
        ],
      }),
    });
    const normalizedLocalPath = requireString(payload?.mediaUrls?.[0], "normalized local media");

    expect(payload?.text).toContain(
      "Here is the surviving attachment\n⚠️ missing.png: File not found. Check the path and try again.",
    );
    expect(payload?.text).not.toContain(sourcePath);
    expect(payload?.text).toContain(
      "⚠️ private customer report.png: File not found. Check the path and try again.",
    );
    expect(Buffer.byteLength(payload?.text ?? "")).toBeLessThan(512);
    expect(payload?.mediaUrl).toBe(normalizedLocalPath);
    expect(payload?.mediaUrls).toEqual([normalizedLocalPath, dataUrl]);
    const blocks = await createManagedImageBlocks({ cfg, mediaUrls: payload?.mediaUrls });
    expect(blocks.map((block) => block.type)).toEqual(["image", "image"]);
    expect(normalizedLocalPath).not.toBe(sourcePath);
    expect(normalizedLocalPath.startsWith(path.join(stateDir, "media"))).toBe(true);
  });
});
