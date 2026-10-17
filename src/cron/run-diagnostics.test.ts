import { describe, expect, it } from "vitest";
import {
  createCronRunDiagnosticsFromMissingWebSearchProvider,
  createCronRunDiagnosticsFromAgentResult,
  createCronRunDiagnosticsFromError,
  mergeCronRunDiagnostics,
  normalizeCronRunDiagnostics,
  summarizeCronRunDiagnostics,
} from "./run-diagnostics.js";
import type { CronRunDiagnostic } from "./types.js";

const MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE =
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
    const diagnostics = normalizeCronRunDiagnostics({
      summary: "x".repeat(2_100),
      entries: Array.from({ length: 12 }, (_, i) => ({
        ts: i,
        source: "exec",
        severity: "error",
        message: i === 11 ? `secret sk-1234567890abcdef ${"a".repeat(1_100)}` : `entry ${i}`,
      })),
    });

    expect(diagnostics?.entries).toHaveLength(10);
    expect(diagnostics?.entries[0]?.message).toBe("entry 2");
    expect(diagnostics?.entries.at(-1)?.message.endsWith("…")).toBe(true);
    expect(diagnostics?.entries.at(-1)?.message).not.toContain("sk-1234567890abcdef");
    expect(diagnostics?.entries.at(-1)?.truncated).toBe(true);
    expect(diagnostics?.summary).toHaveLength(2_000);
  });

  it("preserves later terminal diagnostics when capping entries", () => {
    const terminal = { ts: 11, source: "delivery", severity: "error", message: "delivery failed" };
    const diagnostics = normalizeCronRunDiagnostics({
      entries: [
        ...Array.from({ length: 10 }, (_, i) => ({
          ts: i,
          source: "tool",
          severity: "warn",
          message: `tool warning ${i}`,
        })),
        terminal,
      ],
    });

    expect(diagnostics?.entries).toHaveLength(10);
    expect(diagnostics?.entries.map((item) => item.message)).not.toContain("tool warning 0");
    expect(diagnostics?.entries.at(-1)).toEqual(terminal);
  });

  it("returns undefined for empty diagnostics", () => {
    expect(normalizeCronRunDiagnostics({ entries: [] })).toBeUndefined();
    expect(normalizeCronRunDiagnostics({ entries: [{ source: "exec" }] })).toBeUndefined();
    expect(summarizeCronRunDiagnostics(undefined)).toBeUndefined();
  });

  it("bounds fallback summaries at valid UTF-16 boundaries", () => {
    expect(
      summarizeCronRunDiagnostics({
        entries: [
          {
            ts: 1,
            source: "exec",
            severity: "error",
            message: `${"s".repeat(1_998)}😀tail`,
          },
        ],
      }),
    ).toBe(`${"s".repeat(1_998)}…`);
  });

  it("creates diagnostics from errors and prefers the latest error summary", () => {
    const first = createCronRunDiagnosticsFromError("cron-preflight", "first failure", {
      nowMs: () => 100,
    });
    const second = createCronRunDiagnosticsFromError("delivery", new Error("delivery failed"), {
      nowMs: () => 200,
    });

    const merged = mergeCronRunDiagnostics(first, second);
    expect(merged?.summary).toBe("delivery failed");
    expect(merged?.entries.map((item) => item.message)).toEqual([
      "first failure",
      "delivery failed",
    ]);
    expect(summarizeCronRunDiagnostics(merged)).toBe("delivery failed");
  });

  it("warns when cron toolsAllow requests web_search without a provider", () => {
    const diagnostics = createCronRunDiagnosticsFromMissingWebSearchProvider({
      toolsAllow: ["web_*"],
      hasWebSearchProvider: false,
      nowMs: () => 900,
    });

    expect(diagnostics).toEqual({
      summary: MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
      entries: [
        entry(MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE, {
          ts: 900,
          source: "cron-preflight",
          severity: "warn",
          toolName: "web_search",
        }),
      ],
    });
  });

  it("does not warn for wildcard toolsAllow or configured web_search providers", () => {
    expect(
      createCronRunDiagnosticsFromMissingWebSearchProvider({
        toolsAllow: ["*"],
        hasWebSearchProvider: false,
      }),
    ).toBeUndefined();
    expect(
      createCronRunDiagnosticsFromMissingWebSearchProvider({
        toolsAllow: ["web_search"],
        hasWebSearchProvider: true,
      }),
    ).toBeUndefined();
  });

  it("extracts fatal agent result payloads and meta errors", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
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

  it("warns on an unresolved exec call even when the assistant replied normally", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
      {
        payloads: [{ text: "RESULT: the command did not run" }],
        meta: {
          toolSummary: {
            calls: 1,
            tools: ["exec"],
            failures: 1,
            unresolvedError: { toolName: "exec" },
          },
        },
      },
      { ...fixedClock, finalStatus: "ok" },
    );

    expect(diagnostics).toEqual({
      summary: "exec tool failed",
      entries: [entry("exec tool failed", { source: "exec", severity: "warn" })],
    });
  });

  it("does not duplicate a recorded exec error or report unrelated tools", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
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
      createCronRunDiagnosticsFromAgentResult({
        meta: { toolSummary: { unresolvedError: { toolName: "read" } } },
      }),
    ).toBeUndefined();
  });

  it("prefers a terminal tool failure over a generic failed-tool payload", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
      {
        ...terminalResult(),
        payloads: [{ text: "⚠️ Exec failed", isError: true, toolName: "exec" }],
      },
      fixedClock,
    );

    expect(diagnostics?.summary).toBe(terminalMessage);
    expect(diagnostics?.entries).toEqual([entry("⚠️ Exec failed"), entry(terminalMessage)]);
  });

  it("downgrades a recovered terminal tool failure to a warning", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(terminalResult(), {
      ...fixedClock,
      finalStatus: "ok",
    });

    expect(diagnostics).toEqual({
      summary: terminalMessage,
      entries: [entry(terminalMessage, { severity: "warn" })],
    });
  });

  it("reconstructs a safe diagnostic from terminal tool metadata", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
      terminalResult({ message: "private-path /home/operator/.config/token" }),
      fixedClock,
    );

    expect(diagnostics).toEqual({
      summary: terminalMessage,
      entries: [entry(terminalMessage)],
    });
  });

  it("keeps failed exec output tails valid at UTF-16 boundaries", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
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

    expect(createCronRunDiagnosticsFromAgentResult(result)).toBeUndefined();
    expect(
      createCronRunDiagnosticsFromAgentResult(result, { finalStatus: "error" }),
    ).toBeUndefined();
  });

  it("downgrades recovered tool errors for successful runs", () => {
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
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
    const diagnostics = createCronRunDiagnosticsFromAgentResult(
      execResult({ status: "completed", exitCode: 2 }),
      { nowMs: () => 500 },
    );

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
