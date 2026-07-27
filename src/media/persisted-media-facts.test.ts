import { describe, expect, it } from "vitest";
import {
  isMeaningfulMediaFact,
  normalizeMediaFacts,
  readPersistedMediaFacts,
  type MediaFactInput,
} from "./persisted-media-facts.js";

describe("browser-safe persisted media facts", () => {
  it("normalizes serialized sparse nulls without losing attachment positions", () => {
    expect(
      readPersistedMediaFacts({
        __openclaw: {
          media: [null, { path: "/media/image.png", contentType: "image/png" }],
        },
      }),
    ).toEqual([
      {
        path: undefined,
        url: undefined,
        contentType: undefined,
        kind: undefined,
        transcribed: false,
        messageId: undefined,
      },
      {
        path: "/media/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        transcribed: false,
        messageId: undefined,
      },
    ]);
  });

  it("preserves defaults and index callbacks for serialized sparse attachment slots", () => {
    const media = JSON.parse('[null,{"url":"media://inbound/voice.ogg"}]') as MediaFactInput[];

    expect(
      normalizeMediaFacts(media, {
        kind: "audio",
        messageId: "message-1",
        workspaceDir: "/workspace",
        transcribed: (_fact, index) => index === 1,
      }),
    ).toEqual([
      {
        path: undefined,
        url: undefined,
        contentType: undefined,
        kind: "audio",
        transcribed: false,
        messageId: "message-1",
        workspaceDir: "/workspace",
      },
      {
        path: undefined,
        url: "media://inbound/voice.ogg",
        contentType: undefined,
        kind: "audio",
        transcribed: true,
        messageId: "message-1",
        workspaceDir: "/workspace",
      },
    ]);
  });

  it.each([false, true, 0, 42, "invalid", []])(
    "keeps a non-object persisted slot as an aligned empty fact: %j",
    (invalid) => {
      expect(
        readPersistedMediaFacts({
          __openclaw: {
            media: [invalid, { url: "media://inbound/voice.ogg", kind: "audio" }],
          },
        }),
      ).toEqual([
        {
          path: undefined,
          url: undefined,
          contentType: undefined,
          kind: undefined,
          transcribed: false,
          messageId: undefined,
        },
        {
          path: undefined,
          url: "media://inbound/voice.ogg",
          contentType: undefined,
          kind: "audio",
          transcribed: false,
          messageId: undefined,
        },
      ]);
    },
  );

  it.each([
    { contentType: " IMAGE/PNG ; charset=binary ", kind: "image" },
    { contentType: "image/apng", kind: "image" },
    { contentType: " AUDIO/OGG; codecs=opus ", kind: "audio" },
    { contentType: "application/pdf; charset=binary", kind: "document" },
    { contentType: "unknown/custom", kind: undefined },
  ])("classifies $contentType without changing its persisted value", ({ contentType, kind }) => {
    expect(normalizeMediaFacts([{ contentType }])).toEqual([
      {
        path: undefined,
        url: undefined,
        contentType: contentType.trim(),
        kind,
        transcribed: false,
        messageId: undefined,
      },
    ]);
  });

  it("preserves sparse positions, explicit kinds, staging, and hydration suppression", () => {
    expect(
      readPersistedMediaFacts({
        __openclaw: {
          media: [
            {},
            {
              path: " /media/image.png ",
              contentType: "image/png",
              kind: "sticker",
              staged: true,
              hydrationSuppressed: true,
            },
          ],
        },
      }),
    ).toEqual([
      {
        path: undefined,
        url: undefined,
        contentType: undefined,
        kind: undefined,
        transcribed: false,
        messageId: undefined,
      },
      {
        path: "/media/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "sticker",
        transcribed: false,
        messageId: undefined,
        staged: true,
        hydrationSuppressed: true,
      },
    ]);
  });

  it("applies caller defaults without compacting attachment positions", () => {
    expect(
      normalizeMediaFacts([{}, { url: " media://inbound/audio " }], {
        kind: "audio",
        messageId: "message-1",
        workspaceDir: "/workspace",
        transcribed: (_fact, index) => index === 1,
      }),
    ).toEqual([
      {
        path: undefined,
        url: undefined,
        contentType: undefined,
        kind: "audio",
        transcribed: false,
        messageId: "message-1",
        workspaceDir: "/workspace",
      },
      {
        path: undefined,
        url: "media://inbound/audio",
        contentType: undefined,
        kind: "audio",
        transcribed: true,
        messageId: "message-1",
        workspaceDir: "/workspace",
      },
    ]);
  });

  it("ignores retired top-level attachment carriers", () => {
    expect(
      readPersistedMediaFacts({
        media: [{ path: "/media/legacy.png", contentType: "image/png" }],
        MediaPath: "/media/other-legacy.png",
      }),
    ).toBeUndefined();
  });

  it("does not classify sparse placeholders or unknown kinds as attachments", () => {
    expect(isMeaningfulMediaFact({})).toBe(false);
    expect(isMeaningfulMediaFact({ kind: "unknown" })).toBe(false);
    expect(isMeaningfulMediaFact({ contentType: "image/png" })).toBe(true);
    expect(isMeaningfulMediaFact({ kind: "sticker" })).toBe(true);
  });
});
