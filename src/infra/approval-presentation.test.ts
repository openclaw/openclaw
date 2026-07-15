// Canonical durable approval presentation safety tests.
import { describe, expect, it } from "vitest";
import { buildApprovalPresentation } from "./approval-presentation.js";

const allowedDecisions = ["allow-once", "deny"] as const;

function buildExecPresentation(request: {
  command: string;
  host?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
}) {
  return buildApprovalPresentation({ kind: "exec", request, allowedDecisions });
}

function buildPluginPresentation(request: {
  title: string;
  description: string;
  pluginId?: string;
  toolName?: string;
  agentId?: string;
}) {
  return buildApprovalPresentation({ kind: "plugin", request, allowedDecisions });
}

function buildSystemAgentPresentation(request: {
  title: string;
  description: string;
  proposalHash?: string;
}) {
  return buildApprovalPresentation({
    kind: "system-agent",
    request: {
      title: request.title,
      description: request.description,
      command: "true",
      proposalHash: request.proposalHash ?? "a".repeat(64),
      allowedDecisions,
      sessionId: "s1",
    },
    allowedDecisions,
  });
}

// Matches a high UTF-16 surrogate with no paired low surrogate following it.
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;

describe("buildApprovalPresentation", () => {
  it("sanitizes exec routing metadata and preserves empty values as null", () => {
    const githubToken = `ghp_${"a".repeat(100)}`;
    const presentation = buildExecPresentation({
      command: "printf safe",
      host: "gate\nway\u202E",
      nodeId: "node\u0000id",
      agentId: githubToken,
    });

    expect(presentation).toMatchObject({
      kind: "exec",
      host: "gate\\u{A}way\\u{202E}",
      nodeId: "node\\u{0}id",
    });
    expect(JSON.stringify(presentation)).not.toContain(githubToken);
    expect(
      buildExecPresentation({
        command: "printf safe",
        host: "   ",
        nodeId: null,
        agentId: "\t",
      }),
    ).toMatchObject({ kind: "exec", host: null, nodeId: null, agentId: null });
  });

  it("escapes control and bidi spoofing while preserving description line breaks", () => {
    const presentation = buildPluginPresentation({
      title: "Deploy\u202Eprod\nnow",
      description: "Line one\r\nLine two\u0000\u202E",
      pluginId: "plugin\u202Eid",
      toolName: "tool\nname",
      agentId: "agent\u0000id",
    });

    expect(presentation).toMatchObject({
      kind: "plugin",
      title: "Deploy\\u{202E}prod\\u{A}now",
      description: "Line one\nLine two\\u{0}\\u{202E}",
      pluginId: "plugin\\u{202E}id",
      toolName: "tool\\u{A}name",
      agentId: "agent\\u{0}id",
    });
  });

  it("redacts secret-like content before applying presentation length limits", () => {
    const githubToken = `ghp_${"a".repeat(100)}`;
    const openAiToken = "sk-abc123456789012345678";
    const presentation = buildPluginPresentation({
      title: githubToken,
      description: `Token:\n${openAiToken}`,
      pluginId: githubToken,
      toolName: openAiToken,
      agentId: `operator-${githubToken}`,
    });

    expect(presentation).not.toBeNull();
    const serialized = JSON.stringify(presentation);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(openAiToken);
    expect(presentation).toMatchObject({
      kind: "plugin",
      description: expect.stringContaining("Token:\n"),
    });
  });

  it("applies plugin limits by Unicode code point after sanitization", () => {
    const title = String.fromCodePoint(0x1f680).repeat(80);
    const description = String.fromCodePoint(0x1f6e1).repeat(512);

    expect(buildPluginPresentation({ title, description })).toMatchObject({
      kind: "plugin",
      title,
      description,
    });
    expect(
      buildPluginPresentation({
        title: `${title}${String.fromCodePoint(0x1f680)}`,
        description,
      }),
    ).toBeNull();
    expect(
      buildPluginPresentation({
        title,
        description: `${description}${String.fromCodePoint(0x1f6e1)}`,
      }),
    ).toBeNull();
  });
});

describe("buildApprovalPresentation (system-agent)", () => {
  it("drops a split emoji at the title boundary instead of leaving a lone surrogate", () => {
    // 79 ASCII chars + 😀 (U+1F600, two UTF-16 code units) = 81 code units.
    // A raw .slice(0, 80) keeps the lone high surrogate; truncateUtf16Safe backs off.
    const title = `${"a".repeat(79)}\u{1F600}`;
    const presentation = buildSystemAgentPresentation({ title, description: "d" });
    expect(presentation).not.toBeNull();
    expect(LONE_HIGH_SURROGATE.test(presentation?.title ?? "")).toBe(false);
    expect(presentation?.title).toBe("a".repeat(79));
  });

  it("keeps an emoji that fits within the title limit intact", () => {
    // 78 ASCII chars + 😀 = 80 code units, so the emoji fits without truncation.
    const title = `${"a".repeat(78)}\u{1F600}`;
    const presentation = buildSystemAgentPresentation({ title, description: "d" });
    expect(presentation).not.toBeNull();
    expect(LONE_HIGH_SURROGATE.test(presentation?.title ?? "")).toBe(false);
    expect(presentation?.title).toBe(`${"a".repeat(78)}\u{1F600}`);
  });

  it("drops a split emoji at the description boundary instead of leaving a lone surrogate", () => {
    // 511 ASCII chars + 🛡 (U+1F6E1, two UTF-16 code units) = 513 code units.
    const description = `${"a".repeat(511)}\u{1F6E1}`;
    const presentation = buildSystemAgentPresentation({ title: "t", description });
    expect(presentation).not.toBeNull();
    expect(LONE_HIGH_SURROGATE.test(presentation?.description ?? "")).toBe(false);
    expect(presentation?.description).toBe("a".repeat(511));
  });
});
