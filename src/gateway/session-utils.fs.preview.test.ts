import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, test } from "vitest";
import { buildSessionPreviewItems } from "./session-display-projection.js";

describe("buildSessionPreviewItems bounded projection", () => {
  test("parses only 12 visible signatures from the recovery 1024-row tail", () => {
    const visible = 704;
    const hidden = 320;
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

  const visibilityMessages = [
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
  test.each([
    ...(
      [
        ["display", { role: "user", text: "question" }],
        ["model-context", { role: "assistant", text: "model only" }],
      ] as const
    ).map(([view, preceding]) => ({
      name: `${view} visibility, order and UTF-16 bounds`,
      messages: visibilityMessages,
      view,
      limit: 2,
      maxChars: 20,
      expected: [preceding, { role: "assistant", text: `${"x".repeat(16)}...` }],
    })),
    {
      name: "fewer visible items than the limit",
      messages: [
        null,
        undefined,
        {},
        { role: "user", content: "first" },
        { role: "toolResult", content: "tool output" },
        { role: "assistant", content: "ANNOUNCE_SKIP" },
        { role: "assistant", content: "hidden", display: false },
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
      view: undefined,
      limit: 12,
      maxChars: 120,
      expected: [
        { role: "user", text: "first" },
        { role: "assistant", text: "last" },
      ],
    },
  ])("preserves $name", ({ messages, expected, limit, maxChars, view }) => {
    const original = JSON.stringify(messages);
    expect(buildSessionPreviewItems(messages, limit, maxChars, view)).toEqual(expected);
    expect(JSON.stringify(messages)).toBe(original);
  });
});
