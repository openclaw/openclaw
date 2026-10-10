import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasStagedMediaFacts,
  resolveMediaFacts,
  resolveStagedMediaFacts,
  type MediaFactInput,
  type MediaFactLegacyProjection,
} from "../../media/media-facts.js";
import { buildAgentMediaPayload } from "../../plugin-sdk/agent-media-payload.js";
import { buildMediaPayload } from "../plugins/media-payload.js";
import {
  buildChannelInboundMediaPayload,
  formatMediaPlaceholderText,
  formatInboundMediaUnavailableText,
  toHistoryMediaEntries,
  toInboundMediaFacts,
  toInboundMediaFactsWithMetadata,
  type ChannelInboundMediaInput,
} from "./media.js";

const { probeMediaFilesWithinBudget } = vi.hoisted(() => ({
  probeMediaFilesWithinBudget: vi.fn(),
}));

vi.mock("../../media/media-probe.js", () => ({ probeMediaFilesWithinBudget }));

beforeEach(() => {
  probeMediaFilesWithinBudget.mockReset();
});

type MergeMatrixSource = MediaFactLegacyProjection & {
  media?: readonly MediaFactInput[];
  MediaStaged?: boolean;
  MediaWorkspaceDir?: string;
};

const photo: MediaFactInput = {
  path: "/canonical/photo.jpg",
  url: "https://canonical.test/photo.jpg",
  contentType: "image/jpeg",
  kind: "image",
  transcribed: true,
  messageId: "photo",
};
const voice: MediaFactInput = {
  path: "/canonical/voice.ogg",
  contentType: "audio/ogg",
  kind: "audio",
  messageId: "voice",
  hydrationSuppressed: true,
};
const document: MediaFactInput = {
  path: "/canonical/one.bin",
  contentType: "application/octet-stream",
  kind: "document",
  transcribed: true,
  messageId: "one",
};
const audio: MediaFactInput = {
  path: "/canonical/two.bin",
  contentType: "application/octet-stream",
  kind: "audio",
  messageId: "two",
  hydrationSuppressed: true,
};
const unstagedPhoto: MediaFactInput = {
  path: "/canonical/photo.jpg",
  contentType: "image/jpeg",
  kind: "image",
  messageId: "photo",
};

const stagedMediaMergeMatrix: Array<{
  name: string;
  source: MergeMatrixSource;
  expected: Array<Partial<MediaFactInput>>;
  expectedStaged: boolean;
}> = [
  {
    name: "staged singular plus multi-canonical",
    source: {
      media: [{ ...photo }, { ...voice }],
      MediaPath: "/staged/photo.jpg",
      MediaStaged: true,
    },
    expected: [{ ...photo, path: "/staged/photo.jpg", staged: true }, voice],
    expectedStaged: false,
  },
  {
    name: "staged aligned arrays plus canonical metadata",
    source: {
      media: [{ ...document }, { ...audio }],
      MediaPaths: ["/staged/one.jpg", "/staged/two.ogg"],
      MediaUrls: ["file:///staged/one.jpg", "file:///staged/two.ogg"],
      MediaTypes: ["image/jpeg", "audio/ogg"],
      MediaWorkspaceDir: "/staged",
    },
    expected: [
      {
        ...document,
        path: "/staged/one.jpg",
        url: "file:///staged/one.jpg",
        contentType: "image/jpeg",
        workspaceDir: "/staged",
      },
      {
        ...audio,
        path: "/staged/two.ogg",
        url: "file:///staged/two.ogg",
        contentType: "audio/ogg",
        workspaceDir: "/staged",
      },
    ],
    expectedStaged: true,
  },
  {
    name: "staged-only",
    source: {
      MediaPaths: ["/staged/photo.jpg", "/staged/voice.ogg"],
      MediaUrls: ["file:///staged/photo.jpg", "file:///staged/voice.ogg"],
      MediaTypes: ["image/jpeg", "audio/ogg"],
      MediaTranscribedIndexes: [1],
      MediaWorkspaceDir: "/staged",
    },
    expected: [
      {
        path: "/staged/photo.jpg",
        contentType: "image/jpeg",
        kind: "image",
        transcribed: false,
        workspaceDir: "/staged",
      },
      {
        path: "/staged/voice.ogg",
        contentType: "audio/ogg",
        kind: "audio",
        transcribed: true,
        workspaceDir: "/staged",
      },
    ],
    expectedStaged: true,
  },
  {
    name: "canonical-only with an empty staged projection",
    source: {
      media: [{ ...unstagedPhoto, hydrationSuppressed: true }],
      MediaStaged: true,
    },
    expected: [{ ...unstagedPhoto, hydrationSuppressed: true, staged: true }],
    expectedStaged: true,
  },
  {
    name: "canonical path with staged URL metadata only",
    source: {
      media: [{ ...unstagedPhoto }],
      MediaUrl: "file:///canonical/photo.jpg",
      MediaStaged: true,
    },
    expected: [{ ...unstagedPhoto, url: "file:///canonical/photo.jpg", staged: true }],
    expectedStaged: true,
  },
];

