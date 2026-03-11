import { describe, expect, it } from "vitest";
import { preprocessTtsText } from "./tts-core.js";

describe("preprocessTtsText", () => {
  describe("code fence stripping", () => {
    it("strips fenced code blocks from spoken text", () => {
      const input = `Here is some code:

\`\`\`typescript
const x = 42;
console.log(x);
\`\`\`

That's the example.`;

      const { visibleText, spokenText } = preprocessTtsText(input);

      expect(spokenText).not.toContain("```");
      expect(spokenText).not.toContain("const x = 42");
      expect(spokenText).toContain("Here is some code:");
      expect(spokenText).toContain("That's the example.");

      // Code blocks stay in visible text
      expect(visibleText).toContain("```typescript");
      expect(visibleText).toContain("const x = 42");
    });

    it("strips multiple code blocks", () => {
      const input = `First block:

\`\`\`js
a();
\`\`\`

Second block:

\`\`\`python
b()
\`\`\`

Done.`;

      const { spokenText } = preprocessTtsText(input);
      expect(spokenText).not.toContain("a()");
      expect(spokenText).not.toContain("b()");
      expect(spokenText).toContain("First block:");
      expect(spokenText).toContain("Second block:");
      expect(spokenText).toContain("Done.");
    });

    it("strips code fences without a language tag", () => {
      const input = `Example:

\`\`\`
plain code
\`\`\`

End.`;

      const { spokenText } = preprocessTtsText(input);
      expect(spokenText).not.toContain("plain code");
      expect(spokenText).toContain("Example:");
    });
  });

  describe("table stripping", () => {
    it("strips markdown tables from spoken text", () => {
      const input = `Here are the results:

| Name  | Score |
|-------|-------|
| Alice | 95    |
| Bob   | 87    |

Summary: Alice won.`;

      const { visibleText, spokenText } = preprocessTtsText(input);

      expect(spokenText).not.toContain("|");
      expect(spokenText).toContain("Here are the results:");
      expect(spokenText).toContain("Summary: Alice won.");

      // Tables stay in visible text
      expect(visibleText).toContain("| Name  | Score |");
      expect(visibleText).toContain("| Alice | 95    |");
    });
  });

  describe("<tts> tag handling", () => {
    it("replaces <tts> tags with inner content in spoken text", () => {
      const input = "The function returns <tts>a list of results</tts>`Result[]`.";
      const { spokenText } = preprocessTtsText(input);
      expect(spokenText).toContain("a list of results");
      expect(spokenText).not.toContain("<tts>");
      expect(spokenText).not.toContain("</tts>");
    });

    it("removes <tts> tags entirely from visible text", () => {
      const input = "The function returns <tts>a list of results</tts>`Result[]`.";
      const { visibleText } = preprocessTtsText(input);
      expect(visibleText).not.toContain("<tts>");
      expect(visibleText).not.toContain("a list of results");
      expect(visibleText).toContain("`Result[]`");
    });

    it("handles multiple <tts> tags", () => {
      const input =
        "Use <tts>the map function</tts>`.map()` and <tts>the filter function</tts>`.filter()`.";
      const { spokenText, visibleText } = preprocessTtsText(input);
      expect(spokenText).toContain("the map function");
      expect(spokenText).toContain("the filter function");
      expect(visibleText).not.toContain("the map function");
      expect(visibleText).toContain("`.map()`");
    });

    it("handles multiline <tts> content", () => {
      const input = `Check this out:
<tts>Here is a spoken
alternative on multiple lines</tts>
\`\`\`
some code
\`\`\``;

      const { spokenText } = preprocessTtsText(input);
      expect(spokenText).toContain("Here is a spoken\nalternative on multiple lines");
    });

    it("is case-insensitive for tag matching", () => {
      const input = "Hello <TTS>world</TTS> there.";
      const { spokenText, visibleText } = preprocessTtsText(input);
      expect(spokenText).toContain("world");
      expect(visibleText).not.toContain("world");
    });
  });

  describe("<notts> tag handling", () => {
    it("keeps <notts> content visible but removes it from spoken text", () => {
      const input = `Here are the results:

<notts>
| Name  | Score |
|-------|-------|
| Alice | 95    |
</notts>

Summary: Alice won.`;

      const { visibleText, spokenText } = preprocessTtsText(input);

      // visibleText: table content visible, <notts> tags stripped
      expect(visibleText).toContain("| Name  | Score |");
      expect(visibleText).toContain("| Alice | 95    |");
      expect(visibleText).not.toContain("<notts>");
      expect(visibleText).not.toContain("</notts>");

      // spokenText: entire <notts> block removed
      expect(spokenText).not.toContain("| Name");
      expect(spokenText).not.toContain("| Alice | 95");
      expect(spokenText).toContain("Here are the results:");
      expect(spokenText).toContain("Summary: Alice won.");
    });

    it("handles <notts> with code blocks inside", () => {
      const input = `Explanation:

<notts>
\`\`\`swift
struct Foo { let bar: Int }
\`\`\`
</notts>

That's the struct.`;

      const { visibleText, spokenText } = preprocessTtsText(input);

      expect(visibleText).toContain("struct Foo");
      expect(visibleText).not.toContain("<notts>");
      expect(spokenText).not.toContain("struct Foo");
      expect(spokenText).toContain("That's the struct.");
    });

    it("handles <notts> combined with <tts> for alternative text", () => {
      const input = `Status update:

<notts>
| Feature | Status |
|---------|--------|
| Voice   | Done   |
| Agent   | WIP    |
</notts>
<tts>Voice is done, Agent is work in progress.</tts>

Moving on.`;

      const { visibleText, spokenText } = preprocessTtsText(input);

      // visibleText: table shown, tts alternative hidden
      expect(visibleText).toContain("| Voice   | Done   |");
      expect(visibleText).not.toContain("Voice is done");
      expect(visibleText).not.toContain("<notts>");
      expect(visibleText).not.toContain("<tts>");

      // spokenText: table hidden, tts alternative spoken
      expect(spokenText).not.toContain("|");
      expect(spokenText).toContain("Voice is done, Agent is work in progress.");
      expect(spokenText).toContain("Moving on.");
    });

    it("is case-insensitive", () => {
      const input = "Hello <NOTTS>secret</NOTTS> world.";
      const { visibleText, spokenText } = preprocessTtsText(input);
      expect(visibleText).toContain("secret");
      expect(visibleText).not.toContain("<NOTTS>");
      expect(spokenText).not.toContain("secret");
    });

    it("handles multiple <notts> blocks", () => {
      const input = "A <notts>hidden1</notts> B <notts>hidden2</notts> C";
      const { visibleText, spokenText } = preprocessTtsText(input);
      expect(visibleText).toContain("hidden1");
      expect(visibleText).toContain("hidden2");
      expect(spokenText).not.toContain("hidden1");
      expect(spokenText).not.toContain("hidden2");
      expect(spokenText).toContain("A");
      expect(spokenText).toContain("B");
      expect(spokenText).toContain("C");
    });

    it("preserves <notts> tags when processTtsTags is false", () => {
      const input = "Hello <notts>world</notts> there.";
      const { visibleText, spokenText } = preprocessTtsText(input, { processTtsTags: false });
      expect(spokenText).toContain("<notts>world</notts>");
      expect(visibleText).toContain("<notts>world</notts>");
    });
  });

  describe("passthrough (no special content)", () => {
    it("returns text unchanged when no special content is present", () => {
      const input = "Just a normal sentence with no code or tables.";
      const { visibleText, spokenText } = preprocessTtsText(input);
      expect(visibleText).toBe(input);
      expect(spokenText).toBe(input);
    });

    it("handles empty string", () => {
      const { visibleText, spokenText } = preprocessTtsText("");
      expect(visibleText).toBe("");
      expect(spokenText).toBe("");
    });
  });

  describe("config flags", () => {
    it("preserves code blocks in spoken text when stripCodeBlocks is false", () => {
      const input = `Text before.

\`\`\`js
code()
\`\`\`

Text after.`;

      const { spokenText } = preprocessTtsText(input, { stripCodeBlocks: false });
      expect(spokenText).toContain("```js");
      expect(spokenText).toContain("code()");
    });

    it("preserves tables in spoken text when stripTables is false", () => {
      const input = `| A | B |\n|---|---|\n| 1 | 2 |`;
      const { spokenText } = preprocessTtsText(input, { stripTables: false });
      expect(spokenText).toContain("| A | B |");
    });

    it("preserves <tts> tags when processTtsTags is false", () => {
      const input = "Hello <tts>world</tts> there.";
      const { visibleText, spokenText } = preprocessTtsText(input, { processTtsTags: false });
      expect(spokenText).toContain("<tts>world</tts>");
      expect(visibleText).toContain("<tts>world</tts>");
    });
  });

  describe("inline backticks preserved", () => {
    it("preserves inline backticks in spoken text (only fenced blocks are stripped)", () => {
      const input = "Use `Array.map()` to transform items and `filter()` to select them.";
      const { spokenText, visibleText } = preprocessTtsText(input);
      expect(spokenText).toContain("`Array.map()`");
      expect(spokenText).toContain("`filter()`");
      expect(visibleText).toBe(input);
    });
  });

  describe("entire message is a code block", () => {
    it("returns empty spokenText when the whole message is a code block", () => {
      const input = `\`\`\`python
def hello():
    print("hello")
\`\`\``;

      const { spokenText, visibleText } = preprocessTtsText(input);
      expect(spokenText).toBe("");
      expect(visibleText).toBe(input);
    });
  });

  describe("<tts> tag adjacent to code block", () => {
    it("replaces <tts> in speech and strips code block independently", () => {
      const input = `Here is the result:
<tts>The function returns a list of users.</tts>
\`\`\`typescript
function getUsers(): User[] { return []; }
\`\`\``;

      const { spokenText, visibleText } = preprocessTtsText(input);
      expect(spokenText).toContain("The function returns a list of users.");
      expect(spokenText).not.toContain("function getUsers");
      expect(spokenText).not.toContain("```");
      expect(visibleText).not.toContain("<tts>");
      expect(visibleText).not.toContain("The function returns a list of users.");
      expect(visibleText).toContain("function getUsers");
    });
  });

  describe("table stripping edge cases", () => {
    it("does not strip lines with only a leading pipe (no trailing pipe)", () => {
      const input = "Run `echo hello | grep hello` to test.";
      const { spokenText } = preprocessTtsText(input);
      expect(spokenText).toContain("echo hello | grep hello");
    });
  });

  describe("excessive blank lines", () => {
    it("collapses multiple blank lines to at most two newlines", () => {
      const input = "Line one.\n\n\n\n\nLine two.";
      const { visibleText, spokenText } = preprocessTtsText(input);
      expect(visibleText).toBe("Line one.\n\nLine two.");
      expect(spokenText).toBe("Line one.\n\nLine two.");
    });
  });
});
