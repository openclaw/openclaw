import { describe, expect, it } from "vitest";

import { parseStructuredUpdate, parseStructuredUpdateFromTexts } from "./monitor.js";

describe("parseStructuredUpdate", () => {
  it("parses valid overseerUpdate from fenced json block", () => {
    const text = `
Some assistant response text here.

\`\`\`json
{
  "overseerUpdate": {
    "status": "in_progress",
    "summary": "Completed step 1 of 3",
    "next": "Working on step 2"
  }
}
\`\`\`

More text after.
    `;

    const result = parseStructuredUpdate(text);

    expect(result).toBeDefined();
    expect(result?.status).toBe("in_progress");
    expect(result?.summary).toBe("Completed step 1 of 3");
    expect(result?.next).toBe("Working on step 2");
  });

  it("returns last fenced block when multiple present", () => {
    const text = `
\`\`\`json
{ "overseerUpdate": { "status": "blocked" } }
\`\`\`

\`\`\`json
{ "overseerUpdate": { "status": "done" } }
\`\`\`
    `;

    const result = parseStructuredUpdate(text);

    expect(result?.status).toBe("done");
  });

  it("parses done status with evidence", () => {
    const text = `
Task completed!

\`\`\`json
{
  "overseerUpdate": {
    "goalId": "G123",
    "workNodeId": "T1.1",
    "status": "done",
    "summary": "Implemented the feature",
    "evidence": {
      "filesTouched": ["src/foo.ts", "src/bar.ts"],
      "testsRun": ["foo.test.ts"],
      "commits": ["abc123"]
    }
  }
}
\`\`\`
    `;

    const result = parseStructuredUpdate(text);

    expect(result?.status).toBe("done");
    expect(result?.goalId).toBe("G123");
    expect(result?.workNodeId).toBe("T1.1");
    expect(result?.evidence?.filesTouched).toContain("src/foo.ts");
    expect(result?.evidence?.commits).toContain("abc123");
  });

  it("parses blocked status with blockers", () => {
    const text = `
\`\`\`json
{
  "overseerUpdate": {
    "status": "blocked",
    "blockers": ["Need API credentials", "Waiting for PR review"]
  }
}
\`\`\`
    `;

    const result = parseStructuredUpdate(text);

    expect(result?.status).toBe("blocked");
    expect(result?.blockers).toHaveLength(2);
    expect(result?.blockers).toContain("Need API credentials");
  });

  it("returns undefined for text without json blocks", () => {
    const text = "Just some regular text without any code blocks.";

    const result = parseStructuredUpdate(text);

    expect(result).toBeUndefined();
  });

  it("returns undefined for json block without overseerUpdate", () => {
    const text = `
\`\`\`json
{ "someOtherData": true }
\`\`\`
    `;

    const result = parseStructuredUpdate(text);

    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid json", () => {
    const text = `
\`\`\`json
{ invalid json here }
\`\`\`
    `;

    const result = parseStructuredUpdate(text);

    expect(result).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    const result = parseStructuredUpdate(null);

    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const result = parseStructuredUpdate("");

    expect(result).toBeUndefined();
  });
});

describe("parseStructuredUpdateFromTexts", () => {
  it("finds update in array of texts", () => {
    const texts = [
      "First chunk of text",
      'Second chunk with update:\n```json\n{"overseerUpdate": {"status": "done"}}\n```',
      "Third chunk",
    ];

    const result = parseStructuredUpdateFromTexts(texts);

    expect(result?.status).toBe("done");
  });

  it("returns first found update", () => {
    const texts = [
      '```json\n{"overseerUpdate": {"status": "in_progress"}}\n```',
      '```json\n{"overseerUpdate": {"status": "done"}}\n```',
    ];

    const result = parseStructuredUpdateFromTexts(texts);

    expect(result?.status).toBe("in_progress");
  });

  it("returns undefined for empty array", () => {
    const result = parseStructuredUpdateFromTexts([]);

    expect(result).toBeUndefined();
  });

  it("returns undefined when no texts have updates", () => {
    const texts = ["Just text", "More text", "No updates here"];

    const result = parseStructuredUpdateFromTexts(texts);

    expect(result).toBeUndefined();
  });
});
