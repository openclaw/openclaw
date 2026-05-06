import { describe, expect, it } from "vitest";
import { findOcPaths, getOcPathDocumentKind, parseOcPath, resolveOcPath } from "./oc-path.js";

describe("workspace oc-path", () => {
  it("parses supported workspace file paths and decoded segments", () => {
    expect(parseOcPath("oc://policy.jsonc/tools/%5Bid=send-email%5D/sensitivity")).toEqual({
      filePath: "policy.jsonc",
      segments: ["tools", "[id=send-email]", "sensitivity"],
    });
    expect(parseOcPath("oc://notes/AGENTS.md/Tools")).toEqual({
      filePath: "notes/AGENTS.md",
      segments: ["Tools"],
    });
  });

  it("rejects non oc paths and unsupported file kinds", () => {
    expect(() => parseOcPath("policy.jsonc/tools")).toThrow("must start with oc://");
    expect(() => parseOcPath("oc://policy.txt/tools")).toThrow(
      "must include a supported workspace file",
    );
    expect(() => getOcPathDocumentKind("policy.txt")).toThrow("Unsupported OpenClaw path");
  });

  it("resolves JSONC object, array, negative-index, and predicate paths", () => {
    const content = `{
      // comments are accepted by the JSONC parser
      tools: [
        { id: "send-email", sensitivity: "restricted" },
        { id: "calendar", sensitivity: "normal" },
      ],
    }`;

    expect(
      resolveOcPath({
        ocPath: "oc://policy.jsonc/tools/0/id",
        content,
      }),
    ).toMatchObject({ kind: "value", value: "send-email" });
    expect(
      resolveOcPath({
        ocPath: "oc://policy.jsonc/tools/-1/id",
        content,
      }),
    ).toMatchObject({ kind: "value", value: "calendar" });
    expect(
      resolveOcPath({
        ocPath: "oc://policy.jsonc/tools/[id=send-email]/sensitivity",
        content,
      }),
    ).toMatchObject({ kind: "value", value: "restricted" });
    expect(
      resolveOcPath({
        ocPath: "oc://policy.jsonc/tools/[id=missing]/sensitivity",
        content,
      }),
    ).toBeUndefined();
  });

  it("finds JSONC wildcard matches", () => {
    const matches = findOcPaths({
      ocPath: "oc://policy.jsonc/tools/*/id",
      content: `{ tools: [{ id: "send-email" }, { id: "calendar" }] }`,
    });

    expect(matches).toEqual([
      { kind: "value", path: "oc://policy.jsonc/tools/0/id", value: "send-email" },
      { kind: "value", path: "oc://policy.jsonc/tools/1/id", value: "calendar" },
    ]);
  });

  it("resolves markdown heading paths without rewriting the document", () => {
    const content = `# Agent

Intro.

## Tools

### send-email

R5, sensitivity: restricted

### calendar

R2, sensitivity: normal

## Notes

Other content.
`;

    expect(
      resolveOcPath({
        ocPath: "oc://AGENTS.md/Tools/send-email",
        content,
      }),
    ).toMatchObject({
      kind: "markdown-section",
      heading: "send-email",
      line: 7,
      valueText: "R5, sensitivity: restricted",
    });
    expect(
      resolveOcPath({
        ocPath: "oc://AGENTS.md/Tools/missing",
        content,
      }),
    ).toBeUndefined();
  });

  it("finds markdown wildcard heading matches", () => {
    const matches = findOcPaths({
      ocPath: "oc://AGENTS.md/Tools/*",
      content: `# Agent

## Tools

### send-email
Email body.

### calendar
Calendar body.
`,
    });

    expect(matches.map((match) => match.path)).toEqual([
      "oc://AGENTS.md/Tools/send-email",
      "oc://AGENTS.md/Tools/calendar",
    ]);
    expect(matches.map((match) => ("heading" in match ? match.heading : ""))).toEqual([
      "send-email",
      "calendar",
    ]);
  });
});
