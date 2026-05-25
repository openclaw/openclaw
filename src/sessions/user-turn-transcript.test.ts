import { describe, expect, it } from "vitest";
import { buildPersistedUserTurnMediaFields } from "./user-turn-transcript.js";

describe("user turn transcript persistence", () => {
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
  });
});
