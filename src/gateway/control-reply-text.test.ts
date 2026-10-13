import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";

const textBlock = (text: string) => ({ type: "text", text });
const assistant = (content: unknown) => ({ role: "assistant", content });

describe("control reply display projection", () => {
  it.each([
    ...[
      "REPLY_SKIP\n\nRE",
      "reply_skip\n\nre",
      "ANNOUNCE_SKIP\nREPLY_SKIP",
      "\u00a0“NO_REPLY”\ufeff",
      "«announce_skip»",
      "*** \nREPLY_SKIP***",
    ].map((text) => ({ text, visible: "" })),
    ...[
      "REPLY_SKIP means the peer exchange is over.",
      "The literal marker is `REPLY_SKIP`.",
      "  keep padded  ",
    ].map((text) => ({ text, visible: text })),
    { text: "The handoff is complete.\n\nREPLY_SKIP", visible: "The handoff is complete." },
  ])(
    "projects completed reply $text consistently in live and stored messages",
    ({ text, visible }) => {
      expect(stripSuppressedControlReplyToken(text)).toBe(visible);
      expect(projectLiveAssistantBufferedText(text, { suppressLeadFragments: false })).toEqual({
        text: visible,
        suppress: !visible,
        pendingLeadFragment: false,
      });
      for (const content of [text, [textBlock(text)]]) {
        const expected = typeof content === "string" ? visible : [textBlock(visible)];
        expect(projectChatDisplayMessages([assistant(content)])).toEqual(
          visible ? [assistant(expected)] : [],
        );
      }
    },
  );

  it.each([63, 64])("classifies replies at the %i-character padding boundary", (length) => {
    for (const padding of [" ".repeat(length), "。".repeat(length)]) {
      const control = `${padding}NO_REPLY`;
      expect(
        projectLiveAssistantBufferedText(control, { suppressLeadFragments: false }),
      ).toMatchObject({
        text: "",
        suppress: true,
      });
      expect(projectChatDisplayMessages([assistant(control)])).toEqual([]);
      const text = `${padding}Ready to continue.`;
      expect(projectLiveAssistantBufferedText(text)).toMatchObject({ text, suppress: false });
      expect(projectChatDisplayMessages([assistant(text)])).toEqual([assistant(text)]);
    }
  });

  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "holds partial %s while streaming and releases ordinary final text",
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
      const text = `${" \t\n".repeat(10)}${token.slice(0, token.indexOf("_") + 1)}\u00a0\ufeff`;
      expect(projectLiveAssistantBufferedText(text)).toEqual({
        text,
        suppress: true,
        pendingLeadFragment: true,
      });
    },
  );

  const forwarded = {
    ...assistant([textBlock("NO_REPLY")]),
    provenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:main:webchat:source",
      sourceTool: "sessions_send",
    },
  };
  it.each([
    {
      name: "displayable image",
      message: assistant([
        textBlock("NO_REPLY"),
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ]),
      expected: [
        assistant([
          textBlock("NO_REPLY"),
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
            omitted: true,
            bytes: 2,
          },
        ]),
      ],
    },
    {
      name: "visible sibling text",
      message: assistant([textBlock("Visible reply"), textBlock("NO_REPLY")]),
      expected: [assistant([textBlock("Visible reply"), textBlock("")])],
    },
    { name: "forwarded reply", message: forwarded, expected: [forwarded] },
    {
      name: "model thinking",
      message: assistant([
        { type: "thinking", thinking: "The loop is complete." },
        textBlock("REPLY_SKIP"),
      ]),
      expected: [],
    },
  ])("projects a control token alongside $name", ({ message, expected }) => {
    expect(stripSuppressedControlReplyToken("NO_REPLY")).toBe("");
    expect(projectChatDisplayMessages([message])).toEqual(expected);
  });
});
