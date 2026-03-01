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

  it("handles description with unquoted colon (auto-quoting)", () => {
    const content = `---
name: test-skill
description: Generate images using API. IMPORTANT: Must use anime style
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("test-skill");
    expect(result.description).toContain("IMPORTANT");
    expect(result.description).toContain("anime style");
  });

  it("handles multiple colons in description", () => {
    const content = `---
name: multi-colon
description: Step 1: do this. Step 2: do that. Step 3: done
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("multi-colon");
    expect(result.description).toContain("Step 1");
    expect(result.description).toContain("Step 3");
  });

  it("preserves already-quoted values with colons", () => {
    const content = `---
name: quoted-skill
description: "Has colon: inside quotes"
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("Has colon: inside quotes");
  });

  it("does not auto-quote values without colons", () => {
    const content = `---
name: normal-skill
description: Simple description without extra colons
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("Simple description without extra colons");
  });
});
