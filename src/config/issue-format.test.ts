// Covers config validation issue formatting for user-facing output.
import { describe, expect, it } from "vitest";
import {
  formatConfigIssueLine,
  formatConfigIssueLines,
  formatConfigIssueSummary,
  normalizeConfigIssues,
} from "./issue-format.js";

describe("config issue format", () => {
  it("formats issue lines with source locations", () => {
    expect(
      formatConfigIssueLine(
        {
          path: "agents.list[3].tools.profile",
          message: 'Invalid input, got: "none"',
          line: 247,
          sourceFile: "openclaw.json",
        },
        "×",
        { normalizeRoot: true },
      ),
    ).toBe('× openclaw.json:247 — agents.list[3].tools.profile: Invalid input, got: "none"');
  });

  it("formats issue lines with and without markers", () => {
    expect(formatConfigIssueLine({ path: "", message: "broken" }, "-")).toBe("- : broken");
    expect(
      formatConfigIssueLine({ path: "", message: "broken" }, "-", { normalizeRoot: true }),
    ).toBe("- <root>: broken");
    expect(formatConfigIssueLine({ path: "gateway.bind", message: "invalid" }, "")).toBe(
      "gateway.bind: invalid",
    );
    expect(
      formatConfigIssueLines(
        [
          { path: "", message: "first" },
          { path: "channels.signal.dmPolicy", message: "second" },
        ],
        "×",
        { normalizeRoot: true },
      ),
    ).toEqual(["× <root>: first", "× channels.signal.dmPolicy: second"]);
  });

  it("sanitizes control characters and ANSI sequences in formatted lines", () => {
    expect(
      formatConfigIssueLine(
        {
          path: "gateway.\nbind\x1b[31m",
          message: "bad\r\n\tvalue\x1b[0m\u0007",
        },
        "-",
      ),
    ).toBe("- gateway.\\nbind: bad\\r\\n\\tvalue");
  });

  it("formats numeric segments by traversing the display root", () => {
    const displayRoot = {
      agents: { list: [{ identity: { avatar: "~/avatar.png" } }] },
      bindings: [{ acp: { agent: "claude" } }],
      diagnostics: { otel: { headers: { "0": false } } },
    };

    expect(
      formatConfigIssueLines(
        [
          { path: "bindings.0.acp", message: "binding union issue" },
          { path: "agents.list.0.identity.avatar", message: "manual issue" },
          { path: "diagnostics.otel.headers.0", message: "numeric object key" },
        ],
        "-",
        { displayRoot },
      ),
    ).toEqual([
      "- bindings[0].acp: binding union issue",
      "- agents.list[0].identity.avatar: manual issue",
      "- diagnostics.otel.headers.0: numeric object key",
    ]);
  });

  it("keeps contract paths dotted when display context is absent", () => {
    const issue = { path: "agents.list.0.identity.avatar", message: "invalid" };

    expect(formatConfigIssueLine(issue, "-")).toBe("- agents.list.0.identity.avatar: invalid");
  });

  it("formats concise issue summaries", () => {
    expect(formatConfigIssueSummary([])).toBeNull();
    expect(
      formatConfigIssueSummary(
        [
          { path: "", message: "root broken" },
          { path: "gateway.auth.password.source", message: "Required" },
          { path: "agents.defaults.execution", message: "Unrecognized key" },
        ],
        { maxIssues: 2 },
      ),
    ).toBe("<root>: root broken; gateway.auth.password.source: Required; and 1 more");
  });

  it("normalizes issue collections for machine output", () => {
    const issues = normalizeConfigIssues([
      {
        path: "update.channel",
        pathSegments: ["update", "channel"],
        message: "invalid",
        allowedValues: [],
        allowedValuesHiddenCount: 2,
      },
    ]);

    expect(issues).toEqual([{ path: "update.channel", message: "invalid" }]);
    expect(issues[0]?.pathSegments).toEqual(["update", "channel"]);
    expect(JSON.stringify(issues)).not.toContain("pathSegments");
  });
});
