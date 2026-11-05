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

type MergeMatrixSource = Parameters<typeof resolveStagedMediaFacts>[0];

function canonical(file: string, metadata: MediaFactInput): MediaFactInput {
  return { path: `/canonical/${file}`, messageId: file.split(".")[0], ...metadata };
}
const unstagedPhoto = canonical("photo.jpg", { kind: "image", contentType: "image/jpeg" });
const photo = { ...unstagedPhoto, url: "https://canonical.test/photo.jpg", transcribed: true };
const voice = canonical("voice.ogg", {
  kind: "audio",
  contentType: "audio/ogg",
  hydrationSuppressed: true,
});
const binary = "application/octet-stream";
const document = canonical("one.bin", { kind: "document", contentType: binary, transcribed: true });
const audio = canonical("two.bin", {
  kind: "audio",
  contentType: binary,
  hydrationSuppressed: true,
});

function stagedPair(first: string, second: string): MergeMatrixSource {
  return {
    MediaPaths: [`/staged/${first}`, `/staged/${second}`],
    MediaUrls: [`file:///staged/${first}`, `file:///staged/${second}`],
    MediaTypes: ["image/jpeg", "audio/ogg"],
    MediaWorkspaceDir: "/staged",
  };
}

function staged(file: string, contentType: string, metadata: Partial<MediaFactInput>) {
  return { path: `/staged/${file}`, contentType, workspaceDir: "/staged", ...metadata };
}

function compactProjection(paths: string[], types?: string[]): MediaFactLegacyProjection {
  return {
    MediaPath: paths[0],
    MediaUrl: paths[0],
    MediaType: types?.[0],
    MediaPaths: paths,
    MediaUrls: paths,
    MediaTypes: types,
  };
}

const stagedMediaMergeMatrix: Array<
  [string, MergeMatrixSource, Array<Partial<MediaFactInput>>, boolean]
> = [
  [
    "staged singular plus multi-canonical",
    { media: [{ ...photo }, { ...voice }], MediaPath: "/staged/photo.jpg", MediaStaged: true },
    [{ ...photo, path: "/staged/photo.jpg", staged: true }, voice],
    false,
  ],
  [
    "staged aligned arrays plus canonical metadata",
    { media: [{ ...document }, { ...audio }], ...stagedPair("one.jpg", "two.ogg") },
    [
      { ...document, ...staged("one.jpg", "image/jpeg", { url: "file:///staged/one.jpg" }) },
      { ...audio, ...staged("two.ogg", "audio/ogg", { url: "file:///staged/two.ogg" }) },
    ],
    true,
  ],
  [
    "staged-only",
    { ...stagedPair("photo.jpg", "voice.ogg"), MediaTranscribedIndexes: [1] },
    [
      staged("photo.jpg", "image/jpeg", { kind: "image", transcribed: false }),
      staged("voice.ogg", "audio/ogg", { kind: "audio", transcribed: true }),
    ],
    true,
  ],
  [
    "canonical-only with an empty staged projection",
    { media: [{ ...unstagedPhoto, hydrationSuppressed: true }], MediaStaged: true },
    [{ ...unstagedPhoto, hydrationSuppressed: true, staged: true }],
    true,
  ],
  [
    "canonical path with staged URL metadata only",
    { media: [{ ...unstagedPhoto }], MediaUrl: "file:///canonical/photo.jpg", MediaStaged: true },
    [{ ...unstagedPhoto, url: "file:///canonical/photo.jpg", staged: true }],
    true,
  ],
];

describe("channel inbound media facts", () => {
  it("probes local audio and video facts without probing images or URL-only media", async () => {
    const videoMetadata = { durationMs: 2500, width: 1280, height: 720 };
    probeMediaFilesWithinBudget.mockResolvedValueOnce([{ durationMs: 1500 }, { ...videoMetadata }]);

    await expect(
      toInboundMediaFactsWithMetadata([
        { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
        { path: "/tmp/clip.mp4", kind: "video" },
        { path: "/tmp/photo.png", contentType: "image/png" },
        { url: "https://example.test/remote.mp3", contentType: "audio/mpeg" },
      ]),
    ).resolves.toMatchObject([
      { path: "/tmp/voice.ogg", durationMs: 1500 },
      { path: "/tmp/clip.mp4", ...videoMetadata },
      { path: "/tmp/photo.png" },
      { url: "https://example.test/remote.mp3" },
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
    const notice = "[test image attachment unavailable]";
    expect(formatInboundMediaUnavailableText({ body: "", notice })).toBe(notice);
    expect(formatInboundMediaUnavailableText({ body: "please inspect this", notice })).toBe(
      "please inspect this\n\n[test image attachment unavailable]",
    );
  });

  it("normalizes provider media into inbound media facts", () => {
    const url = "https://example.test/audio.mp3";
    const remoteAudio = { url, contentType: "audio/mpeg", kind: "audio" } as const;
    expect(
      toInboundMediaFacts(
        [
          {
            path: " /tmp/image.png ",
            contentType: " image/png ",
            fileName: " original image.png ",
            messageId: " ",
          },
          { ...remoteAudio },
        ],
        {
          kind: "image",
          messageId: "msg-1",
          transcribed: (_media, index) => index === 1,
        },
      ),
    ).toEqual([
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        fileName: "original image.png",
        transcribed: false,
        messageId: "msg-1",
      },
      { ...remoteAudio, path: undefined, transcribed: true, messageId: "msg-1" },
    ]);
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

  it.each(stagedMediaMergeMatrix)("merges %s", (_name, source, expected, expectedStaged) => {
    const facts = resolveStagedMediaFacts(source);
    expect(facts).toMatchObject(expected);
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
      compact: compactProjection(["/tmp/image.png", "/tmp/file.bin"], ["image/png"]),
      alignedTypes: ["image/png", ""],
    },
    {
      name: "richer facts without MIME types",
      media: [
        { path: "/tmp/voice-note.ogg", url: "https://example.test/voice-note.ogg", kind: "audio" },
      ],
      compact: compactProjection(["/tmp/voice-note.ogg"]),
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
