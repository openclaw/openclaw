// Session migration tests cover doctor legacy config migration for zero-duration pruneAfter.
import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

describe("session.maintenance.pruneAfter zero-duration migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION.find(
    (m) => m.id === "session.maintenance.pruneAfter-zero",
  );
  if (!migration) {
    throw new Error("session.maintenance.pruneAfter-zero migration not found");
  }
  const rule = migration.legacyRules?.[0];
  if (!rule) {
    throw new Error("session.maintenance.pruneAfter-zero rule not found");
  }

  // ── Rule match (doctor detection): parser-backed ────────────

  it("detects literal zero strings", () => {
    expect(rule.match?.({ pruneAfter: "0h" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ pruneAfter: "0d" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ pruneAfter: "0ms" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("detects bare-number zero", () => {
    expect(rule.match?.({ pruneAfter: "0" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("detects zero in other units", () => {
    expect(rule.match?.({ pruneAfter: "0s" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ pruneAfter: "0m" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("detects decimal zero", () => {
    expect(rule.match?.({ pruneAfter: "0.0h" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("detects composite zero", () => {
    expect(rule.match?.({ pruneAfter: "0h0m" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ pruneAfter: "0h0m0s" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("does not match positive durations", () => {
    expect(rule.match?.({ pruneAfter: "30d" }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ pruneAfter: "24h" }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ pruneAfter: "7d" }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ pruneAfter: "500ms" }, {} as Record<string, unknown>)).toBe(false);
  });

  it("does not match missing maintenance config", () => {
    expect(rule.match?.({}, {} as Record<string, unknown>)).toBe(false);
  });

  it("does not match unparseable values (leave for schema diagnostic)", () => {
    expect(rule.match?.({ pruneAfter: "abc" }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ pruneAfter: "" }, {} as Record<string, unknown>)).toBe(false);
  });

  // ── Numeric rule match ─────────────────────────────────────

  it("detects numeric zero", () => {
    expect(rule.match?.({ pruneAfter: 0 }, {} as Record<string, unknown>)).toBe(true);
  });

  it("does not match numeric positive durations", () => {
    expect(rule.match?.({ pruneAfter: 30 }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ pruneAfter: 7 }, {} as Record<string, unknown>)).toBe(false);
  });

  // ── Migration apply (doctor --fix): parser-backed ───────────

  it("removes zero-duration strings and reports change", () => {
    for (const val of ["0h", "0d", "0ms", "0", "0s", "0m", "0.0h", "0h0m"]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { pruneAfter: val } } };
      migration.apply(raw, changes);

      expect(raw.session?.maintenance).not.toHaveProperty("pruneAfter");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain(val);
    }
  });

  it("preserves positive durations", () => {
    for (const val of ["30d", "24h", "7d", "500ms"]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { pruneAfter: val } } };
      migration.apply(raw, changes);

      expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({
        pruneAfter: val,
      });
      expect(changes).toHaveLength(0);
    }
  });

  it("removes numeric zero and reports change", () => {
    const changes: string[] = [];
    const raw = { session: { maintenance: { pruneAfter: 0 } } };
    migration.apply(raw, changes);

    expect(raw.session?.maintenance).not.toHaveProperty("pruneAfter");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("0");
  });

  it("preserves numeric positive values", () => {
    for (const val of [30, 7]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { pruneAfter: val } } };
      migration.apply(raw, changes);

      expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({
        pruneAfter: val,
      });
      expect(changes).toHaveLength(0);
    }
  });

  it("handles empty maintenance section", () => {
    const changes: string[] = [];
    const raw = { session: { maintenance: {} } };
    migration.apply(raw, changes);

    expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({});
    expect(changes).toHaveLength(0);
  });

  it("does nothing when session is not an object", () => {
    const changes: string[] = [];
    const raw = { session: "not-an-object" };
    migration.apply(raw, changes);

    expect(raw.session).toBe("not-an-object");
    expect(changes).toHaveLength(0);
  });

  it("does nothing when maintenance is not an object", () => {
    const changes: string[] = [];
    const raw = { session: { maintenance: "not-an-object" } };
    migration.apply(raw, changes);

    expect((raw.session as Record<string, unknown>).maintenance).toBe("not-an-object");
    expect(changes).toHaveLength(0);
  });

  // ── Rule re-applies after migration ──────────────────────────

  it("rule no longer matches after migration removed the zero value", () => {
    const raw = { session: { maintenance: { pruneAfter: "0h" } } };
    expect(rule.match?.(raw.session.maintenance, raw)).toBe(true);

    migration.apply(raw, []);

    expect(rule.match?.(raw.session?.maintenance, raw)).toBe(false);
  });
});
