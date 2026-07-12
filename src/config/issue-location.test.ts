import { describe, expect, it } from "vitest";
import {
  appendReceivedValueHint,
  attachConfigIssueDiagnostics,
  formatConfigIssuePath,
  parseConfigIssuePath,
  resolveConfigIssueLineInRaw,
} from "./issue-location.js";

describe("config issue location", () => {
  it("formats array indexes with bracket notation", () => {
    expect(formatConfigIssuePath(["agents", "list", 3, "tools", "profile"])).toBe(
      "agents.list[3].tools.profile",
    );
    expect(formatConfigIssuePath([])).toBe("");
  });

  it("parses formatted issue paths back into traversal segments", () => {
    expect(parseConfigIssuePath("agents.list[3].tools.profile")).toEqual([
      "agents",
      "list",
      3,
      "tools",
      "profile",
    ]);
    expect(
      parseConfigIssuePath("agents.list.3.tools.profile", { numericDotSegments: true }),
    ).toEqual(["agents", "list", 3, "tools", "profile"]);
    expect(parseConfigIssuePath("<root>")).toEqual([]);
  });

  it("resolves source line numbers for nested array object values", () => {
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

    const line = resolveConfigIssueLineInRaw(
      raw,
      ["agents", "list", 1, "tools", "profile"],
      "none",
    );
    expect(line).toBe(9);
  });

  it("appends received values when safe and not already present", () => {
    expect(
      appendReceivedValueHint(
        'Invalid input (allowed: "minimal", "coding")',
        "agents.list[0].tools.profile",
        "none",
      ),
    ).toBe('Invalid input (allowed: "minimal", "coding"), got: "none"');
    expect(appendReceivedValueHint("expected string, received number", "gateway.port", 18789)).toBe(
      "expected string, received number",
    );
    expect(appendReceivedValueHint("invalid token", "channels.telegram.botToken", "abc")).toBe(
      "invalid token",
    );
    expect(appendReceivedValueHint("invalid env", "localService.env.PUBLIC_NAME", "abc")).toBe(
      "invalid env",
    );
  });

  it("attaches line numbers without changing public issue path or message by default", () => {
    const raw = ["{", '  "update": {', '    "channel": "nightly"', "  }", "}"].join("\n");
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "update.channel",
          message: 'Invalid input (allowed: "stable", "beta")',
          allowedValues: ["stable", "beta"],
        },
      ],
      {
        raw,
        parsed: { update: { channel: "nightly" } },
        configPath: "/tmp/openclaw.json",
      },
    );

    expect(issues[0]?.path).toBe("update.channel");
    expect(issues[0]?.message).toBe('Invalid input (allowed: "stable", "beta")');
    expect(issues[0]?.line).toBe(3);
    expect(issues[0]?.sourceFile).toBe("openclaw.json");
  });

  it("can attach CLI display diagnostics with received values and bracket paths", () => {
    const raw = [
      "{",
      '  "agents": {',
      '    "list": [',
      '      { "tools": { "profile": "none" } }',
      "    ]",
      "  }",
      "}",
    ].join("\n");
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
        parsed: { agents: { list: [{ tools: { profile: "none" } }] } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.path).toBe("agents.list[0].tools.profile");
    expect(issues[0]?.message).toContain('got: "none"');
    expect(issues[0]?.line).toBe(4);
  });

  it("preserves numeric record keys when formatting display paths", () => {
    const raw = [
      "{",
      '  "plugins": {',
      '    "entries": {',
      '      "123": { "config": { "mode": "bad" } }',
      "    }",
      "  }",
      "}",
    ].join("\n");
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "plugins.entries.123.config.mode",
          message: 'Invalid input (allowed: "good")',
        },
      ],
      {
        raw,
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

  it("omits source and received-value diagnostics when includes may own the value", () => {
    const raw = [
      "{",
      '  "$include": "./models.json",',
      '  "update": { "channel": "stable" }',
      "}",
    ].join("\n");
    const issues = attachConfigIssueDiagnostics(
      [
        {
          path: "models.providers.openai.api",
          message: 'Invalid input (allowed: "openai-chatgpt")',
        },
      ],
      {
        raw,
        parsed: { models: { providers: { openai: { api: "bad" } } } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.path).toBe("models.providers.openai.api");
    expect(issues[0]?.message).toBe('Invalid input (allowed: "openai-chatgpt")');
    expect(issues[0]?.line).toBeUndefined();
    expect(issues[0]?.sourceFile).toBeUndefined();
  });
});
