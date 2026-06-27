/**
 * Tests for tool result error classification, including the sessions_spawn
 * accepted-status guard (#96833).
 */
import { describe, expect, it } from "vitest";
import { isToolResultError } from "./tool-result-error.js";

function result(details: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function resultWithIsError(
  details: Record<string, unknown>,
  isError: boolean,
): Record<string, unknown> {
  return { ...result(details), isError };
}

describe("isToolResultError", () => {
  // ── sessions_spawn accepted guard (#96833) ───────────────────────
  it("returns false for sessions_spawn with status accepted", () => {
    const r = result({
      status: "accepted",
      childSessionKey: "agent:main:subagent:abc",
      runId: "run-123",
      mode: "run",
    });
    expect(isToolResultError(r)).toBe(false);
  });

  it("returns false even when isError:true is present with accepted status", () => {
    // Legacy transcripts may have isError:true persisted alongside
    // status:accepted. The status check takes priority.
    const r = resultWithIsError(
      {
        status: "accepted",
        childSessionKey: "agent:main:subagent:abc",
        runId: "run-456",
        mode: "run",
      },
      true,
    );
    expect(isToolResultError(r)).toBe(false);
  });

  // ── Existing error classification preserved ──────────────────────
  it("returns true for status error", () => {
    expect(isToolResultError(result({ status: "error", error: "boom" }))).toBe(true);
  });

  it("returns true for status forbidden", () => {
    expect(isToolResultError(result({ status: "forbidden" }))).toBe(true);
  });

  it("returns true for non-zero exitCode", () => {
    expect(isToolResultError(result({ exitCode: 1 }))).toBe(true);
  });

  it("returns false for exitCode zero", () => {
    expect(isToolResultError(result({ exitCode: 0 }))).toBe(false);
  });

  it("returns true when details.ok is false", () => {
    expect(isToolResultError(result({ ok: false }))).toBe(true);
  });

  it("returns true when timedOut is true", () => {
    expect(isToolResultError(result({ timedOut: true }))).toBe(true);
  });

  it("returns false for a plain successful result", () => {
    expect(isToolResultError(result({}))).toBe(false);
  });
});
