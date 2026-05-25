import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendInlineUserTurnTranscriptMessage,
  appendUserTurnTranscriptMessage,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMediaFields,
  buildPersistedUserTurnMessage,
  persistUserTurnTranscript,
  resolvePersistedUserTurnText,
  tryPersistInlineUserTurnTranscript,
} from "./user-turn-transcript.js";

describe("user turn transcript persistence", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function readTranscriptMessages(transcriptPath: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { message?: unknown })
      .map((entry) => entry.message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null,
      );
  }

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

  describe("resolvePersistedUserTurnText", () => {
    it("prefers clean inbound text over model prompt text", () => {
      expect(
        resolvePersistedUserTurnText(
          {
            RawBody: "What is in this image?",
            BodyStripped:
              "[media attached: media://inbound/a.png]\nTo send an image back, prefer the message tool.\nWhat is in this image?",
          },
          { hasMedia: true },
        ),
      ).toBe("What is in this image?");
    });

    it("uses audio transcript before media placeholders", () => {
      expect(
        resolvePersistedUserTurnText(
          {
            Transcript: "please check this voice note",
            RawBody: "<media:audio>",
            CommandBody: "<media:audio>",
          },
          { hasMedia: true },
        ),
      ).toBe("please check this voice note");
    });

    it("ignores exact generated media placeholders only when structured media is present", () => {
      expect(
        resolvePersistedUserTurnText(
          {
            RawBody: "<media:image> (2 images)",
            BodyStripped: "<media:image> (2 images)",
          },
          { hasMedia: true, fallback: "fallback" },
        ),
      ).toBe("fallback");
      expect(
        resolvePersistedUserTurnText(
          {
            RawBody: "<media:image> (2 images)",
          },
          { hasMedia: false },
        ),
      ).toBe("<media:image> (2 images)");
    });
  });

  describe("appendUserTurnTranscriptMessage", () => {
    it("appends a structured user turn through the shared transcript writer", async () => {
      const dir = createTempDir("openclaw-user-turn-append-");
      const transcriptPath = path.join(dir, "session.jsonl");

      const appended = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "What is in this image?",
          media: [{ path: "/tmp/image.png", contentType: "image/png" }],
          timestamp: 123,
        },
        updateMode: "none",
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "What is in this image?",
        MediaPath: "/tmp/image.png",
      });
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "What is in this image?",
          MediaPath: "/tmp/image.png",
          MediaType: "image/png",
        }),
      ]);
    });

    it("uses inline update mode through the convenience wrapper", async () => {
      const dir = createTempDir("openclaw-user-turn-append-inline-");
      const transcriptPath = path.join(dir, "session.jsonl");

      const appended = await appendInlineUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "hello from runtime",
          timestamp: 123,
        },
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "hello from runtime",
      });
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from runtime",
        }),
      ]);
    });

    it("returns the existing user turn when the idempotency key was already persisted", async () => {
      const dir = createTempDir("openclaw-user-turn-append-idempotent-");
      const transcriptPath = path.join(dir, "session.jsonl");

      const first = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "hello once",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        },
        updateMode: "none",
      });
      const second = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "hello once replayed",
          timestamp: 456,
          idempotencyKey: "chat-run-1:user",
        },
        updateMode: "none",
      });

      expect(second?.messageId).toBe(first?.messageId);
      expect(second?.message).toMatchObject({
        role: "user",
        content: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      });
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello once",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        }),
      ]);
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("resolves the session file and persists the user turn", async () => {
      const dir = createTempDir("openclaw-user-turn-persist-");
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionStore = {
        main: {
          sessionId: "session-1",
          sessionFile: transcriptPath,
          updatedAt: 1,
        },
      };

      const persisted = await persistUserTurnTranscript({
        sessionId: "session-1",
        sessionKey: "main",
        sessionEntry: sessionStore.main,
        sessionStore,
        storePath: path.join(dir, "sessions.json"),
        agentId: "agent",
        cwd: dir,
        input: {
          text: "hello",
          timestamp: 123,
        },
        updateMode: "none",
      });

      expect(persisted?.sessionFile).toContain("session-1.jsonl");
      expect(readTranscriptMessages(persisted?.sessionFile ?? "")).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello",
        }),
      ]);
    });
  });

  describe("tryPersistInlineUserTurnTranscript", () => {
    it("persists clean text turns with inline transcript update policy", async () => {
      const dir = createTempDir("openclaw-user-turn-inline-");
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionStore = {
        main: {
          sessionId: "session-1",
          sessionFile: transcriptPath,
          updatedAt: 1,
        },
      };

      const persisted = await tryPersistInlineUserTurnTranscript({
        sessionId: "session-1",
        sessionKey: "main",
        sessionEntry: sessionStore.main,
        sessionStore,
        storePath: path.join(dir, "sessions.json"),
        agentId: "agent",
        cwd: dir,
        text: "display prompt",
        timestamp: 123,
      });

      expect(persisted?.message).toMatchObject({
        role: "user",
        content: "display prompt",
        timestamp: 123,
      });
      expect(readTranscriptMessages(persisted?.sessionFile ?? "")).toEqual([
        expect.objectContaining({
          role: "user",
          content: "display prompt",
          timestamp: 123,
        }),
      ]);
    });
  });
});
