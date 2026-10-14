import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { renderConfigValidationIssueLines } from "./issue-location.js";
import type { ConfigFileSnapshot, ConfigValidationIssue } from "./types.js";

type PathSegment = string | number;

function renderIssue(params: {
  issue: ConfigValidationIssue;
  raw: string | null;
  parsed: unknown;
  effective: unknown;
}): string {
  return (
    renderConfigValidationIssueLines(
      {
        issues: [params.issue],
        raw: params.raw,
        parsed: params.parsed,
        sourceConfig: params.effective as ConfigFileSnapshot["sourceConfig"],
        path: "/tmp/openclaw.json",
      },
      "",
    )[0] ?? ""
  );
}

function formatConfigIssuePath(pathSegments: PathSegment[]): string {
  return renderIssue({
    issue: { path: pathSegments.join("."), pathSegments, message: "Invalid input" },
    raw: null,
    parsed: {},
    effective: {},
  }).replace(/: Invalid input$/, "");
}

function resolveConfigIssueLineInRaw(raw: string, pathSegments: PathSegment[]): number | undefined {
  let parsed: unknown = {};
  try {
    parsed = JSON5.parse(raw);
  } catch {
    // Malformed or empty text cannot own a source location.
  }
  const rendered = renderIssue({
    issue: { path: pathSegments.join("."), pathSegments, message: "Invalid input" },
    raw,
    parsed,
    effective: parsed,
  });
  const match = rendered.match(/^openclaw\.json:(\d+) — /);
  return match?.[1] ? Number(match[1]) : undefined;
}

function appendReceivedValueHint(message: string, pathValue: string, value: unknown): string {
  const pathSegments = pathValue.split(".");
  const root: Record<string, unknown> = {};
  let current = root;
  for (const segment of pathSegments.slice(0, -1)) {
    const child: Record<string, unknown> = {};
    current[segment] = child;
    current = child;
  }
  current[pathSegments.at(-1) ?? ""] = value;
  const rendered = renderIssue({
    issue: { path: pathValue, pathSegments, message },
    raw: JSON5.stringify(root),
    parsed: root,
    effective: root,
  });
  const issueText = rendered.split(" — ").at(-1) ?? rendered;
  return issueText.slice(issueText.indexOf(": ") + 2);
}

describe("formatConfigIssuePath", () => {
  it("handles consecutive numeric indices", () => {
    expect(formatConfigIssuePath(["a", 0, "b", 1])).toBe("a[0].b[1]");
  });

  it("normalizes an empty path to the root marker", () => {
    expect(formatConfigIssuePath([])).toBe("<root>");
  });
});

describe("resolveConfigIssueLineInRaw", () => {
  it("resolves line number for nested array object values", () => {
    const raw = [
      "{",
      '  "agents": {',
      '    "list": [',
      "      {",
      '        "id": "main"',
      "      },",
      "      {",
      '        "tools": {',
      '          "profile": "none"',
      "        }",
      "      }",
      "    ]",
      "  }",
      "}",
    ].join("\n");

    expect(resolveConfigIssueLineInRaw(raw, ["agents", "list", 1, "tools", "profile"])).toBe(9);
  });

  it.each<[string, string, string, number]>([
    [
      "handles unicode escape sequences in strings",
      '{\n  "a": "hello \\u0041",\n  "b": 1\n}',
      "b",
      3,
    ],
  ])("%s", (_name, raw, key, expectedLine) => {
    expect(resolveConfigIssueLineInRaw(raw, [key])).toBe(expectedLine);
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
    const message = appendReceivedValueHint(
      "invalid input",
      "gateway.bind",
      `${"x".repeat(155)}🎉tail`,
    );
    expect(message).toBe(`invalid input, got: "${"x".repeat(155)}...`);
  });

  it("skips sensitive paths", () => {
    expect(appendReceivedValueHint("invalid token", "channels.telegram.botToken", "abc123")).toBe(
      "invalid token",
    );
  });

  it("skips object values", () => {
    expect(appendReceivedValueHint("invalid input", "some.path", { nested: true })).toBe(
      "invalid input",
    );
  });

  it.each([
    [Number.NaN, "NaN"],
    [-0, "-0"],
  ])("renders JSON5 number %s without coercing it to null", (value, label) => {
    expect(appendReceivedValueHint("invalid input", "some.path", value)).toBe(
      `invalid input, got: ${label}`,
    );
  });
});

describe("renderConfigValidationIssueLines", () => {
  const issue = (pathSegments: PathSegment[], message: string): ConfigValidationIssue => ({
    path: pathSegments.join("."),
    pathSegments,
    message,
  });

  it.each([
    {
      name: "an object",
      ignoredLines: [
        "  ignored: {",
        '    nested: [{ text: "}, ]", values: [1, {}, []] }],',
        "    // Closing delimiters in this comment: } ]",
        "  },",
      ],
    },
    {
      name: "an array",
      ignoredLines: [
        "  ignored: [",
        '    { nested: [[], { text: "}, ]" }] },',
        "    /* Keep scanning after nested containers. */ {},",
        "  ],",
      ],
    },
  ])("locates the value after skipping $name with mixed nesting", ({ ignoredLines }) => {
    const raw = ["{", ...ignoredLines, '  target: "bad",', "}"].join("\n");
    const config = JSON5.parse(raw);

    expect(
      renderIssue({
        issue: issue(["target"], "Invalid input"),
        raw,
        parsed: config,
        effective: config,
      }),
    ).toBe('openclaw.json:6 — target: Invalid input, got: "bad"');
  });

  it("omits locations and received values for included config", () => {
    const config = { models: { providers: { openai: { api: "bad" } } } };
    expect(
      renderIssue({
        issue: issue(
          ["models", "providers", "openai", "api"],
          'Invalid input (allowed: "openai-chatgpt")',
        ),
        raw: '{ "$include": "./models.json" }',
        parsed: config,
        effective: config,
      }),
    ).toBe('models.providers.openai.api: Invalid input (allowed: "openai-chatgpt")');
  });

  it("omits values changed by environment substitution", () => {
    expect(
      renderIssue({
        issue: issue(["gateway", "bind"], "Invalid input"),
        raw: '{ gateway: { bind: "${BIND}" } }',
        parsed: { gateway: { bind: "${BIND}" } },
        effective: { gateway: { bind: "lan" } },
      }),
    ).toBe("openclaw.json:1 — gateway.bind: Invalid input");
  });

  it.each([["vendor.plugin", 'plugins.entries["vendor.plugin"].config.accessCode']])(
    "omits plugin-owned values for %s",
    (pluginId, displayPath) => {
      const config = {
        plugins: { entries: { [pluginId]: { config: { accessCode: "private" } } } },
      };
      expect(
        renderIssue({
          issue: issue(["plugins", "entries", pluginId, "config", "accessCode"], "Invalid input"),
          raw: JSON5.stringify(config),
          parsed: config,
          effective: config,
        }),
      ).toBe(`openclaw.json:1 — ${displayPath}: Invalid input`);
    },
  );
});
