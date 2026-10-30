import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { consumePendingToolMediaIntoReply } from "../../agents/embedded-agent-subscribe.handlers.messages.replies.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
  buildAssistantReplyContent as buildReplyContent,
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

type ReplyMediaPayloads = Parameters<
  typeof normalizeWebchatReplyMediaPathsForDisplay
>[0]["payloads"];
type ReplyMediaPayload = ReplyMediaPayloads[number];

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

function createMediaTestContext() {
  const stateDir = testState.stateDir;
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(stateDir, "workspace");
  const cfg: OpenClawConfig = {
    tools: { allow: ["read"] },
    agents: { entries: { main: { agentDir, workspace: workspaceDir } } },
  };
  setRuntimeConfigSnapshot(cfg);
  return { stateDir, agentDir, workspaceDir, cfg };
}

async function writeMedia(file: string, bytes: Buffer | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return file;
}

async function createAudioFile(audioPath: string): Promise<void> {
  await writeMedia(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
}

const dataImageUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

async function normalizeReplyMedia(cfg: OpenClawConfig, payloads: ReplyMediaPayloads) {
  const scope = await captureWebchatReplyMediaScope({
    cfg,
    sessionKey: TEST_SESSION_KEY,
    agentId: "main",
    sessionLoadOptions: { agentId: "main" },
  });
  onTestFinished(scope.release);
  return (await normalizeWebchatReplyMediaPathsForDisplay({ ...scope, payloads }))[0];
}

async function expectOutboundMediaMissing(stateDir: string) {
  await expect(fs.stat(path.join(stateDir, "media", "outbound"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function buildContent(params: Omit<Parameters<typeof buildReplyContent>[0], "sessionKey">) {
  return buildReplyContent({ sessionKey: TEST_SESSION_KEY, ...params });
}

function attachmentError(code: string, label: string, kind = "document", mimeType?: string) {
  return {
    type: "attachment_error",
    attachment: { code, kind, label, ...(mimeType ? { mimeType } : {}) },
  };
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

  const { assistantContent: content, persistedAssistantContent: persisted } = await buildContent({
    payloads,
  });
  expect(content).toEqual([
    { type: "text", text: "Here is the movie." },
    attachmentError("invalid-reference", "Media not attached"),
  ]);
  expect(persisted).toEqual(content);
});

it("publishes a canonical inbound image from a directive reply", async () => {
  const { cfg } = createMediaTestContext();
  const saved = await saveMediaBuffer(PNG_BYTES, "image/png", "inbound", undefined, "photo.png");
  const source = `media://inbound/${saved.id}`;
  const caption = "Here it is again.";
  const payload = await normalizeReplyMedia(cfg, [
    parseReplyDirectives(`[[reply_to_current]] ${caption}\nMEDIA:${source}`),
  ]);

  expect(payload).toMatchObject({ text: caption, replyToCurrent: true });
  const normalizedPath = expectDefined(payload?.mediaUrls?.[0], "normalized media path");
  expect(await fs.readFile(normalizedPath)).toEqual(PNG_BYTES);
  const blocks = await createManagedOutgoingImageBlocks({
    sessionKey: TEST_SESSION_KEY,
    items: (payload?.mediaUrls ?? []).map((url) => ({ url, trustedLocal: false })),
    localRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
  });
  expect(blocks).toMatchObject([
    { type: "image", mimeType: "image/png", sizeBytes: PNG_BYTES.length },
  ]);
});

it("does not give inbound URIs broader sandbox access than their stored paths", async () => {
  const { cfg, stateDir, workspaceDir } = createMediaTestContext();
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
  const { cfg, stateDir } = createMediaTestContext();
  const payload = await normalizeReplyMedia(cfg, [{ text: "NO_REPLY", mediaUrls: [mediaUrl] }]);
  const { assistantContent: content } = await buildContent({
    agentId: "main",
    payloads: payload ? [payload] : [],
    managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
  });
  expect(content).toEqual([
    { type: "text", text: "NO_REPLY" },
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
  const { workspaceDir, cfg } = createMediaTestContext();
  const documentPath = path.join(workspaceDir, "report.json");
  const unsupportedPath = path.join(workspaceDir, "script.js");
  const audioPath = path.join(workspaceDir, "voice.mp3");
  await writeMedia(documentPath, '{"ready":true}\n');
  await writeMedia(unsupportedPath, "export default true;\n");
  await createAudioFile(audioPath);

  const payload = await normalizeReplyMedia(cfg, [
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
  ]);

  expect(payload).toMatchObject({
    text: "Artifacts ready\n⚠️ script.js: Rejected by the local attachment allowlist. Send a supported file type.",
    mediaUrls: [expect.stringMatching(/\.json$/u), audioPath],
    attachments: [
      { name: "report.json", mimeType: "application/json" },
      { name: "voice.mp3", mimeType: "audio/mpeg" },
    ],
  });

  assert(payload, "Expected a prepared mixed-media payload");
  const preparedMediaUrls = payload.mediaUrls ?? [];
  const missingDocument = path.join(workspaceDir, "missing.json");
  payload.mediaUrls = [...preparedMediaUrls, missingDocument];
  payload.attachments = [
    ...(payload.attachments ?? []),
    { name: "missing.json", mimeType: "application/json" },
  ];
  const finalized = await normalizeReplyMedia(cfg, [payload]);
  expect(finalized?.mediaUrls).toEqual(preparedMediaUrls);
  const { assistantContent: content, mediaBySource } = await buildContent({
    agentId: "main",
    payloads: finalized ? [finalized] : [],
    managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
  });
  expect(content?.filter((block) => block.type === "text")).toEqual([
    { type: "text", text: "Artifacts ready" },
  ]);
  expect(mediaBySource?.get(documentPath)).toEqual([
    expect.objectContaining({ type: "attachment" }),
  ]);
  expect(mediaBySource?.get(audioPath)).toEqual([expect.objectContaining({ type: "audio" })]);
  expect(content?.filter((block) => block.type === "attachment_error")).toEqual([
    attachmentError("unsupported-format", "script.js", "document", "text/javascript"),
    attachmentError("file-not-found", "missing.json", "document", "application/json"),
  ]);
});

it("preserves sensitive images without staging", async () => {
  const { stateDir, agentDir, cfg } = createMediaTestContext();
  const source = await writeMedia(
    path.join(agentDir, "codex-home", "outputs", "chart.png"),
    PNG_BYTES,
  );
  const payload = await normalizeReplyMedia(cfg, [{ mediaUrls: [source], sensitiveMedia: true }]);
  expect(payload?.mediaUrl).toBeUndefined();
  expect(payload?.mediaUrls).toEqual([source]);
  expect(payload?.sensitiveMedia).toBe(true);
  await expectOutboundMediaMissing(stateDir);
});

it.each(["invalid data", "unknown file"] as const)(
  "projects a named failure for %s without exposing its source",
  async (kind) => {
    const { workspaceDir } = createMediaTestContext();
    const unknown = kind === "unknown file";
    const source = unknown
      ? path.join(workspaceDir, "mystery.blob")
      : "data:audio/mpeg;base64,not-valid!";
    const payload: ReplyMediaPayload = { mediaUrls: [source] };
    if (unknown) {
      await writeMedia(source, Buffer.from([0, 1, 2, 3]));
      payload.text = "Artifact result";
      payload.attachments = [{ name: "mystery.blob", trustedLocalMedia: true }];
    }
    const errors: string[] = [];
    const { assistantContent: content, persistedAssistantContent: persisted } = await buildContent({
      agentId: "main",
      payloads: [payload],
      managedMediaLocalRoots: [workspaceDir],
      onManagedMediaPrepareError: (message) => errors.push(message),
    });
    expect(content).toEqual([
      ...(unknown ? [{ type: "text", text: "Artifact result" }] : []),
      attachmentError(
        "delivery-failed",
        unknown ? "mystery.blob" : "Generated audio 1",
        unknown ? "document" : "audio",
      ),
    ]);
    expect(persisted).toEqual(content);
    expect(JSON.stringify(content)).not.toContain(source);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThan(256);
    if (!unknown) {
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
      ? [{ text: "First paragraph" }, { text: "Second paragraph", mediaUrl: dataImageUrl }]
      : [{ mediaUrl: dataImageUrl, replyToCurrent }, { text: "Following paragraph" }];
    const { assistantContent: content, persistedAssistantContent: persisted } = await buildContent({
      agentId: "main",
      payloads,
      transcriptMediaMessage: await buildWebchatAssistantMessageFromReplyPayloads(payloads),
    });
    expect(content?.map((block) => block.type)).toEqual(
      paragraphs ? ["text", "image"] : ["image", "text"],
    );
    expect(persisted?.map((block) => block.type)).toEqual(
      paragraphs ? ["text", "text", "image"] : ["text", "image", "text"],
    );
    expect(persisted?.filter((block) => block.type === "text").map((block) => block.text)).toEqual(
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
    const { workspaceDir } = createMediaTestContext();
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
    // Import after graph evaluation; the fetch/store modules participate in a mock cycle.
    const mediaFetch = await import("../../media/fetch.js");
    using saveRemoteMedia = vi.spyOn(mediaFetch, "saveRemoteMedia");
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
    expect(content).toMatchObject(
      audio
        ? [
            { type: "audio", fileName: "first.mp3", durationMs: 1_000 },
            { type: "audio", fileName: "second.mp3", durationMs: 2_000 },
          ]
        : [
            { type: "image", alt: "first.png", mimeType: "image/png" },
            { type: "image", alt: "Second chart.png", mimeType: "image/png" },
          ],
    );
    if (!audio) {
      expect(requestedUrls).toEqual(payload.mediaUrls);
    }
    expect(payload).toEqual(originalPayload);
  },
);

it("preserves per-item trust in a pending batch", async () => {
  const { workspaceDir } = createMediaTestContext();
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
  const { assistantContent: content } = await buildContent({
    agentId: "main",
    payloads: [payload],
    managedMediaLocalRoots: [workspaceDir],
  });
  expect(content).toEqual([
    expect.objectContaining({ type: "audio", mimeType: "audio/mpeg" }),
    attachmentError("delivery-failed", "untrusted.mp3", "audio", "audio/mpeg"),
  ]);
});
