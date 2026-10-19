import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { renderConfigValidationIssueLines } from "./issue-location.js";
import type { ConfigFileSnapshot } from "./types.js";

type PathSegment = string | number;

function renderIssue(
  pathSegments: PathSegment[],
  options: { raw?: string | null; parsed?: unknown; effective?: unknown; message?: string } = {},
): string {
  const { raw = null, parsed = {}, effective = parsed, message = "Invalid input" } = options;
  return (
    renderConfigValidationIssueLines(
      {
        issues: [{ path: pathSegments.join("."), pathSegments, message }],
        raw,
        parsed,
        sourceConfig: effective as ConfigFileSnapshot["sourceConfig"],
        path: "/tmp/openclaw.json",
      },
      "",
    )[0] ?? ""
  );
}

function resolveConfigIssueLineInRaw(raw: string, pathSegments: PathSegment[]): number | undefined {
  let parsed: unknown = {};
  try {
    parsed = JSON5.parse(raw);
  } catch {
    // Malformed or empty text cannot own a source location.
  }
  const match = renderIssue(pathSegments, { raw, parsed }).match(/^openclaw\.json:(\d+) — /);
  return match?.[1] ? Number(match[1]) : undefined;
}

function receivedHint(value: unknown, pathValue = "some.path", message = "invalid input"): string {
  const pathSegments = pathValue.split(".");
  let root: unknown = value;
  for (const segment of pathSegments.toReversed()) {
    root = { [segment]: root };
  }
  const rendered = renderIssue(pathSegments, { message, raw: JSON5.stringify(root), parsed: root });
  const issueText = rendered.split(" — ").at(-1) ?? rendered;
  return issueText.slice(issueText.indexOf(": ") + 2);
}

describe("formatConfigIssuePath", () => {
  it("handles consecutive numeric indices", () => {
    expect(renderIssue(["a", 0, "b", 1])).toBe("a[0].b[1]: Invalid input");
  });

  it("normalizes an empty path to the root marker", () => {
    expect(renderIssue([])).toBe("<root>: Invalid input");
  });
});

describe("resolveConfigIssueLineInRaw", () => {
  it("resolves line number for nested array object values", () => {
    const raw = [
      '{ "agents": { "list": [',
      '  { "id": "main" },',
      '  { "tools": {',
      '    "profile": "none"',
      "  } }",
      "] } }",
    ].join("\n");

    expect(resolveConfigIssueLineInRaw(raw, ["agents", "list", 1, "tools", "profile"])).toBe(4);
  });

  it("handles unicode escape sequences in strings", () => {
    expect(resolveConfigIssueLineInRaw('{\n  "a": "hello \\u0041",\n  "b": 1\n}', ["b"])).toBe(3);
  });

  it("handles deeply nested arrays", () => {
    const raw = ["{", '  "a": { "b": { "c": [1, [2, [3]]] } } }', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a", "b", "c", 1, 0])).toBe(2);
  });

  it("gracefully degrades for unresolvable paths", () => {
    const raw = ["{", '  "a": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["nonexistent"])).toBeUndefined();
    expect(resolveConfigIssueLineInRaw(raw, ["a", "b"])).toBeUndefined();
    expect(resolveConfigIssueLineInRaw(raw, ["a", 0])).toBeUndefined();
  });

  it("handles empty raw text", () => {
    expect(resolveConfigIssueLineInRaw("", ["a"])).toBeUndefined();
    expect(resolveConfigIssueLineInRaw("  ", ["a"])).toBeUndefined();
  });
});

describe("appendReceivedValueHint", () => {
  it("keeps truncated received values on a valid UTF-16 boundary", () => {
    const message = receivedHint(`${"x".repeat(155)}🎉tail`, "gateway.bind");
    expect(message).toBe(`invalid input, got: "${"x".repeat(155)}...`);
  });

  it("skips sensitive paths", () => {
    expect(receivedHint("abc123", "channels.telegram.botToken", "invalid token")).toBe(
      "invalid token",
    );
  });

  it("skips object values", () => {
    expect(receivedHint({ nested: true })).toBe("invalid input");
  });

  it.each([
    [Number.NaN, "NaN"],
    [-0, "-0"],
  ])("renders JSON5 number %s without coercing it to null", (value, label) => {
    expect(receivedHint(value)).toBe(`invalid input, got: ${label}`);
  });
});

describe("renderConfigValidationIssueLines", () => {
  it.each([
    [
      "an object",
      [
        "  ignored: {",
        '    nested: [{ text: "}, ]", values: [1, {}, []] }],',
        "    // Closing delimiters in this comment: } ]",
        "  },",
      ],
    ],
    [
      "an array",
      [
        "  ignored: [",
        '    { nested: [[], { text: "}, ]" }] },',
        "    /* Keep scanning after nested containers. */ {},",
        "  ],",
      ],
    ],
  ] as const)("locates the value after skipping %s with mixed nesting", (_name, ignoredLines) => {
    const raw = ["{", ...ignoredLines, '  target: "bad",', "}"].join("\n");
    expect(renderIssue(["target"], { raw, parsed: JSON5.parse(raw) })).toBe(
      'openclaw.json:6 — target: Invalid input, got: "bad"',
    );
  });

  it("omits locations and received values for included config", () => {
    const config = { models: { providers: { openai: { api: "bad" } } } };
    expect(
      renderIssue(["models", "providers", "openai", "api"], {
        message: 'Invalid input (allowed: "openai-chatgpt")',
        raw: '{ "$include": "./models.json" }',
        parsed: config,
      }),
    ).toBe('models.providers.openai.api: Invalid input (allowed: "openai-chatgpt")');
  });

  it("omits values changed by environment substitution", () => {
    expect(
      renderIssue(["gateway", "bind"], {
        raw: '{ gateway: { bind: "${BIND}" } }',
        parsed: { gateway: { bind: "${BIND}" } },
        effective: { gateway: { bind: "lan" } },
      }),
    ).toBe("openclaw.json:1 — gateway.bind: Invalid input");
  });

  it("omits plugin-owned values for vendor.plugin", () => {
    const config = {
      plugins: { entries: { "vendor.plugin": { config: { accessCode: "private" } } } },
    };
    expect(
      renderIssue(["plugins", "entries", "vendor.plugin", "config", "accessCode"], {
        raw: JSON5.stringify(config),
        parsed: config,
      }),
    ).toBe('openclaw.json:1 — plugins.entries["vendor.plugin"].config.accessCode: Invalid input');
  });
});
