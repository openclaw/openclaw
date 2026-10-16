import { describe, expect, test } from "vitest";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;

const pendingMediaReply = {
  role: "assistant",
  content: [{ type: "text", text: "Artifacts ready\nMEDIA:./proof.png" }],
  openclawDelivery: { mediaUrls: ["./proof.png"] },
};
const managedMediaReply = {
  ...pendingMediaReply,
  openclawDisplayContent: [
    { type: "text", text: "Artifacts ready" },
    { type: "image", url: "/api/chat/media/outgoing/proof.png", mimeType: "image/png" },
  ],
};

describe("projectSessionDisplayMessage", () => {
  test("keeps visible user and assistant text while excluding non-display rows", () => {
    const messages = [
      { role: "user", content: "Initial request" },
      { role: "assistant", content: "Visible final answer" },
      managedMediaReply,
      { ...managedMediaReply, role: "ASSISTANT" },
      pendingMediaReply,
      {
        ...pendingMediaReply,
        content: [{ type: "text", text: "MEDIA:./proof.png" }],
      },
      {
        ...pendingMediaReply,
        content:
          "Artifacts ready\nMEDIA:./proof.png\nUse `MEDIA:./proof.png` literally.\nMEDIA:./hook-added.png",
      },
      { ...pendingMediaReply, content: "    MEDIA:./proof.png" },
      { ...pendingMediaReply, content: "```\nMEDIA:./proof.png\n```" },
      {
        role: "assistant",
        content: [{ type: "text", text: "MEDIA:./proof.png" }],
        openclawDisplayContent: [
          { type: "image", url: "/api/chat/media/outgoing/proof.png", mimeType: "image/png" },
        ],
      },
      {
        role: "user",
        content: "Use MEDIA:./proof.png literally.",
        openclawDisplayContent: [{ type: "text", text: "Must not replace user text" }],
      },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      { role: "system", content: "system event" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private thought" },
          { type: "reasoning", text: "reasoning summary" },
        ],
      },
      { role: "assistant", content: "NO_REPLY" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        openclawDelivery: { replyToCurrent: true },
      },
    ];

    expect(messages.map((message) => projectSessionDisplayMessage(message))).toEqual([
      { role: "user", text: "Initial request" },
      { role: "assistant", text: "Visible final answer" },
      { role: "assistant", text: "Artifacts ready" },
      { role: "assistant", text: "Artifacts ready" },
      { role: "assistant", text: "Artifacts ready" },
      null,
      {
        role: "assistant",
        text: "Artifacts ready\nUse `MEDIA:./proof.png` literally.\nMEDIA:./hook-added.png",
      },
      { role: "assistant", text: "MEDIA:./proof.png" },
      { role: "assistant", text: "```\nMEDIA:./proof.png\n```" },
      null,
      { role: "user", text: "Use MEDIA:./proof.png literally." },
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(pendingMediaReply.openclawDelivery).toEqual({ mediaUrls: ["./proof.png"] });
  });

  test.each([
    ["NO_REPLY.", "NO_REPLY."],
    ['"NO_REPLY"', '"NO_REPLY"'],
    ['{"action":"NO_REPLY"}', '{"action":"NO_REPLY"}'],
    ["no_reply", "no_reply"],
    ["Done\nNO_REPLY", "Done"],
    ["NO_REPLY\nREADY", "READY"],
    ["NO_REPLY\nNO_REPLY", "NO_REPLY"],
    ["NO_REPLY\nNO_REPLY\nREADY", "NO_REPLY\nREADY"],
    [" NO_REPLY\nREADY", "NO_REPLY\nREADY"],
    ["NO_REPLY\r\nREADY", "NO_REPLY\r\nREADY"],
  ])("prepares raw assistant text once: %s", (content, text) => {
    expect(projectSessionDisplayMessage({ role: "assistant", content })).toEqual({
      role: "assistant",
      text,
    });
  });

  test("preserves user text and explicit visible or final source replies", () => {
    for (const message of [
      { role: "user", content: "NO_REPLY" },
      { role: "assistant", content: "NO_REPLY", display: true },
      {
        role: "assistant",
        content: "NO_REPLY",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId: "source-run",
        },
      },
    ]) {
      expect(projectSessionDisplayMessage(message)).toEqual({
        role: message.role,
        text: "NO_REPLY",
      });
    }
  });

  test("bounds previews without splitting surrogate pairs", () => {
    const longReply = `${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 2)}😊tail`;
    const preview = projectSessionDisplayMessage({ role: "assistant", content: longReply });

    expect(preview?.text).toHaveLength(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS);
    expect(preview?.text).toBe(`${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 3)}...`);
  });

  test.each([
    ["pending", pendingMediaReply],
    ["rewritten", managedMediaReply],
  ])("keeps authored assistant media text in %s model-context previews", (_state, message) => {
    expect(projectSessionDisplayMessage(message, { view: "model-context" })).toEqual({
      role: "assistant",
      text: "Artifacts ready\nMEDIA:./proof.png",
    });
  });

  test("honors explicit preview budgets up to the shared cap", () => {
    const maxChars = 800;
    const message = { role: "assistant", content: "a".repeat(maxChars + 20) };
    const preview = projectSessionDisplayMessage(message, { maxChars });

    expect(preview?.text).toHaveLength(maxChars);
    expect(preview?.text).toBe(`${"a".repeat(maxChars - 3)}...`);
    expect(projectSessionDisplayMessage(message, { maxChars: Number.MAX_SAFE_INTEGER })?.text).toBe(
      `${"a".repeat(maxChars - 3)}...`,
    );
  });

  test.each([
    ["nested label brackets", "[Report [Q3]](LONG)", "Read the Report [Q3] and then deploy."],
    [
      "balanced destination parentheses",
      "[report](LONG/report_(Q3))",
      "Read the report and then deploy.",
    ],
    [
      "escaped destination parentheses",
      "[report](LONG/report\\)Q3)",
      "Read the report and then deploy.",
    ],
  ])("flattens links with %s before bounding a preview", (_label, link, expected) => {
    const longUrl = `https://example.com/${"x".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS)}`;
    const preview = projectSessionDisplayMessage(
      { role: "assistant", content: `Read the ${link.replace("LONG", longUrl)} and then deploy.` },
      { flattenMarkdown: true },
    );

    expect(preview?.text).toBe(expected);
  });
});
