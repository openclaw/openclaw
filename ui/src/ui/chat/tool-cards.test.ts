import { describe, expect, it } from "vitest";
import {
  buildToolCardOutputLookup,
  buildToolSidebarContent,
  enrichToolCardsWithLookup,
  extractToolCards,
} from "./tool-cards.ts";

describe("tool-cards", () => {
  it("propagates result text and call arguments across paired tool cards", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolresult",
          name: "read",
          text: "README contents",
        },
      ],
    });

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "read",
      text: "README contents",
      args: { path: "README.md" },
    });
    expect(cards[1]).toMatchObject({
      kind: "result",
      name: "read",
      text: "README contents",
      args: { path: "README.md" },
    });
  });

  it("appends enhanced read output after official tool info", () => {
    const sidebar = buildToolSidebarContent({
      displayLabel: "Read",
      detail: "from docs/readme.md",
      hasSidebarOutput: true,
      formattedOutput: "### Read Files\n\n- `docs/readme.md`\n\n```txt\nhello\n```",
      rawOutput: "hello",
    });

    expect(sidebar).toContain("## Read");
    expect(sidebar).toContain("**Command:** `from docs/readme.md`");
    expect(sidebar).toContain("---");
    expect(sidebar).toContain("### Read Files");
    expect(sidebar).not.toContain("### Raw Output");
  });

  it("keeps official info and formatted output for non read/edit tools", () => {
    const sidebar = buildToolSidebarContent({
      displayLabel: "Exec",
      detail: "ls -la",
      hasSidebarOutput: true,
      formattedOutput: "```sh\nok\n```",
      rawOutput: "ok",
    });

    expect(sidebar).toContain("## Exec");
    expect(sidebar).toContain("**Command:** `ls -la`");
    expect(sidebar).toContain("```sh\nok\n```");
    expect(sidebar).not.toContain("### Raw Output");
  });

  it("appends raw output when formatted output is transformed", () => {
    const sidebar = buildToolSidebarContent({
      displayLabel: "Exec",
      detail: "npm test",
      hasSidebarOutput: true,
      formattedOutput: "### Execution Result\n\n- **Exit Code:** 1",
      rawOutput: "{\"exitCode\":1,\"stderr\":\"boom\"}",
    });

    expect(sidebar).toContain("### Execution Result");
    expect(sidebar).toContain("### Raw Output");
    expect(sidebar).toContain("exitCode");
  });

  it("extracts tool result text from structured content arrays", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolresult",
          name: "read",
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
      ],
    });

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "read",
      text: "line 1\nline 2",
      args: { path: "README.md" },
    });
    expect(cards[1]).toMatchObject({
      kind: "result",
      name: "read",
      text: "line 1\nline 2",
      args: { path: "README.md" },
    });
  });

  it("applies read fallback text when read card output is empty", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "toolcall",
            name: "read",
            arguments: { path: "C:\\RHDSetup.log" },
          },
        ],
      },
      { readFallbackText: "[ResponseResult]\nResultCode=0" },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "read",
      text: "[ResponseResult]\nResultCode=0",
    });
  });

  it("does not override existing read tool output with fallback text", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "toolcall",
            name: "read",
            arguments: { path: "README.md" },
          },
          {
            type: "toolresult",
            name: "read",
            text: "actual file content",
          },
        ],
      },
      { readFallbackText: "fallback content" },
    );

    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "read",
      text: "actual file content",
    });
    expect(cards[1]).toMatchObject({
      kind: "result",
      name: "read",
      text: "actual file content",
    });
  });

  it("does not apply read fallback text to non-read tools", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "toolcall",
            name: "exec_command",
            arguments: { cmd: "pwd" },
          },
        ],
      },
      { readFallbackText: "should not be used" },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "exec_command",
    });
    expect(cards[0].text).toBeUndefined();
  });

  it("captures toolCallId from message-level fields", () => {
    const cards = extractToolCards({
      role: "assistant",
      toolCallId: "fetch-1",
      content: [
        {
          type: "toolcall",
          name: "web_fetch",
          arguments: { url: "https://status.deepseek.com/" },
        },
      ],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "web_fetch",
      toolCallId: "fetch-1",
    });
  });

  it("enriches terse tool cards with richer output from lookup by signature", () => {
    const terseCards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          name: "web_fetch",
          arguments: { url: "https://api-docs.deepseek.com/quick_start/pricing", mode: "text" },
        },
        {
          type: "toolresult",
          name: "web_fetch",
          text: "https://api-docs.deepseek.com/quick_start/pricing",
        },
      ],
    });

    const lookup = buildToolCardOutputLookup([
      {
        role: "assistant",
        toolCallId: "fetch-live-1",
        content: [
          {
            type: "toolcall",
            name: "web_fetch",
            arguments: { mode: "text", url: "https://api-docs.deepseek.com/quick_start/pricing" },
          },
          {
            type: "toolresult",
            name: "web_fetch",
            text: '{"url":"https://api-docs.deepseek.com/quick_start/pricing","status":200,"text":"full body"}',
          },
        ],
      },
    ]);

    const enriched = enrichToolCardsWithLookup(terseCards, lookup);
    expect(enriched[0]?.text).toContain('"status":200');
    expect(enriched[1]?.text).toContain('"status":200');
  });

  it("enriches tool cards by exact toolCallId match", () => {
    const cards = extractToolCards({
      role: "assistant",
      toolCallId: "read-1",
      content: [
        {
          type: "toolcall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolresult",
          name: "read",
          text: "short",
        },
      ],
    });

    const lookup = buildToolCardOutputLookup([
      {
        role: "assistant",
        toolCallId: "read-1",
        content: [
          { type: "toolcall", name: "read", arguments: { path: "README.md" } },
          { type: "toolresult", name: "read", text: "longer and richer read output body" },
        ],
      },
    ]);

    const enriched = enrichToolCardsWithLookup(cards, lookup);
    expect(enriched[0]?.text).toBe("longer and richer read output body");
    expect(enriched[1]?.text).toBe("longer and richer read output body");
  });

  it("enriches by resource hint when signature and toolCallId are unavailable", () => {
    const terseCards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          name: "web_fetch",
          arguments: { url: "https://api-docs.deepseek.com/quick_start/pricing", mode: "text" },
        },
      ],
    });

    const lookup = buildToolCardOutputLookup([
      {
        role: "assistant",
        content: [
          {
            type: "toolresult",
            name: "web_fetch",
            text: '{"url":"https://api-docs.deepseek.com/quick_start/pricing","status":200,"text":"rich body"}',
          },
        ],
      },
    ]);

    const enriched = enrichToolCardsWithLookup(terseCards, lookup);
    expect(enriched[0]?.text).toContain('"status":200');
    expect(enriched[0]?.text).toContain("rich body");
  });
});
