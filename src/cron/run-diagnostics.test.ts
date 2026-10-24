import { describe, expect, it } from "vitest";
import {
  createCronRunDiagnosticsFromMissingWebSearchProvider as missingWebSearchProvider,
  createCronRunDiagnosticsFromAgentResult as diagnosticsFromResult,
  createCronRunDiagnosticsFromError as diagnosticsFromError,
  mergeCronRunDiagnostics as mergeDiagnostics,
  normalizeCronRunDiagnostics as normalizeDiagnostics,
  summarizeCronRunDiagnostics as summarizeDiagnostics,
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

describe("cron run diagnostics", () => {
  it("normalizes and bounds diagnostic entries", () => {
    const diagnostics = normalizeDiagnostics({
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
    expect(diagnostics?.entries.at(-1)?.message.endsWith("…")).toBe(true);
    expect(diagnostics?.entries.at(-1)?.message).not.toContain("sk-1234567890abcdef");
    expect(diagnostics?.entries.at(-1)?.truncated).toBe(true);
    expect(diagnostics?.entries.at(-1)).toMatchObject({ source: "delivery", severity: "error" });
    expect(diagnostics?.summary).toHaveLength(2_000);
  });

  it("returns undefined for empty diagnostics", () => {
    expect(normalizeDiagnostics({ entries: [] })).toBeUndefined();
    expect(normalizeDiagnostics({ entries: [{ source: "exec" }] })).toBeUndefined();
    expect(summarizeDiagnostics(undefined)).toBeUndefined();
  });

  it("bounds fallback summaries at valid UTF-16 boundaries", () => {
    expect(
      summarizeDiagnostics({
        entries: [entry(`${"s".repeat(1_998)}😀tail`, { ts: 1, source: "exec" })],
      }),
    ).toBe(`${"s".repeat(1_998)}…`);
  });

  it("creates diagnostics from errors and prefers the latest error summary", () => {
    const first = diagnosticsFromError("cron-preflight", "first failure", {
      nowMs: () => 100,
    });
    const second = diagnosticsFromError("delivery", new Error("delivery failed"), {
      nowMs: () => 200,
    });

    const merged = mergeDiagnostics(first, second);
    expect(merged).toMatchObject({
      summary: "delivery failed",
      entries: [{ message: "first failure" }, { message: "delivery failed" }],
    });
    expect(summarizeDiagnostics(merged)).toBe("delivery failed");
  });

  it("warns when cron toolsAllow requests web_search without a provider", () => {
    const diagnostics = missingWebSearchProvider({
      toolsAllow: ["web_*"],
      hasWebSearchProvider: false,
      nowMs: () => 900,
    });

    expect(diagnostics).toEqual({
      summary: webSearchWarning,
      entries: [
        entry(webSearchWarning, {
          ts: 900,
          source: "cron-preflight",
          severity: "warn",
          toolName: "web_search",
        }),
      ],
    });
  });

  it("does not warn for an unrestricted tools policy", () => {
    expect(
      missingWebSearchProvider({ toolsAllow: ["*"], hasWebSearchProvider: false }),
    ).toBeUndefined();
  });

  it("extracts fatal agent result payloads and meta errors", () => {
    const diagnostics = diagnosticsFromResult(
      {
        payloads: [
          { text: "normal" },
          { text: "tool stderr", isError: true, toolName: "shell" },
          {
            toolName: "exec",
            details: {
              status: "completed",
              exitCode: 2,
              aggregated: "stdout\nstderr failure",
            },
          },
        ],
        meta: {
          error: { kind: "retry_limit", message: "retry limit exceeded" },
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
    const diagnostics = diagnosticsFromResult(
      {
        payloads: [{ text: "exec parameter invalid", isError: true, toolName: "exec" }],
        meta: {
          toolSummary: { unresolvedError: { toolName: "exec" } },
        },
      },
      { ...fixedClock, finalStatus: "ok" },
    );
    expect(diagnostics?.entries).toHaveLength(1);
    expect(
      diagnosticsFromResult({
        meta: { toolSummary: { unresolvedError: { toolName: "read" } } },
      }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "downgrades recovered terminal failures",
      result: terminalResult(),
      finalStatus: "ok",
      entries: [entry(terminalMessage, { severity: "warn" })],
    },
    {
      name: "reconstructs safe diagnostics from private terminal metadata",
      result: terminalResult({ message: "private-path /home/operator/.config/token" }),
      finalStatus: undefined,
      entries: [entry(terminalMessage)],
    },
  ] as const)("$name", ({ result, finalStatus, entries }) => {
    expect(diagnosticsFromResult(result, { ...fixedClock, finalStatus })).toEqual({
      summary: terminalMessage,
      entries,
    });
  });

  it("keeps failed exec output tails valid at UTF-16 boundaries", () => {
    const diagnostics = diagnosticsFromResult(
      execResult({ status: "completed", exitCode: 2, aggregated: `x😀${"y".repeat(1_999)}` }),
      fixedClock,
    );

    expect(diagnostics?.summary).toBe("y".repeat(1_999));
    expect(diagnostics?.entries[0]?.message).toBe(`${"y".repeat(999)}…`);
  });

  it("does not capture harmless successful exec output", () => {
    const result = execResult({
      status: "completed",
      exitCode: 0,
      aggregated: "progress written to stderr",
    });

    expect(diagnosticsFromResult(result)).toBeUndefined();
    expect(diagnosticsFromResult(result, { finalStatus: "error" })).toBeUndefined();
  });

  it("downgrades recovered tool errors for successful runs", () => {
    const diagnostics = diagnosticsFromResult(
      execResult(
        { status: "failed", exitCode: 1, aggregated: "jq syntax error" },
        { text: "⚠️ 🛠️ jq -s '{total:length}' (agent) failed", isError: true },
      ),
      { finalStatus: "ok", nowMs: () => 800 },
    );

    expect(diagnostics?.entries).toEqual([
      entry("jq syntax error", { ts: 800, source: "exec", severity: "warn", exitCode: 1 }),
      entry("⚠️ 🛠️ jq -s '{total:length}' (agent) failed", { ts: 800, severity: "warn" }),
    ]);
    expect(diagnostics?.summary).toBe("⚠️ 🛠️ jq -s '{total:length}' (agent) failed");
  });

  it("captures silent failed exec details with a fallback message", () => {
    const diagnostics = diagnosticsFromResult(execResult({ status: "completed", exitCode: 2 }), {
      nowMs: () => 500,
    });

    expect(diagnostics?.entries).toEqual([
      entry("exec failed with exit code 2", {
        ts: 500,
        source: "exec",
        severity: "warn",
        exitCode: 2,
      }),
    ]);
  });
});
