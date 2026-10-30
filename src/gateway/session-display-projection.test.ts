import { describe, expect, test } from "vitest";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  ...extra,
});
const textBlock = (text: string) => [{ type: "text", text }];
const imageBlock = {
  type: "image",
  url: "/api/chat/media/outgoing/proof.png",
  mimeType: "image/png",
};
const visible = (text: string, role = "assistant") => ({ role, text });

const pendingMediaReply = {
  ...assistant(textBlock("Artifacts ready\nMEDIA:./proof.png")),
  openclawDelivery: { mediaUrls: ["./proof.png"] },
};
const managedMediaReply = {
  ...pendingMediaReply,
  openclawDisplayContent: [...textBlock("Artifacts ready"), imageBlock],
};
const pendingMedia = (content: unknown) => ({ ...pendingMediaReply, content });
const user = (content: string, extra: Record<string, unknown> = {}) => ({
  role: "user",
  content,
  ...extra,
});

describe("projectSessionDisplayMessage", () => {
  test("keeps visible user and assistant text while excluding non-display rows", () => {
    const cases = [
      [user("Initial request"), visible("Initial request", "user")],
      [assistant("Visible final answer"), visible("Visible final answer")],
      [managedMediaReply, visible("Artifacts ready")],
      [{ ...managedMediaReply, role: "ASSISTANT" }, visible("Artifacts ready")],
      [pendingMediaReply, visible("Artifacts ready")],
      [pendingMedia(textBlock("MEDIA:./proof.png")), null],
      [
        pendingMedia(
          "Artifacts ready\nMEDIA:./proof.png\nUse `MEDIA:./proof.png` literally.\nMEDIA:./hook-added.png",
        ),
        visible("Artifacts ready\nUse `MEDIA:./proof.png` literally.\nMEDIA:./hook-added.png"),
      ],
      [pendingMedia("    MEDIA:./proof.png"), visible("MEDIA:./proof.png")],
      [pendingMedia("```\nMEDIA:./proof.png\n```"), visible("```\nMEDIA:./proof.png\n```")],
      [assistant(textBlock("MEDIA:./proof.png"), { openclawDisplayContent: [imageBlock] }), null],
      [
        user("Use MEDIA:./proof.png literally.", {
          openclawDisplayContent: textBlock("Must not replace user text"),
        }),
        visible("Use MEDIA:./proof.png literally.", "user"),
      ],
      [{ role: "toolResult", content: textBlock("tool output") }, null],
      [{ role: "system", content: "system event" }, null],
      [
        assistant([
          { type: "thinking", thinking: "private thought" },
          { type: "reasoning", text: "reasoning summary" },
        ]),
        null,
      ],
      [assistant(textBlock(""), { openclawDelivery: { replyToCurrent: true } }), null],
    ] as const;
    expect(cases.map(([message]) => projectSessionDisplayMessage(message))).toEqual(
      cases.map(([, expected]) => expected),
    );
    expect(pendingMediaReply.openclawDelivery).toEqual({ mediaUrls: ["./proof.png"] });
  });

  test.each([
    ["NO_REPLY.", "NO_REPLY."],
    ['"NO_REPLY"', '"NO_REPLY"'],
    ['{"action":"NO_REPLY"}', '{"action":"NO_REPLY"}'],
    ["NO_REPLY\nNO_REPLY", "NO_REPLY"],
    ["NO_REPLY\nNO_REPLY\nREADY", "NO_REPLY\nREADY"],
    [" NO_REPLY\nREADY", "NO_REPLY\nREADY"],
    ["NO_REPLY\r\nREADY", "NO_REPLY\r\nREADY"],
  ])("prepares raw assistant text once: %s", (content, text) => {
    expect(projectSessionDisplayMessage(assistant(content))).toEqual(visible(text));
  });

  test("hides raw NO_REPLY assistant history", () => {
    expect(projectSessionDisplayMessage(assistant("NO_REPLY"))).toBeNull();
  });

  test("preserves user text and explicit visible or final source replies", () => {
    for (const message of [
      user("NO_REPLY"),
      assistant("NO_REPLY", { display: true }),
      assistant("NO_REPLY", {
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId: "source-run",
        },
      }),
    ]) {
      expect(projectSessionDisplayMessage(message)).toEqual(visible("NO_REPLY", message.role));
    }
  });

  test("omits heartbeat acknowledgements without hiding alerts, forwarded text, or model context", () => {
    for (const message of [
      assistant("HEARTBEAT_OK"),
      { role: "ASSISTANT", text: "**HEARTBEAT_OK**" },
      assistant([
        { type: "reasoning", text: "Checking the monitor" },
        { type: "text", text: "HEARTBEAT_OK" },
      ]),
    ]) {
      expect(projectSessionDisplayMessage(message)).toBeNull();
      expect(projectSessionDisplayMessage(message, { view: "model-context" })?.text).toContain(
        "HEARTBEAT_OK",
      );
    }
    for (const text of ["Disk usage crossed 95 percent.", "no_r"]) {
      expect(projectSessionDisplayMessage(assistant(text))?.text).toBe(text);
    }
    expect(
      projectSessionDisplayMessage(
        assistant("HEARTBEAT_OK", {
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        }),
      )?.text,
    ).toBe("HEARTBEAT_OK");
  });

  test("bounds previews without splitting surrogate pairs", () => {
    const longReply = `${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 2)}😊tail`;
    const preview = projectSessionDisplayMessage(assistant(longReply));

    expect(preview?.text).toBe(`${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 3)}...`);
  });

  test.each([
    ["pending", pendingMediaReply],
    ["rewritten", managedMediaReply],
  ])("keeps authored assistant media text in %s model-context previews", (_state, message) => {
    expect(projectSessionDisplayMessage(message, { view: "model-context" })).toEqual(
      visible("Artifacts ready\nMEDIA:./proof.png"),
    );
  });

  test("honors explicit preview budgets up to the shared cap", () => {
    const maxChars = 800;
    const message = assistant("a".repeat(maxChars + 20));
    const preview = projectSessionDisplayMessage(message, { maxChars });

    expect(preview?.text).toBe(`${"a".repeat(maxChars - 3)}...`);
    expect(projectSessionDisplayMessage(message, { maxChars: Number.MAX_SAFE_INTEGER })?.text).toBe(
      `${"a".repeat(maxChars - 3)}...`,
    );
  });

  test("flattens links before bounding a preview", () => {
    const longUrl = `https://example.com/${"x".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS)}`;
    const preview = projectSessionDisplayMessage(
      assistant(`Read the [report](${longUrl}) and then deploy.`),
      { flattenMarkdown: true },
    );

    expect(preview?.text).toBe("Read the report and then deploy.");
  });
});
