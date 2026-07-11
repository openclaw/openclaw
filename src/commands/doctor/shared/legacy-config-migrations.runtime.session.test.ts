// Session migration tests cover doctor legacy config migration for zero-duration resetArchiveRetention.
import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

describe("session.maintenance.resetArchiveRetention zero-duration migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION.find(
    (m) => m.id === "session.maintenance.resetArchiveRetention-zero",
  );
  if (!migration) {
    throw new Error("session.maintenance.resetArchiveRetention-zero migration not found");
  }
  const rule = migration.legacyRules?.[0];
  if (!rule) {
    throw new Error("session.maintenance.resetArchiveRetention-zero rule not found");
  }

  // ── Rule match (doctor detection): parser-backed ────────────

  it("detects literal zero strings", () => {
    expect(rule.match?.({ resetArchiveRetention: "0h" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ resetArchiveRetention: "0d" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ resetArchiveRetention: "0ms" }, {} as Record<string, unknown>)).toBe(
      true,
    );
  });

  it("detects bare-number zero", () => {
    expect(rule.match?.({ resetArchiveRetention: "0" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("detects zero in other units", () => {
    expect(rule.match?.({ resetArchiveRetention: "0s" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ resetArchiveRetention: "0m" }, {} as Record<string, unknown>)).toBe(true);
  });

  it("detects decimal zero", () => {
    expect(rule.match?.({ resetArchiveRetention: "0.0h" }, {} as Record<string, unknown>)).toBe(
      true,
    );
  });

  it("detects composite zero", () => {
    expect(rule.match?.({ resetArchiveRetention: "0h0m" }, {} as Record<string, unknown>)).toBe(
      true,
    );
    expect(rule.match?.({ resetArchiveRetention: "0h0m0s" }, {} as Record<string, unknown>)).toBe(
      true,
    );
  });

  it("does not match positive durations", () => {
    expect(rule.match?.({ resetArchiveRetention: "30d" }, {} as Record<string, unknown>)).toBe(
      false,
    );
    expect(rule.match?.({ resetArchiveRetention: "7d" }, {} as Record<string, unknown>)).toBe(
      false,
    );
    expect(rule.match?.({ resetArchiveRetention: "500ms" }, {} as Record<string, unknown>)).toBe(
      false,
    );
  });

  it("does not match false (documented disable)", () => {
    expect(rule.match?.({ resetArchiveRetention: false }, {} as Record<string, unknown>)).toBe(
      false,
    );
  });

  it("does not match missing maintenance config", () => {
    expect(rule.match?.({}, {} as Record<string, unknown>)).toBe(false);
  });

  it("does not match unparseable values (leave for schema diagnostic)", () => {
    expect(rule.match?.({ resetArchiveRetention: "abc" }, {} as Record<string, unknown>)).toBe(
      false,
    );
    expect(rule.match?.({ resetArchiveRetention: "" }, {} as Record<string, unknown>)).toBe(false);
  });

  // ── Numeric rule match ─────────────────────────────────────

  it("detects numeric zero for resetArchiveRetention", () => {
    expect(rule.match?.({ resetArchiveRetention: 0 }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ resetArchiveRetention: 0.0 }, {} as Record<string, unknown>)).toBe(true);
  });

  it("does not match numeric positive resetArchiveRetention", () => {
    expect(rule.match?.({ resetArchiveRetention: 30 }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ resetArchiveRetention: 7 }, {} as Record<string, unknown>)).toBe(false);
  });

  // ── pruneAfter fallback rule match ──────────────────────────

  it("detects zero pruneAfter when resetArchiveRetention is absent (fallback)", () => {
    expect(rule.match?.({ pruneAfter: "0h" }, {} as Record<string, unknown>)).toBe(true);
    expect(rule.match?.({ pruneAfter: 0 }, {} as Record<string, unknown>)).toBe(true);
  });

  it("does not match positive pruneAfter fallback", () => {
    expect(rule.match?.({ pruneAfter: "30d" }, {} as Record<string, unknown>)).toBe(false);
    expect(rule.match?.({ pruneAfter: 30 }, {} as Record<string, unknown>)).toBe(false);
  });

  // ── Migration apply (doctor --fix): parser-backed ───────────

  it("removes zero-duration strings and reports change", () => {
    for (const val of ["0h", "0d", "0ms", "0", "0s", "0m", "0.0h", "0h0m"]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { resetArchiveRetention: val } } };
      migration.apply(raw, changes);

      expect(raw.session?.maintenance).not.toHaveProperty("resetArchiveRetention");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain(val);
    }
  });

  it("preserves positive durations", () => {
    for (const val of ["30d", "7d", "500ms"]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { resetArchiveRetention: val } } };
      migration.apply(raw, changes);

      expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({
        resetArchiveRetention: val,
      });
      expect(changes).toHaveLength(0);
    }
  });

  it("preserves false (documented disable)", () => {
    const changes: string[] = [];
    const raw = { session: { maintenance: { resetArchiveRetention: false } } };
    migration.apply(raw, changes);

    expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({
      resetArchiveRetention: false,
    });
    expect(changes).toHaveLength(0);
  });

  it("removes numeric zero resetArchiveRetention and reports change", () => {
    for (const val of [0, 0.0]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { resetArchiveRetention: val } } };
      migration.apply(raw, changes);

      expect(raw.session?.maintenance).not.toHaveProperty("resetArchiveRetention");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain(String(val));
    }
  });

  it("preserves numeric positive resetArchiveRetention values", () => {
    for (const val of [30, 7]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { resetArchiveRetention: val } } };
      migration.apply(raw, changes);

      expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({
        resetArchiveRetention: val,
      });
      expect(changes).toHaveLength(0);
    }
  });

  // ── pruneAfter fallback apply ───────────────────────────────

  it("removes zero pruneAfter when resetArchiveRetention is absent", () => {
    for (const val of ["0h", 0]) {
      const changes: string[] = [];
      const raw = { session: { maintenance: { pruneAfter: val } } };
      migration.apply(raw, changes);

      expect(raw.session?.maintenance).not.toHaveProperty("pruneAfter");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain(String(val));
    }
  });

  it("preserves positive pruneAfter when resetArchiveRetention is absent", () => {
    const changes: string[] = [];
    const raw = { session: { maintenance: { pruneAfter: "30d" } } };
    migration.apply(raw, changes);

    expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({
      pruneAfter: "30d",
    });
    expect(changes).toHaveLength(0);
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
    const raw = { session: { maintenance: { resetArchiveRetention: "0h" } } };
    expect(rule.match?.(raw.session.maintenance, raw)).toBe(true);

    migration.apply(raw, []);

    expect(rule.match?.(raw.session?.maintenance, raw)).toBe(false);
  });

  it("rule no longer matches after migration removed zero pruneAfter fallback", () => {
    const raw = { session: { maintenance: { pruneAfter: "0h" } } };
    expect(rule.match?.(raw.session.maintenance, raw)).toBe(true);

    migration.apply(raw, []);

    expect(rule.match?.(raw.session?.maintenance, raw)).toBe(false);
  });
});
