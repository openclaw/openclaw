import { describe, expect, it } from "vitest";
import {
  admitCanonicalSessionEntry,
  parseCanonicalSqliteSessionEntry,
} from "./session-entry-json.js";

describe("canonical session numeric metadata", () => {
  it.each([
    { field: "spawnDepth", value: "2" },
    { field: "inputTokens", value: "12" },
    { field: "queueCap", value: false },
    { field: "runtimeMs", value: null },
  ])("rejects malformed $field before publishing a session entry", ({ field, value }) => {
    expect(() =>
      parseCanonicalSqliteSessionEntry({
        current_session_id: "session",
        entry_json: JSON.stringify({ sessionId: "session", updatedAt: 1, [field]: value }),
      }),
    ).toThrow(`Session field "${field}" must be a finite number`);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-finite in-memory metadata %s at unknown admission",
    (estimatedCostUsd) => {
      expect(() =>
        admitCanonicalSessionEntry({ sessionId: "session", updatedAt: 1, estimatedCostUsd }),
      ).toThrow('Session field "estimatedCostUsd" must be a finite number');
    },
  );

  it("returns admitted numeric fields for persisted JSON reads", () => {
    const entry = parseCanonicalSqliteSessionEntry({
      current_session_id: "session",
      updated_at: 1,
      entry_json: JSON.stringify({
        sessionId: "session",
        updatedAt: 1,
        spawnDepth: 2,
        inputTokens: 0,
        sessionFile: "retired.jsonl",
        extension: { untouched: true },
      }),
    });

    expect(entry).toEqual({
      sessionId: "session",
      updatedAt: 1,
      spawnDepth: 2,
      inputTokens: 0,
      extension: { untouched: true },
    });
    expect((entry?.spawnDepth ?? 0) + 1).toBe(3);
  });

  it("preserves zero, fractional numeric metadata, and optional field presence", () => {
    const projected = admitCanonicalSessionEntry({
      sessionId: "session",
      updatedAt: 1,
      spawnDepth: 0,
      estimatedCostUsd: 0.25,
      runtimeMs: undefined,
    });

    expect(projected.spawnDepth).toBe(0);
    expect(projected.estimatedCostUsd).toBe(0.25);
    expect(Object.hasOwn(projected, "runtimeMs")).toBe(true);
    expect(Object.hasOwn(projected, "queueCap")).toBe(false);
    expect((projected.spawnDepth ?? 0) + 1).toBe(1);
  });

  it("preserves extension payloads while normalizing existing retired fields", () => {
    const extension = { custom: { count: "not a canonical numeric field" } };
    const projected = admitCanonicalSessionEntry({
      sessionId: "session",
      updatedAt: 1,
      spawnDepth: 2,
      extension,
      sessionFile: "retired.jsonl",
      snoozedUntil: "invalid legacy snooze",
      snoozedAt: "invalid legacy snooze",
    });

    expect(projected).toMatchObject({ sessionId: "session", spawnDepth: 2, extension });
    expect(projected).not.toHaveProperty("sessionFile");
    expect(projected).not.toHaveProperty("snoozedUntil");
    expect(projected).not.toHaveProperty("snoozedAt");
    expect((projected.spawnDepth ?? 0) + 1).toBe(3);
  });
});
