import { describe, expect, it } from "vitest";
import {
  appendReceivedValueHint,
  attachConfigIssueDiagnostics,
  formatConfigIssuePath,
  parseConfigIssuePath,
  resolveConfigIssueLineInRaw,
} from "./issue-location.js";

describe("formatConfigIssuePath", () => {
  it("formats numeric segments with bracket notation", () => {
    expect(formatConfigIssuePath(["agents", "list", 3, "tools", "profile"])).toBe(
      "agents.list[3].tools.profile",
    );
  });

  it("handles consecutive numeric indices", () => {
    expect(formatConfigIssuePath(["a", 0, "b", 1])).toBe("a[0].b[1]");
  });

  it("returns empty string for empty path", () => {
    expect(formatConfigIssuePath([])).toBe("");
  });

  it("handles all-string path", () => {
    expect(formatConfigIssuePath(["foo", "bar", "baz"])).toBe("foo.bar.baz");
  });
});

describe("parseConfigIssuePath", () => {
  it("parses bracket notation", () => {
    expect(parseConfigIssuePath("agents.list[3].tools.profile")).toEqual([
      "agents",
      "list",
      3,
      "tools",
      "profile",
    ]);
  });

  it("parses legacy dot notation with numericDotSegments", () => {
    expect(
      parseConfigIssuePath("agents.list.3.tools.profile", { numericDotSegments: true }),
    ).toEqual(["agents", "list", 3, "tools", "profile"]);
  });

  it("returns empty for root marker", () => {
    expect(parseConfigIssuePath("<root>")).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(parseConfigIssuePath("")).toEqual([]);
  });

  it("preserves string segments that look like numbers without option", () => {
    expect(parseConfigIssuePath("plugins.entries.123.config")).toEqual([
      "plugins",
      "entries",
      "123",
      "config",
    ]);
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

  it("resolves line number for top-level key", () => {
    const raw = ["{", '  "update": {', '    "channel": "nightly"', "  }", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["update", "channel"])).toBe(3);
  });

  it("returns undefined for path not in raw text", () => {
    const raw = ["{", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["nonexistent"])).toBeUndefined();
  });

  it("handles JSON5 comments", () => {
    const raw = ["{", "  // comment", '  "key": "value"', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(3);
  });

  it("handles single-quoted strings", () => {
    const raw = ["{", "  'key': 'value'", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(2);
  });
});

describe("appendReceivedValueHint", () => {
  it("appends got: for simple values", () => {
    expect(
      appendReceivedValueHint(
        'Invalid input (allowed: "minimal", "coding")',
        "agents.list[0].tools.profile",
        "none",
      ),
    ).toBe('Invalid input (allowed: "minimal", "coding"), got: "none"');
  });

  it("skips when message already mentions received", () => {
    expect(appendReceivedValueHint("expected string, received number", "gateway.port", 18789)).toBe(
      "expected string, received number",
    );
  });

  it("skips sensitive paths", () => {
    expect(appendReceivedValueHint("invalid token", "channels.telegram.botToken", "abc123")).toBe(
      "invalid token",
    );
  });

  it("skips secret ref objects", () => {
    expect(
      appendReceivedValueHint("invalid input", "models.providers.openai.apiKey", {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      }),
    ).toBe("invalid input");
  });

  it("skips object values", () => {
    expect(appendReceivedValueHint("invalid input", "some.path", { nested: true })).toBe(
      "invalid input",
    );
  });

  it("skips undefined values", () => {
    expect(appendReceivedValueHint("invalid input", "some.path", undefined)).toBe("invalid input");
  });

  it("skips when message already has got:", () => {
    expect(appendReceivedValueHint("already got: something", "some.path", "value")).toBe(
      "already got: something",
    );
  });
});

describe("attachConfigIssueDiagnostics", () => {
  const raw = [
    "{",
    '  "agents": {',
    '    "list": [',
    '      { "tools": { "profile": "none" } }',
    "    ]",
    "  }",
    "}",
  ].join("\n");

  const parsed = {
    agents: { list: [{ tools: { profile: "none" } }] },
  };

  it("preserves internal path by default", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "agents.list.0.tools.profile",
          message: 'Invalid input (allowed: "minimal", "coding")',
          allowedValues: ["minimal", "coding"],
        },
      ],
      { raw, parsed, configPath: "/tmp/openclaw.json" },
    );

    expect(issues[0]?.path).toBe("agents.list.0.tools.profile");
    expect(issues[0]?.message).toBe('Invalid input (allowed: "minimal", "coding")');
    expect(issues[0]?.line).toBe(4);
    expect(issues[0]?.sourceFile).toBe("openclaw.json");
  });

  it("formats display path when requested", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "agents.list.0.tools.profile",
          message: 'Invalid input (allowed: "minimal", "coding")',
          allowedValues: ["minimal", "coding"],
        },
      ],
      {
        raw,
        parsed,
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.path).toBe("agents.list[0].tools.profile");
    expect(issues[0]?.message).toContain('got: "none"');
    expect(issues[0]?.line).toBe(4);
  });

  it("handles empty raw gracefully", () => {
    const issues = attachConfigIssueDiagnostics([{ path: "foo", message: "error" }], {
      raw: null,
      parsed: {},
      configPath: "/tmp/openclaw.json",
    });

    expect(issues[0]?.line).toBeUndefined();
    expect(issues[0]?.sourceFile).toBeUndefined();
  });

  it("handles $include'd paths gracefully (navigator returns undefined)", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "models.providers.openai.api",
          message: 'Invalid input (allowed: "openai-chatgpt")',
        },
      ],
      {
        raw: ["{", '  "$include": "./models.json"', "}"].join("\n"),
        parsed: { models: { providers: { openai: { api: "bad" } } } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    // Path exists in parsed but not in raw — no line number, no received value
    expect(issues[0]?.line).toBeUndefined();
    expect(issues[0]?.sourceFile).toBeUndefined();
    expect(issues[0]?.message).toBe('Invalid input (allowed: "openai-chatgpt")');
  });

  it("preserves numeric record keys (not array indices)", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "plugins.entries.123.config.mode",
          message: 'Invalid input (allowed: "good")',
        },
      ],
      {
        raw: [
          "{",
          '  "plugins": {',
          '    "entries": {',
          '      "123": { "config": { "mode": "bad" } }',
          "    }",
          "  }",
          "}",
        ].join("\n"),
        parsed: { plugins: { entries: { "123": { config: { mode: "bad" } } } } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.path).toBe("plugins.entries.123.config.mode");
    expect(issues[0]?.message).toContain('got: "bad"');
    expect(issues[0]?.line).toBe(4);
  });
});
