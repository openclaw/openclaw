import { describe, expect, it } from "vitest";
import { buildInboundMediaNote } from "./media-note.js";

describe("buildInboundMediaNote", () => {
  it("formats single MediaPath as a media note", () => {
    const note = buildInboundMediaNote({
      MediaPath: "/tmp/a.png",
      MediaType: "image/png",
      MediaUrl: "/tmp/a.png",
    });
    expect(note).toBe("[media attached: /tmp/a.png (image/png) | /tmp/a.png]");
  });

  it("formats multiple MediaPaths as numbered media notes", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
      MediaUrls: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
    });
    expect(note).toBe(
      [
        "[media attached: 3 files]",
        "[media attached 1/3: /tmp/a.png | /tmp/a.png]",
        "[media attached 2/3: /tmp/b.png | /tmp/b.png]",
        "[media attached 3/3: /tmp/c.png | /tmp/c.png]",
      ].join("\n"),
    );
  });

  it("skips media notes for attachments with understanding output", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      MediaUnderstanding: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "hello",
          provider: "groq",
        },
      ],
    });
    expect(note).toBe("[media attached: /tmp/b.png | https://example.com/b.png]");
  });

  it("only suppresses attachments when media understanding succeeded", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      MediaUnderstandingDecisions: [
        {
          capability: "image",
          outcome: "skipped",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "maxBytes: too large",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(note).toBe(
      [
        "[media attached: 2 files]",
        "[media attached 1/2: /tmp/a.png | https://example.com/a.png]",
        "[media attached 2/2: /tmp/b.png | https://example.com/b.png]",
      ].join("\n"),
    );
  });

  it("suppresses attachments when media understanding succeeds via decisions", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      MediaUnderstandingDecisions: [
        {
          capability: "image",
          outcome: "success",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "success",
                  provider: "openai",
                  model: "gpt-5.2",
                },
              ],
              chosen: {
                type: "provider",
                outcome: "success",
                provider: "openai",
                model: "gpt-5.2",
              },
            },
          ],
        },
      ],
    });
    expect(note).toBe("[media attached: /tmp/b.png | https://example.com/b.png]");
  });
});
