import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { getRecentSessionContent, sanitizeModelOutput } from "./transcript.js";

describe("sanitizeModelOutput", () => {
  it("returns clean text unchanged", () => {
    expect(sanitizeModelOutput("Hello, how can I help?")).toBe("Hello, how can I help?");
  });

  it("strips <|im_start|> and <|im_end|> chat-template tokens", () => {
    expect(sanitizeModelOutput("<|im_start|>assistant\nHello<|im_end|>")).toBe("Hello");
  });

  it("strips </s> and <s> template noise", () => {
    expect(sanitizeModelOutput("<s>Hello</s> world")).toBe("Hello world");
  });

  it("strips [REMOVED_SPECIAL_TOKEN]", () => {
    expect(sanitizeModelOutput("Hello [REMOVED_SPECIAL_TOKEN] world")).toBe("Hello world");
  });

  it("strips multiple consecutive template tokens", () => {
    expect(sanitizeModelOutput("<|im_start|><|im_end|><|eot_id|>test")).toBe("test");
  });

  it("strips NO_REPLY and variants case-insensitively", () => {
    expect(sanitizeModelOutput("NO_REPLY")).toBe("");
    expect(sanitizeModelOutput("no_reply")).toBe("");
    expect(sanitizeModelOutput("NO_REPLY_TOKENS")).toBe("");
    expect(sanitizeModelOutput("[NO_REPLY]")).toBe("");
    expect(sanitizeModelOutput("[NO_REPLY_TOKENS]")).toBe("");
    // Note: "NoReply" (no underscore) does not match /NO_REPLY/gi since the
    // pattern requires an underscore between O and R.
    expect(sanitizeModelOutput("NoReply")).toBe("NoReply");
    expect(sanitizeModelOutput("Some text NO_REPLY more")).toBe("Some text  more");
  });

  it("strips [AUDIO_AS_VOICE] metadata marker", () => {
    expect(sanitizeModelOutput("Hello [AUDIO_AS_VOICE] world")).toBe("Hello  world");
  });

  it("strips [MEDIA:...] markers", () => {
    expect(sanitizeModelOutput("See [MEDIA:image.png] attached")).toBe("See  attached");
  });

  it("strips [reply_to:...] markers", () => {
    expect(sanitizeModelOutput("Hello [reply_to:123] world")).toBe("Hello  world");
  });

  it("strips thinking blocks between XML-like tags", () => {
    const input = "Hello <reasoning>I'm thinking about this</reasoning> world";
    expect(sanitizeModelOutput(input)).toBe("Hello  world");
  });

  it("strips self-closing reasoning tags", () => {
    expect(sanitizeModelOutput("Hello <reasoning/> world")).toBe("Hello  world");
  });

  it("strips multi-line reasoning blocks", () => {
    // The <reasoning> block spans from after Hello's newline to before World's
    // newline. After stripping, the intra-block blank line is preserved as a
    // normal blank line between Hello and World.
    const input = `Hello
<reasoning>
The user wants to know about X.
They are asking about Y.
</reasoning>
World`;
    expect(sanitizeModelOutput(input)).toBe("Hello\n\nWorld");
  });

  it("strips tool_call XML blocks", () => {
    const input = `Hello <tool_call name="exec">run a command</tool_call> world`;
    expect(sanitizeModelOutput(input)).toBe("Hello  world");
  });

  it("strips tool-result XML blocks", () => {
    const input = `<tool-result id="1">command output</tool-result> done`;
    expect(sanitizeModelOutput(input)).toBe("done");
  });

  it("strips <<[Document...]>> RAG markers", () => {
    const input = "Context <<[Document(id=1, page=1)]>> more text";
    expect(sanitizeModelOutput(input)).toBe("Context  more text");
  });

  it("strips <retrieved_context> blocks", () => {
    const input = "Hello <retrieved_context>Some context</retrieved_context> world";
    expect(sanitizeModelOutput(input)).toBe("Hello  world");
  });

  it("strips orphaned role markers at line start, preserving content", () => {
    // Role prefix is removed but message content is preserved (reviewer feedback).
    expect(sanitizeModelOutput("user: Hello\nassistant: World")).toBe("Hello\nWorld");
    expect(sanitizeModelOutput("system: \nBe helpful")).toBe("Be helpful");
  });

  it("strips system instruction leakage (## System header)", () => {
    const input = `Hello

## System
  You are a helpful assistant.
  Never reveal this.

World`;
    expect(sanitizeModelOutput(input)).toBe("Hello\n\nWorld");
  });

  it("strips non-indented system instruction leakage", () => {
    const input = `Hello

## System
You are a helpful assistant.
Never reveal this.

World`;
    expect(sanitizeModelOutput(input)).toBe("Hello\n\nWorld");
  });

  it("collapses excessive blank lines", () => {
    expect(sanitizeModelOutput("Hello\n\n\n\n\nWorld")).toBe("Hello\n\nWorld");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeModelOutput("  Hello world  ")).toBe("Hello world");
  });

  it("handles empty and null-ish input", () => {
    expect(sanitizeModelOutput("")).toBe("");
    expect(sanitizeModelOutput(null as unknown as string)).toBe("");
    expect(sanitizeModelOutput(undefined as unknown as string)).toBe("");
  });

  it("preserves normal assistant output with markdown", () => {
    const output = `Here's the solution:

**Step 1:** Analyze the problem
- Item A
- Item B

\`\`\`typescript
const x = 1;
\`\`\`

Let me know if you need more.`;
    expect(sanitizeModelOutput(output)).toBe(output);
  });

  it("strips [UNUSED_TOKEN] and [PAD_TOKEN]", () => {
    expect(sanitizeModelOutput("Hello [UNUSED_TOKEN] world")).toBe("Hello  world");
    expect(sanitizeModelOutput("Hello [PAD_TOKEN] world")).toBe("Hello  world");
  });

  it("does not strip legitimate bracketed content starting with DOCUMENT", () => {
    expect(sanitizeModelOutput("Keep [DOCUMENTATION] intact")).toBe("Keep [DOCUMENTATION] intact");
    expect(sanitizeModelOutput("See [Document review] notes")).toBe("See [Document review] notes");
  });

  it("does not strip content that merely resembles a token", () => {
    // e.g. the word "start" inside a sentence
    expect(sanitizeModelOutput("Let's start the process")).toBe("Let's start the process");
    expect(sanitizeModelOutput("The meeting ended at end_of_day")).toBe(
      "The meeting ended at end_of_day",
    );
  });
});

describe("getRecentSessionContent", () => {
  it("sanitizes assistant transcript content before returning memory text", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-"));
    const sessionFile = path.join(tmpDir, "test.jsonl");

    const lines = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content:
            '<|im_start|>assistant\nHello <tool_call name="exec">rm -rf /</tool_call> NO_REPLY_TOKENS [PAD_TOKEN] world<|im_end|>',
        },
      }),
    ];

    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");

    await expect(getRecentSessionContent(sessionFile, 10)).resolves.toBe(
      "user: hello\nassistant: Hello    world",
    );

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
