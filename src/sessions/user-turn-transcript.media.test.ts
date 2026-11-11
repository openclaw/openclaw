import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLateMediaAttachedProjection,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
} from "./user-turn-transcript.js";
import type {
  PersistedUserTurnMediaInput,
  PersistedUserTurnMessage,
} from "./user-turn-transcript.types.js";

const userMessage = { role: "user" as const, content: "", timestamp: 123 };
const sparsePath = "/media/sparse.png";
const videoMetadata = { durationMs: 12_346, width: 1280, height: 720 };
const workspaceMedia = {
  url: "https://example.test/original.png",
  contentType: "image/png",
  workspaceDir: "/tmp/workspace",
};
type MediaFields = Partial<PersistedUserTurnMessage> & { MediaPath?: string; MediaType?: string };

describe("buildPersistedUserTurnMediaInputsFromFields", () => {
  it("builds media inputs from canonical persisted facts", () => {
    const media = [
      { path: "/tmp/a.png", contentType: "image/png" },
      { url: "https://example.test/b.jpg", contentType: "image/jpeg" },
    ];
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        ...userMessage,
        __openclaw: { media: structuredClone(media) },
      }),
    ).toEqual(media.map((fact) => Object.assign({}, fact, { kind: "image" })));
  });

  it("does not consult legacy top-level fields after the versioned cutover", () => {
    expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({} as never)).toEqual([]);
  });
});

it.each<[string, MediaFields, string | undefined, number]>([
  ["legacy-only", { MediaPath: "/media/legacy.png", MediaType: "image/png" }, undefined, 0],
  ["sparse", { __openclaw: { media: [{}, { path: sparsePath }] } }, sparsePath, 1],
])("reconstructs %s rows from canonical facts first", (_name, fields, expectedPath, index) => {
  const message: PersistedUserTurnMessage = {
    ...userMessage,
    ...fields,
    __openclaw: { ...fields["__openclaw"], lateMedia: true },
  };
  const projection = buildLateMediaAttachedProjection(message);
  expect(projection.media[index]?.path).toBe(expectedPath);
  expect(projection.text).toBe(expectedPath ? `[media attached: ${expectedPath}]` : undefined);
});

it.each<[string, PersistedUserTurnMediaInput | undefined, unknown?]>([
  ["zero attachments", undefined, undefined],
  ["bare kind", { kind: "image" }, { kind: "image" }],
  [
    "provider MIME-like kind",
    { path: " /tmp/provider.bin ", kind: " provider/custom-media " },
    { path: "/tmp/provider.bin", contentType: "provider/custom-media" },
  ],
  [
    "transcribed attachment",
    { path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true },
  ],
  ["probed video metadata", { path: "/tmp/clip.mp4", contentType: "video/mp4", ...videoMetadata }],
  [
    "workspace-relative attachment",
    { path: "media/inbound/a.png", ...workspaceMedia },
    {
      path: path.join("/tmp/workspace", "media/inbound/a.png"),
      ...workspaceMedia,
    },
  ],
  [
    "hydration-suppressed attachment",
    { path: "/tmp/described.png", contentType: "image/png", hydrationSuppressed: true },
  ],
])(
  "persists %s as canonical facts without legacy fields",
  (_name, media, expectedMedia = media) => {
    const message = buildPersistedUserTurnMessage({
      text: "inspect",
      timestamp: 123,
      media: media && [media],
    });
    expect(message).toMatchObject({ role: "user", content: "inspect", timestamp: 123 });
    expect(message).not.toHaveProperty("MediaPath");
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaType");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]?.media).toEqual(expectedMedia && [expectedMedia]);
  },
);
