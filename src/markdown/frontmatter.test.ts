import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { parseFrontmatterBlock } from "./frontmatter.js";

describe("parseFrontmatterBlock", () => {
  it("parses YAML block scalars", () => {
    const content = `---
name: yaml-hook
description: |
  line one
  line two
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("yaml-hook");
    expect(result.description).toBe("line one\nline two");
  });

  it("handles JSON5-style multi-line metadata", () => {
    const content = `---
name: session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "disk",
        "events": ["command:new"],
      },
  }
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBeDefined();

    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.openclaw?.emoji).toBe("disk");
  });

  it("preserves inline JSON values", () => {
    const content = `---
name: inline-json
metadata: {"openclaw": {"events": ["test"]}}
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"openclaw": {"events": ["test"]}}');
  });

  it("stringifies YAML objects and arrays", () => {
    const content = `---
name: yaml-objects
enabled: true
retries: 3
tags:
  - alpha
  - beta
metadata:
  openclaw:
    events:
      - command:new
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.enabled).toBe("true");
    expect(result.retries).toBe("3");
    expect(JSON.parse(result.tags ?? "[]")).toEqual(["alpha", "beta"]);
    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.openclaw?.events).toEqual(["command:new"]);
  });

  it("returns empty when frontmatter is missing", () => {
    const content = "# No frontmatter";
    expect(parseFrontmatterBlock(content)).toEqual({});
  });

  it("parses description containing an inline colon without corruption (issue #29981)", () => {
    // YAML mis-parses "description: Foo IMPORTANT: bar" as a nested object.
    // The line-parser reads it correctly as a plain string – we should prefer that.
    const content = `---
name: my-skill
description: Generate images IMPORTANT: Must use anime style
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("Generate images IMPORTANT: Must use anime style");
  });

  it("preserves intentional single-line YAML nested maps (bot concern)", () => {
    // "key: nested: val" is a YAML parse error ("Nested mappings are not allowed").
    // parseYamlFrontmatter returns null and parseFrontmatterBlock falls back to
    // the line-parser entirely — it reads `openclaw: command` as a plain string.
    // This confirms the bot's edge case cannot reach the merge step at all.
    const content = `---
name: my-skill
category: openclaw: command
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("my-skill");
    // YAML throws → line-parser wins for the entire doc; value is the raw string
    expect(result.category).toBe("openclaw: command");
  });
});

