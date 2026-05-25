import { describe, expect, it } from "vitest";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMediaFields,
  buildPersistedUserTurnMessage,
} from "./user-turn-transcript.js";

describe("user turn transcript persistence", () => {
  describe("buildPersistedUserTurnMediaInputsFromFields", () => {
    it("builds media inputs from structured context media fields", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "/tmp/a.png",
          MediaPaths: ["/tmp/a.png", "/tmp/b.jpg"],
          MediaType: "image/png",
          MediaTypes: ["image/png", "image/jpeg"],
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg" },
      ]);
    });

    it("uses url-backed media fields when no local path is present", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaUrl: "media://inbound/a.png",
          MediaType: "image/png",
        }),
      ).toEqual([{ url: "media://inbound/a.png", contentType: "image/png" }]);
    });

    it("does not infer media from absent structured fields", () => {
      expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
      expect(buildPersistedUserTurnMediaInputsFromFields({})).toEqual([]);
    });
  });

  describe("buildPersistedUserTurnMediaFields", () => {
    it("omits media fields when there is no structured media", () => {
      expect(buildPersistedUserTurnMediaFields(undefined)).toEqual({});
      expect(buildPersistedUserTurnMediaFields([])).toEqual({});
      expect(buildPersistedUserTurnMediaFields([{ path: "  ", contentType: "image/png" }])).toEqual(
        {},
      );
    });

    it("builds aligned transcript media fields from structured media facts", () => {
      expect(
        buildPersistedUserTurnMediaFields([
          { path: "/tmp/a.png", contentType: "image/png" },
          { path: "/tmp/b.jpg", contentType: "image/jpeg" },
        ]),
      ).toEqual({
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "/tmp/b.jpg"],
        MediaType: "image/png",
        MediaTypes: ["image/png", "image/jpeg"],
      });
    });

    it("uses url-backed media when no local path is available", () => {
      expect(
        buildPersistedUserTurnMediaFields([
          { url: "media://inbound/photo.png", contentType: "image/png" },
        ]),
      ).toEqual({
        MediaPath: "media://inbound/photo.png",
        MediaPaths: ["media://inbound/photo.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      });
    });

    it("falls back to kind and then octet-stream for media types", () => {
      expect(
        buildPersistedUserTurnMediaFields([
          { path: "/tmp/doc", kind: "document" },
          { path: "/tmp/blob" },
        ]),
      ).toEqual({
        MediaPath: "/tmp/doc",
        MediaPaths: ["/tmp/doc", "/tmp/blob"],
        MediaType: "document",
        MediaTypes: ["document", "application/octet-stream"],
      });
    });

    it("keeps media paths and types aligned when incomplete entries are skipped", () => {
      expect(
        buildPersistedUserTurnMediaFields([
          { contentType: "image/png" },
          { path: "/tmp/b.jpg", contentType: "image/jpeg" },
        ]),
      ).toEqual({
        MediaPath: "/tmp/b.jpg",
        MediaPaths: ["/tmp/b.jpg"],
        MediaType: "image/jpeg",
        MediaTypes: ["image/jpeg"],
      });
    });
  });

  describe("buildPersistedUserTurnMessage", () => {
    it("builds a plain user transcript message for text-only turns", () => {
      expect(
        buildPersistedUserTurnMessage({
          text: "hello",
          timestamp: 123,
          idempotencyKey: "turn-1",
        }),
      ).toEqual({
        role: "user",
        content: "hello",
        timestamp: 123,
        idempotencyKey: "turn-1",
      });
    });

    it("adds structured media fields to the user transcript message", () => {
      expect(
        buildPersistedUserTurnMessage({
          text: "What is in this image?",
          media: [{ path: "/tmp/a.png", contentType: "image/png" }],
          timestamp: 123,
        }),
      ).toEqual({
        role: "user",
        content: "What is in this image?",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      });
    });

    it("does not infer media from marker-like user text", () => {
      expect(
        buildPersistedUserTurnMessage({
          text: "[media attached: media://inbound/photo.png]\nWhat is this?",
          timestamp: 123,
        }),
      ).toEqual({
        role: "user",
        content: "[media attached: media://inbound/photo.png]\nWhat is this?",
        timestamp: 123,
      });
    });

    it("uses an explicit media-only display text when provided", () => {
      expect(
        buildPersistedUserTurnMessage({
          text: "",
          mediaOnlyText: "[User sent media]",
          media: [{ path: "/tmp/a.png", contentType: "image/png" }],
        }),
      ).toEqual({
        role: "user",
        content: "[User sent media]",
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      });
    });

    it("keeps media-only transcript content empty by default", () => {
      expect(
        buildPersistedUserTurnMessage({
          media: [{ path: "/tmp/a.png", contentType: "image/png" }],
        }),
      ).toEqual({
        role: "user",
        content: "",
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      });
    });
  });
});