describe("channel inbound media facts", () => {
  it("probes local audio and video facts without probing images or URL-only media", async () => {
    probeMediaFilesWithinBudget.mockResolvedValueOnce([
      { durationMs: 1500 },
      { durationMs: 2500, width: 1280, height: 720 },
    ]);

    await expect(
      toInboundMediaFactsWithMetadata([
        { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
        { path: "/tmp/clip.mp4", kind: "video" },
        { path: "/tmp/photo.png", contentType: "image/png" },
        { url: "https://example.test/remote.mp3", contentType: "audio/mpeg" },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ path: "/tmp/voice.ogg", durationMs: 1500 }),
      expect.objectContaining({
        path: "/tmp/clip.mp4",
        durationMs: 2500,
        width: 1280,
        height: 720,
      }),
      expect.objectContaining({ path: "/tmp/photo.png" }),
      expect.objectContaining({ url: "https://example.test/remote.mp3" }),
    ]);
    expect(probeMediaFilesWithinBudget).toHaveBeenCalledWith(
      [
        { filePath: path.resolve("/tmp/voice.ogg"), kind: "audio" },
        { filePath: path.resolve("/tmp/clip.mp4"), kind: "video" },
      ],
      { budgetMs: 3000, concurrency: 2, maxProbes: 8 },
    );
  });

  it("formats placeholders by kind precedence and attachment cardinality", () => {
    const cases: Array<[ChannelInboundMediaInput[], string]> = [
      [
        [{ kind: "document", contentType: "image/png", path: "/tmp/photo.jpg" }],
        "<media:document>",
      ],
      [[{ contentType: " IMAGE/PNG; charset=binary " }], "<media:image>"],
      [[{ url: "https://example.test/uploads/clip.MP4?download=1" }], "<media:video>"],
      [[{ kind: "image" }, { contentType: "image/jpeg" }], "<media:image> (2 images)"],
      [[{ kind: "image" }, { path: "/tmp/voice-note.mp3" }], "<media:document> (2 files)"],
      [[{ kind: "image" }, {}], "<media:attachment> (2 attachments)"],
      [[{ kind: "sticker" }], "<media:sticker>"],
      [[{ kind: "sticker" }, { kind: "sticker" }], "<media:sticker> (2 stickers)"],
      [[{}, {}, {}], "<media:attachment> (3 attachments)"],
      [[], ""],
    ];
    for (const [media, expected] of cases) {
      expect(formatMediaPlaceholderText(media), JSON.stringify(media)).toBe(expected);
    }
  });

  it("returns unavailable notices alone or appended to real captions", () => {
    expect(
      formatInboundMediaUnavailableText({
        body: "",
        notice: "[test image attachment unavailable]",
      }),
    ).toBe("[test image attachment unavailable]");
    expect(
      formatInboundMediaUnavailableText({
        body: "please inspect this",
        notice: "[test image attachment unavailable]",
      }),
    ).toBe("please inspect this\n\n[test image attachment unavailable]");
  });

  it("normalizes provider media into inbound media facts", () => {
    const input = [
      {
        path: " /tmp/image.png ",
        contentType: " image/png ",
        fileName: " original image.png ",
        messageId: " ",
      },
      {
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio" as const,
      },
    ];
    const defaults = {
      kind: "image" as const,
      messageId: "msg-1",
      transcribed: (_media: ChannelInboundMediaInput, index: number): boolean => index === 1,
    };
    const expected = [
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        fileName: "original image.png",
        transcribed: false,
        messageId: "msg-1",
      },
      {
        path: undefined,
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio",
        transcribed: true,
        messageId: "msg-1",
      },
    ];
    expect(toInboundMediaFacts(input, defaults)).toEqual(expected);
  });

  it("does not smear a singular legacy MediaUrl onto later slots after plural paths", () => {
    const facts = resolveMediaFacts({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["file:///tmp/a.png"],
      MediaUrl: "file:///tmp/a.png",
    });
    expect(facts).toHaveLength(2);
    expect(facts[0]?.path).toBe("/tmp/a.png");
    expect(facts[0]?.url).toBe("file:///tmp/a.png");
    expect(facts[1]?.path).toBe("/tmp/b.png");
    expect(facts[1]?.url).toBeUndefined();
  });

  it("keeps canonical facts ahead of conflicting legacy fields and preserves sparse alignment", () => {
    const facts = resolveMediaFacts({
      media: [
        {
          path: "/canonical/voice.ogg",
          url: "https://canonical.test/voice.ogg",
          contentType: "audio/ogg",
          kind: "video",
          workspaceDir: "/canonical/workspace",
        },
        { path: "/canonical/photo.jpg" },
      ],
      MediaPaths: ["/legacy/voice.ogg"],
      MediaUrls: ["/legacy/voice.ogg", "https://legacy.test/photo.jpg"],
      MediaTypes: ["image/png", "image/jpeg", "application/pdf"],
      MediaType: "video/mp4",
      MediaWorkspaceDir: "/legacy/workspace",
      MediaStaged: true,
    });

    expect(facts).toEqual([
      expect.objectContaining({
        path: "/canonical/voice.ogg",
        url: "https://canonical.test/voice.ogg",
        contentType: "audio/ogg",
        kind: "video",
        workspaceDir: "/canonical/workspace",
      }),
      expect.objectContaining({
        path: "/canonical/photo.jpg",
        url: "https://legacy.test/photo.jpg",
        contentType: "image/jpeg",
        kind: "image",
        workspaceDir: "/legacy/workspace",
      }),
      expect.objectContaining({
        path: undefined,
        url: undefined,
        contentType: "application/pdf",
        kind: "document",
        workspaceDir: "/legacy/workspace",
      }),
    ]);
    expect(facts.every((fact) => fact.staged === undefined)).toBe(true);
    expect(hasStagedMediaFacts(facts)).toBe(true);
  });

  it.each(stagedMediaMergeMatrix)("merges $name", ({ source, expected, expectedStaged }) => {
    const facts = resolveStagedMediaFacts(source);
    expect(facts).toHaveLength(expected.length);
    for (const [index, expectedFact] of expected.entries()) {
      expect(facts[index]).toMatchObject(expectedFact);
    }
    expect(hasStagedMediaFacts(facts)).toBe(expectedStaged);
  });

  it("requires every stageable fact to carry staging proof before skipping staging", () => {
    expect(hasStagedMediaFacts([])).toBe(false);
    expect(
      hasStagedMediaFacts([
        { path: "media/inbound/staged.png", workspaceDir: "/tmp/workspace" },
        { path: "/tmp/unstaged.png" },
        { kind: "document" },
      ]),
    ).toBe(false);
    expect(
      hasStagedMediaFacts([
        { path: "media/inbound/one.png", workspaceDir: "/tmp/workspace" },
        { path: "media/inbound/two.png", workspaceDir: "/tmp/workspace" },
        { kind: "document" },
      ]),
    ).toBe(true);
  });

  it("builds legacy media payload fields from inbound media facts", () => {
    const media = [
      { path: "/tmp/image.png", contentType: "image/png", kind: "image" as const },
      {
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio" as const,
        transcribed: true,
      },
    ];
    const expected = {
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", ""],
      MediaUrls: ["/tmp/image.png", "https://example.test/audio.mp3"],
      MediaTypes: ["image/png", "audio/mpeg"],
      MediaTranscribedIndexes: [1],
    };
    expect(buildChannelInboundMediaPayload(media)).toEqual(expected);
  });

  it.each([
    {
      name: "partial MIME types",
      media: [{ path: "/tmp/image.png", contentType: "image/png" }, { path: "/tmp/file.bin" }],
      compact: {
        MediaPath: "/tmp/image.png",
        MediaUrl: "/tmp/image.png",
        MediaType: "image/png",
        MediaPaths: ["/tmp/image.png", "/tmp/file.bin"],
        MediaUrls: ["/tmp/image.png", "/tmp/file.bin"],
        MediaTypes: ["image/png"],
      },
      alignedTypes: ["image/png", ""],
    },
    {
      name: "richer facts without MIME types",
      media: [
        { path: "/tmp/voice-note.ogg", url: "https://example.test/voice-note.ogg", kind: "audio" },
      ],
      compact: {
        MediaPath: "/tmp/voice-note.ogg",
        MediaUrl: "/tmp/voice-note.ogg",
        MediaType: undefined,
        MediaPaths: ["/tmp/voice-note.ogg"],
        MediaUrls: ["/tmp/voice-note.ogg"],
        MediaTypes: undefined,
      },
      alignedTypes: [""],
    },
  ])(
    "preserves compact and aligned adapter projections for $name",
    ({ media, compact, alignedTypes }) => {
      expect(buildAgentMediaPayload(media)).toEqual(compact);
      expect(buildMediaPayload(media)).toEqual(compact);
      expect(buildMediaPayload(media, { preserveMediaTypeCardinality: true })).toEqual({
        ...compact,
        MediaTypes: alignedTypes,
      });
    },
  );

  it("maps inbound media facts into history media entries", () => {
    expect(
      toHistoryMediaEntries([{ path: "/tmp/image.png", contentType: "image/png" }], {
        kind: "image",
        messageId: "msg-1",
      }),
    ).toEqual([
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        messageId: "msg-1",
      },
    ]);
  });
});
