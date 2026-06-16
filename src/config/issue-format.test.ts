// Covers config validation issue formatting for user-facing output.
import { describe, expect, it } from "vitest";
import {
  formatConfigIssueLine,
  formatConfigIssueLines,
  formatConfigIssueSummary,
  formatConfigPathForDisplay,
  normalizeConfigIssue,
  normalizeConfigIssuePath,
  normalizeConfigIssues,
} from "./issue-format.js";

describe("config issue format", () => {
  it("normalizes empty paths to <root>", () => {
    expect(normalizeConfigIssuePath("")).toBe("<root>");
    expect(normalizeConfigIssuePath("   ")).toBe("<root>");
    expect(normalizeConfigIssuePath(null)).toBe("<root>");
    expect(normalizeConfigIssuePath(undefined)).toBe("<root>");
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

  it("prefers displayPath over path in formatted lines", () => {
    expect(
      formatConfigIssueLine(
        { path: "models.providers.openrouter.models.0.api", displayPath: "models.providers.openrouter.models.#1.api", message: "invalid" },
        "-",
      ),
    ).toBe("- models.providers.openrouter.models.#1.api: invalid");
    expect(
      formatConfigIssueLine(
        { path: "models.providers.openrouter.models.0.api", message: "invalid" },
        "-",
      ),
    ).toBe("- models.providers.openrouter.models.0.api: invalid");
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

  it("converts zero-based numeric array indexes to one-based display paths", () => {
    expect(formatConfigPathForDisplay(null)).toBeNull();
    expect(formatConfigPathForDisplay(undefined)).toBeNull();
    expect(formatConfigPathForDisplay("")).toBeNull();
    expect(formatConfigPathForDisplay("gateway.bind")).toBeNull();
    expect(formatConfigPathForDisplay("models.providers.openrouter.models.0.api")).toBe(
      "models.providers.openrouter.models.#1.api",
    );
    expect(formatConfigPathForDisplay("agents.list.3.model")).toBe(
      "agents.list.#4.model",
    );
    expect(formatConfigPathForDisplay("channels.0")).toBe("channels.#1");
    expect(formatConfigPathForDisplay("a.0.b.1.c")).toBe("a.#1.b.#2.c");
  });

  it("normalizes issue metadata for machine output", () => {
    expect(
      normalizeConfigIssue({
        path: "",
        message: "invalid",
        allowedValues: ["stable", "beta"],
        allowedValuesHiddenCount: 0,
      }),
    ).toEqual({
      path: "<root>",
      message: "invalid",
      allowedValues: ["stable", "beta"],
    });

    expect(
      normalizeConfigIssues([
        {
          path: "update.channel",
          message: "invalid",
          allowedValues: [],
          allowedValuesHiddenCount: 2,
        },
      ]),
    ).toEqual([
      {
        path: "update.channel",
        message: "invalid",
      },
    ]);

    expect(
      normalizeConfigIssue({
        path: "update.channel",
        message: "invalid",
        allowedValues: ["stable"],
        allowedValuesHiddenCount: 2,
      }),
    ).toEqual({
      path: "update.channel",
      message: "invalid",
      allowedValues: ["stable"],
      allowedValuesHiddenCount: 2,
    });
  });

  it("adds displayPath to normalized issues with numeric array indexes", () => {
    expect(
      normalizeConfigIssue({
        path: "models.providers.openrouter.models.0.api",
        message: "invalid option",
      }),
    ).toEqual({
      path: "models.providers.openrouter.models.0.api",
      message: "invalid option",
      displayPath: "models.providers.openrouter.models.#1.api",
    });

    expect(
      normalizeConfigIssue({
        path: "gateway.bind",
        message: "invalid",
      }),
    ).toEqual({
      path: "gateway.bind",
      message: "invalid",
    });
  });
});
