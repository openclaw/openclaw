import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, test } from "vitest";
import { buildSessionPreviewItems } from "./session-display-projection.js";

describe("buildSessionPreviewItems bounded projection", () => {
  test.each([
    { name: "ordinary 64-row tail", visible: 64, hidden: 0 },
    { name: "recovery 1024-row tail", visible: 704, hidden: 320 },
  ])("parses only 12 visible signatures from the $name", ({ visible, hidden }) => {
    const sourceMessages = Array.from({ length: visible + hidden }, (_, index) => ({
      role: index < visible ? "assistant" : "toolResult",
      content: [
        {
          type: "text",
          text: `message ${index}`,
          textSignature: JSON.stringify({ v: 1, id: `preview-${index}`, phase: "final_answer" }),
        },
      ],
    }));
    const sourceText = JSON.stringify(sourceMessages);
    // SQLite hydration yields fresh blocks, so the per-block signature cache starts cold.
    const messages = JSON.parse(sourceText) as typeof sourceMessages;
    const originalRows = messages.slice();
    const originalContents = messages.map((message) => message.content);
    const signatureTexts = new Set(
      sourceMessages.map((message) => message.content[0]!.textSignature),
    );
    const parse = JSON.parse;
    const descriptor = expectDefined(
      Object.getOwnPropertyDescriptor(JSON, "parse"),
      "native JSON.parse descriptor",
    );
    let parsedSignatures = 0;
    Object.defineProperty(JSON, "parse", {
      ...descriptor,
      value(...args: Parameters<typeof JSON.parse>) {
        if (signatureTexts.has(args[0])) {
          parsedSignatures += 1;
        }
        return parse(...args);
      },
    });
    let result: ReturnType<typeof buildSessionPreviewItems>;
    try {
      result = buildSessionPreviewItems(messages, 12, 120);
    } finally {
      Object.defineProperty(JSON, "parse", descriptor);
    }

    expect(result).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        role: "assistant",
        text: `message ${visible - 12 + index}`,
      })),
    );
    expect(JSON.stringify(messages)).toBe(sourceText);
    expect(messages.every((message, index) => message === originalRows[index])).toBe(true);
    expect(messages.every((message, index) => message.content === originalContents[index])).toBe(
      true,
    );
    expect(parsedSignatures).toBe(12);
  });

  test.each([
    { view: "display" as const, preceding: { role: "user", text: "question" } },
    { view: "model-context" as const, preceding: { role: "assistant", text: "model only" } },
  ])("keeps visibility, order and UTF-16 bounds in the $view", ({ view, preceding }) => {
    const messages = [
      { role: "user", content: "older excluded text" },
      { role: "assistant", content: "NO_REPLY" },
      { role: "toolResult", content: "tool output" },
      { role: "user", content: [{ type: "input_text", text: "  question  " }] },
      { role: "assistant", content: "model only", display: false },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "private commentary",
            textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          },
          {
            type: "text",
            text: `${"x".repeat(16)}🦊tail`,
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        ],
      },
      { role: "assistant", content: "REPLY_SKIP" },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
      { role: "system", content: "system metadata" },
    ];
    const original = JSON.stringify(messages);

    expect(buildSessionPreviewItems(messages, 2, 20, view)).toEqual([
      preceding,
      { role: "assistant", text: `${"x".repeat(16)}...` },
    ]);
    expect(JSON.stringify(messages)).toBe(original);
  });

  test.each([
    { name: "empty", messages: [], expected: [] },
    {
      name: "fully filtered",
      messages: [
        null,
        undefined,
        {},
        { role: "toolResult", content: "tool output" },
        { role: "assistant", content: "ANNOUNCE_SKIP" },
        { role: "assistant", content: "hidden", display: false },
      ],
      expected: [],
    },
    {
      name: "fewer visible items than the limit",
      messages: [
        { role: "user", content: "first" },
        { role: "toolResult", content: "tool output" },
        { role: "assistant", content: "last" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "commentary only",
              textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
            },
          ],
        },
      ],
      expected: [
        { role: "user", text: "first" },
        { role: "assistant", text: "last" },
      ],
    },
  ])("preserves the $name preview", ({ messages, expected }) => {
    const original = JSON.stringify(messages);

    expect(buildSessionPreviewItems(messages, 12, 120)).toEqual(expected);
    expect(JSON.stringify(messages)).toBe(original);
  });
});
