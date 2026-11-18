import { describe, expect, it } from "vitest";
import {
  createCronRunDiagnosticsFromMissingWebSearchProvider as webSearchWarningFor,
  createCronRunDiagnosticsFromAgentResult as extract,
  createCronRunDiagnosticsFromError as fromError,
  mergeCronRunDiagnostics as merge,
  normalizeCronRunDiagnostics as normalize,
  summarizeCronRunDiagnostics as summarize,
} from "./run-diagnostics.js";
import type { CronRunDiagnostic } from "./types.js";

const webSearchWarning =
  "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.";
const terminalMessage = "Code Mode could not resolve a configured MCP tool.";
const fixedClock = { nowMs: () => 123 };

function entry(message: string, overrides: Partial<CronRunDiagnostic> = {}): CronRunDiagnostic {
  return { ts: 123, source: "tool", severity: "error", message, toolName: "exec", ...overrides };
}

function execResult(details: Record<string, unknown>, payload: Record<string, unknown> = {}) {
  return { payloads: [{ toolName: "exec", details, ...payload }] };
}

function terminalResult(extra: Record<string, unknown> = {}) {
  return {
    meta: {
      terminalToolFailure: { source: "tool", toolName: "exec", code: "UNKNOWN_TOOL_ID", ...extra },
    },
  };
}

function diagnostic(message: string, overrides: Partial<CronRunDiagnostic> = {}) {
  return { summary: message, entries: [entry(message, overrides)] };
}

describe("cron run diagnostics", () => {
  it("normalizes and bounds diagnostic entries", () => {
    const diagnostics = normalize({
      summary: "x".repeat(2_100),
      entries: Array.from({ length: 12 }, (_, i) => ({
        ts: i,
        source: i === 11 ? "delivery" : "exec",
        severity: i === 11 ? "error" : "warn",
        message: i === 11 ? `secret sk-1234567890abcdef ${"a".repeat(1_100)}` : `entry ${i}`,
      })),
    });

    expect(diagnostics?.entries).toHaveLength(10);
    expect(diagnostics?.entries[0]?.message).toBe("entry 2");
    expect(diagnostics?.entries.at(-1)).toMatchObject({
      source: "delivery",
      severity: "error",
      truncated: true,
      message: expect.stringMatching(/…$/),
    });
    expect(diagnostics?.entries.at(-1)?.message).not.toContain("sk-1234567890abcdef");
    expect(diagnostics?.summary).toHaveLength(2_000);
  });

  it("returns undefined for empty diagnostics", () => {
    expect(normalize({ entries: [] })).toBeUndefined();
    expect(normalize({ entries: [{ source: "exec" }] })).toBeUndefined();
    expect(summarize(undefined)).toBeUndefined();
  });

  it("bounds fallback summaries at valid UTF-16 boundaries", () => {
    expect(summarize({ entries: [entry(`${"s".repeat(1_998)}😀tail`)] })).toBe(
      `${"s".repeat(1_998)}…`,
    );
  });

  it("creates diagnostics from errors and prefers the latest error summary", () => {
    const merged = merge(
      fromError("cron-preflight", "first failure", { nowMs: () => 100 }),
      fromError("delivery", new Error("delivery failed"), { nowMs: () => 200 }),
    );
    expect(merged).toMatchObject({
      summary: "delivery failed",
      entries: [{ message: "first failure" }, { message: "delivery failed" }],
    });
    expect(summarize(merged)).toBe("delivery failed");
  });

  it.each(["web_*", "*"])("warns only for explicit web search policy %s", (tool) => {
    expect(
      webSearchWarningFor({ toolsAllow: [tool], hasWebSearchProvider: false, ...fixedClock }),
    ).toEqual(
      tool === "*"
        ? undefined
        : diagnostic(webSearchWarning, {
            source: "cron-preflight",
            severity: "warn",
            toolName: "web_search",
          }),
    );
  });

  it("extracts fatal agent result payloads and meta errors", () => {
    const diagnostics = extract(
      {
        payloads: [
          { text: "normal" },
          { text: "tool stderr", isError: true, toolName: "shell" },
          {
            toolName: "exec",
            details: { status: "completed", exitCode: 2, aggregated: "stdout\nstderr failure" },
          },
        ],
        meta: {
          error: { message: "retry limit exceeded" },
          failureSignal: { message: "SYSTEM_RUN_DENIED" },
        },
      },
      fixedClock,
    );

    expect(diagnostics?.entries.map((item) => item.message)).toEqual([
      "tool stderr",
      "stdout\nstderr failure",
      "retry limit exceeded",
      "SYSTEM_RUN_DENIED",
    ]);
    expect(diagnostics?.entries[1]).toEqual(
      entry("stdout\nstderr failure", { source: "exec", severity: "warn", exitCode: 2 }),
    );
  });

  it("does not duplicate a recorded exec error or report unrelated tools", () => {
    const diagnostics = extract(
      {
        payloads: [{ text: "exec parameter invalid", isError: true, toolName: "exec" }],
        meta: { toolSummary: { unresolvedError: { toolName: "exec" } } },
      },
      { ...fixedClock, finalStatus: "ok" },
    );
    expect(diagnostics?.entries).toHaveLength(1);
    expect(
      extract({
        meta: { toolSummary: { unresolvedError: { toolName: "read" } } },
      }),
    ).toBeUndefined();
  });

  it.each(["ok", undefined] as const)(
    "sanitizes terminal metadata with final status %s",
    (finalStatus) => {
      expect(
        extract(terminalResult({ message: "private-path /home/operator/.config/token" }), {
          ...fixedClock,
          finalStatus,
        }),
      ).toEqual(diagnostic(terminalMessage, { severity: finalStatus === "ok" ? "warn" : "error" }));
    },
  );

  it("keeps failed exec output tails valid at UTF-16 boundaries", () => {
    const diagnostics = extract(
      execResult({ status: "completed", exitCode: 2, aggregated: `x😀${"y".repeat(1_999)}` }),
      fixedClock,
    );

    expect(diagnostics?.summary).toBe("y".repeat(1_999));
    expect(diagnostics?.entries[0]?.message).toBe(`${"y".repeat(999)}…`);
  });

  it("does not capture harmless successful exec output", () => {
    const result = execResult({ status: "completed", exitCode: 0, aggregated: "stderr" });

    expect(extract(result)).toBeUndefined();
    expect(extract(result, { finalStatus: "error" })).toBeUndefined();
  });

  it("downgrades recovered tool errors for successful runs", () => {
    const message = "tool failed";
    const diagnostics = extract(
      execResult(
        { status: "failed", exitCode: 1, aggregated: "jq syntax error" },
        { text: message, isError: true },
      ),
      { ...fixedClock, finalStatus: "ok" },
    );

    expect(diagnostics?.entries).toEqual([
      entry("jq syntax error", { source: "exec", severity: "warn", exitCode: 1 }),
      entry(message, { severity: "warn" }),
    ]);
    expect(diagnostics?.summary).toBe(message);
  });

  it("captures silent failed exec details with a fallback message", () => {
    expect(extract(execResult({ status: "completed", exitCode: 2 }), fixedClock)).toEqual(
      diagnostic("exec failed with exit code 2", { source: "exec", severity: "warn", exitCode: 2 }),
    );
  });
});
