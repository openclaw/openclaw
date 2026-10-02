// User-turn media persistence tests cover canonical fact normalization.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import {
  buildLateMediaAttachedProjection,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
} from "./user-turn-transcript.js";

describe("buildPersistedUserTurnMediaInputsFromFields", () => {
  it("builds media inputs from canonical persisted facts", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        __openclaw: {
          media: [
            { path: "/tmp/a.png", contentType: "image/png" },
            { url: "https://example.test/b.jpg", contentType: "image/jpeg" },
          ],
        },
      } as never),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png", kind: "image" },
      { url: "https://example.test/b.jpg", contentType: "image/jpeg", kind: "image" },
    ]);
  });

  it("resolves relative canonical paths against each fact workspace", () => {
    const workspaceDir = "/tmp/openclaw-user-turn-workspace";
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        __openclaw: {
          media: [{ path: "media/inbound/a.png", contentType: "image/png", workspaceDir }],
        },
      } as never),
    ).toEqual([
      {
        path: path.join(workspaceDir, "media/inbound/a.png"),
        contentType: "image/png",
        kind: "image",
      },
    ]);
  });

  it("does not consult legacy top-level fields after the versioned cutover", () => {
    expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({} as never)).toEqual([]);
  });
});

describe("buildLateMediaAttachedProjection canonical persistence", () => {
  it.each([
    {
      name: "legacy-only",
      message: { MediaPath: "/media/legacy.png", MediaType: "image/png" },
      expectedPath: undefined,
    },
    {
      name: "both-conflict",
      message: {
        MediaPath: "/media/legacy-conflict.png",
        __openclaw: { media: [{ path: "/media/canonical.png" }] },
      },
      expectedPath: "/media/canonical.png",
    },
    {
      name: "sparse",
      message: { __openclaw: { media: [{}, { path: "/media/sparse.png" }] } },
      expectedPath: "/media/sparse.png",
      expectedIndex: 1,
    },
    {
      name: "type-only",
      message: { __openclaw: { media: [{ contentType: "image/png" }] } },
      expectedPath: undefined,
    },
  ])("reconstructs $name rows from canonical facts first", (testCase) => {
    const metadata = (testCase.message as { __openclaw?: Record<string, unknown> })["__openclaw"];
    const projection = buildLateMediaAttachedProjection({
      role: "user",
      content: "",
      ...testCase.message,
      __openclaw: { ...metadata, lateMedia: true },
    } as never);
    const expectedIndex = "expectedIndex" in testCase ? (testCase.expectedIndex ?? 0) : 0;

    expect(projection.media[expectedIndex]?.path).toBe(testCase.expectedPath);
    expect(projection.text).toBe(
      testCase.expectedPath ? `[media attached: ${testCase.expectedPath}]` : undefined,
    );
  });
});

describe("buildPersistedUserTurnMessage media projection", () => {
  it.each([
    {
      name: "zero attachments",
      media: undefined,
      expectedMedia: undefined,
    },
    {
      name: "many attachments",
      media: [
        { path: " /tmp/a.png ", contentType: " image/png " },
        { url: " https://example.test/report.pdf ", contentType: " application/pdf " },
      ],
      expectedMedia: [
        { path: "/tmp/a.png", contentType: "image/png" },
        { url: "https://example.test/report.pdf", contentType: "application/pdf" },
      ],
    },
    {
      name: "sparse aligned attachments",
      media: [{}, { path: "/tmp/b.png", contentType: "image/png" }],
      expectedMedia: [{}, { path: "/tmp/b.png", contentType: "image/png" }],
    },
    {
      name: "path-only attachment",
      media: [{ path: "/tmp/inferred.png" }],
      expectedMedia: [{ path: "/tmp/inferred.png", contentType: "image/png" }],
    },
    {
      name: "explicit MIME",
      media: [{ path: "/tmp/blob.bin", contentType: "application/x-openclaw" }],
      expectedMedia: [{ path: "/tmp/blob.bin", contentType: "application/x-openclaw" }],
    },
    {
      name: "bare kind",
      media: [{ kind: "image" }],
      expectedMedia: [{ kind: "image" }],
    },
    {
      name: "provider MIME-like kind",
      media: [{ path: " /tmp/provider.bin ", kind: " provider/custom-media " }],
      expectedMedia: [{ path: "/tmp/provider.bin", contentType: "provider/custom-media" }],
    },
    {
      name: "unknown non-MIME kind",
      media: [{ path: "/tmp/photo.jpg", kind: "thumbnail" }],
      expectedMedia: [{ path: "/tmp/photo.jpg", contentType: "image/jpeg" }],
    },
    {
      name: "transcribed attachment",
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true }],
      expectedMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true }],
    },
    {
      name: "probed video metadata",
      media: [
        {
          path: "/tmp/clip.mp4",
          contentType: "video/mp4",
          durationMs: 12_346,
          width: 1280,
          height: 720,
        },
      ],
      expectedMedia: [
        {
          path: "/tmp/clip.mp4",
          contentType: "video/mp4",
          durationMs: 12_346,
          width: 1280,
          height: 720,
        },
      ],
    },
    {
      name: "workspace-relative attachment",
      media: [
        {
          path: "media/inbound/a.png",
          url: "https://example.test/original.png",
          contentType: "image/png",
          workspaceDir: "/tmp/workspace",
        },
      ],
      expectedMedia: [
        {
          path: path.join("/tmp/workspace", "media/inbound/a.png"),
          url: "https://example.test/original.png",
          contentType: "image/png",
          workspaceDir: "/tmp/workspace",
        },
      ],
    },
    {
      name: "unanchored relative attachment",
      media: [{ path: "media/inbound/unanchored.png", contentType: "image/png" }],
      expectedMedia: [{ path: "media/inbound/unanchored.png", contentType: "image/png" }],
    },
    {
      name: "hydration-suppressed attachment",
      media: [
        {
          path: "/tmp/described.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
      ],
      expectedMedia: [
        {
          path: "/tmp/described.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
      ],
    },
  ])("persists $name as canonical facts without legacy fields", ({ media, expectedMedia }) => {
    const message = buildPersistedUserTurnMessage({ text: "inspect", timestamp: 123, media });
    expect(message).toMatchObject({ role: "user", content: "inspect", timestamp: 123 });
    expect(message).not.toHaveProperty("MediaPath");
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaType");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(
      (message as unknown as { __openclaw?: { media?: unknown } })["__openclaw"]?.media,
    ).toEqual(expectedMedia);
  });

  it("reads canonical persisted facts without merging disagreeing legacy fields", () => {
    const message = {
      MediaPath: "/legacy.png",
      MediaType: "image/png",
      __openclaw: {
        media: [
          {
            path: "/canonical.ogg",
            contentType: "audio/ogg",
            transcribed: true,
            messageId: "media-1",
          },
        ],
      },
    };

    expect(readPersistedMediaFacts(message)).toEqual([
      expect.objectContaining({
        path: "/canonical.ogg",
        contentType: "audio/ogg",
        kind: "audio",
        transcribed: true,
        messageId: "media-1",
      }),
    ]);
  });
});
