import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";

describe("control reply display projection", () => {
  it.each(["REPLY_SKIP\n\nRE", "reply_skip\n\nre", "ANNOUNCE_SKIP\nREPLY_SKIP"])(
    "hides repeated control output %s after an interrupted or completed stream",
    (text) => {
      expect(
        projectLiveAssistantBufferedText(text, { suppressLeadFragments: false }),
      ).toMatchObject({
        text: "",
        suppress: true,
      });
      expect(projectChatDisplayMessages([{ role: "assistant", content: text }])).toEqual([]);
    },
  );

  it.each(["REPLY_SKIP means the peer exchange is over.", "The literal marker is `REPLY_SKIP`."])(
    "keeps substantive prose mentioning controls: %s",
    (text) => {
      expect(projectLiveAssistantBufferedText(text)).toMatchObject({ text, suppress: false });
    },
  );

  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "holds every partial %s after separate control replies without losing ordinary final text",
    (token) => {
      for (let length = 1; length < token.length; length += 1) {
        const prefix = token.slice(0, length);
        for (const text of [prefix, `${token}\n\n${token}\n\n${prefix}`]) {
          expect(projectLiveAssistantBufferedText(text).suppress, text).toBe(true);
        }
        expect(
          projectLiveAssistantBufferedText(prefix, { suppressLeadFragments: false }).text,
        ).toBe(prefix);
      }
      expect(projectLiveAssistantBufferedText(`${token}\n\nReady to continue.`).suppress).toBe(
        false,
      );
    },
  );

  it.each(["NO_", "ANNOUNCE_", "REPLY_"])(
    "holds whitespace-padded %s prefixes while streaming",
    (prefix) => {
      const text = `${" \t\n".repeat(10)}${prefix}\u00a0\ufeff`;
      expect(projectLiveAssistantBufferedText(text)).toEqual({
        text,
        suppress: true,
        pendingLeadFragment: true,
      });
    },
  );

  it("preserves text whitespace when no control token is present", () => {
    expect(stripSuppressedControlReplyToken("  keep padded  ")).toBe("  keep padded  ");
    expect(
      projectChatDisplayMessages([
        { role: "assistant", content: [{ type: "text", text: "  keep padded  " }] },
      ]),
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "  keep padded  " }] }]);
  });

  it("preserves control-looking text when it accompanies displayable content", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "NO_REPLY" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ],
    };

    expect(stripSuppressedControlReplyToken("NO_REPLY")).toBe("");
    expect(projectChatDisplayMessages([message])).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "NO_REPLY" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
            omitted: true,
            bytes: 2,
          },
        ],
      },
    ]);
  });

  it("strips a standalone control token beside visible text", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Visible reply" },
            { type: "text", text: "NO_REPLY" },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visible reply" },
          { type: "text", text: "" },
        ],
      },
    ]);
  });

  it("preserves control-looking text forwarded from another session", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:webchat:source",
        sourceTool: "sessions_send",
      },
    };

    expect(projectChatDisplayMessages([message])).toEqual([message]);
  });

  it("strips a trailing sessions control token from substantive text", () => {
    const text = "The handoff is complete.\n\nREPLY_SKIP";

    expect(stripSuppressedControlReplyToken(text)).toBe("The handoff is complete.");
    expect(projectLiveAssistantBufferedText(text)).toEqual({
      text: "The handoff is complete.",
      suppress: false,
      pendingLeadFragment: false,
    });
    expect(
      projectChatDisplayMessages([{ role: "assistant", content: [{ type: "text", text }] }]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "The handoff is complete." }],
      },
    ]);
  });

  it("hides a control-only reply that also contains model thinking", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "The loop is complete." },
            { type: "text", text: "REPLY_SKIP" },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
