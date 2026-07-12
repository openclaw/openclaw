// Session migration tests cover doctor legacy config migration for zero-duration
// pruneAfter and resetArchiveRetention values.
import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

function getMigration() {
  const m = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION.find(
    (candidate) => candidate.id === "session.maintenance.resetArchiveRetention-zero",
  );
  if (!m) throw new Error("migration not found");
  return m;
}

function getRule(id: string) {
  const rules = getMigration().legacyRules;
  if (!rules) throw new Error("legacyRules missing");
  const r = rules.find((candidate) => candidate.path.join(".") === "session.maintenance");
  // Two rules share the same path; distinguish by matching the message prefix.
  const found = rules.find((candidate) => candidate.message.includes(id));
  if (!found) throw new Error(`rule not found: ${id}`);
  return found;
}

const pruneAfterRule = getRule("pruneAfter");
const resetArchiveRetentionRule = getRule("resetArchiveRetention");
const migration = getMigration();

describe("session.maintenance zero-duration migration", () => {
  // ── pruneAfter rule match ──────────────────────────────────

  describe("pruneAfter rule", () => {
    it("detects literal zero strings", () => {
      expect(pruneAfterRule.match?.({ pruneAfter: "0h" }, {} as Record<string, unknown>)).toBe(
        true,
      );
      expect(pruneAfterRule.match?.({ pruneAfter: "0d" }, {} as Record<string, unknown>)).toBe(
        true,
      );
      expect(pruneAfterRule.match?.({ pruneAfter: "0ms" }, {} as Record<string, unknown>)).toBe(
        true,
      );
    });

    it("detects bare-number zero", () => {
      expect(pruneAfterRule.match?.({ pruneAfter: "0" }, {} as Record<string, unknown>)).toBe(true);
    });

    it("detects zero in other units", () => {
      expect(pruneAfterRule.match?.({ pruneAfter: "0s" }, {} as Record<string, unknown>)).toBe(
        true,
      );
      expect(pruneAfterRule.match?.({ pruneAfter: "0m" }, {} as Record<string, unknown>)).toBe(
        true,
      );
    });

    it("detects decimal and composite zero", () => {
      expect(pruneAfterRule.match?.({ pruneAfter: "0.0h" }, {} as Record<string, unknown>)).toBe(
        true,
      );
      expect(pruneAfterRule.match?.({ pruneAfter: "0h0m" }, {} as Record<string, unknown>)).toBe(
        true,
      );
    });

    it("detects numeric zero", () => {
      expect(pruneAfterRule.match?.({ pruneAfter: 0 }, {} as Record<string, unknown>)).toBe(true);
      expect(pruneAfterRule.match?.({ pruneAfter: 0.0 }, {} as Record<string, unknown>)).toBe(true);
    });

    it("does not match positive durations", () => {
      expect(pruneAfterRule.match?.({ pruneAfter: "30d" }, {} as Record<string, unknown>)).toBe(
        false,
      );
      expect(pruneAfterRule.match?.({ pruneAfter: "24h" }, {} as Record<string, unknown>)).toBe(
        false,
      );
      expect(pruneAfterRule.match?.({ pruneAfter: 30 }, {} as Record<string, unknown>)).toBe(false);
    });

    it("does not match missing or unparseable", () => {
      expect(pruneAfterRule.match?.({}, {} as Record<string, unknown>)).toBe(false);
      expect(pruneAfterRule.match?.({ pruneAfter: "abc" }, {} as Record<string, unknown>)).toBe(
        false,
      );
    });

    it("detects zero pruneAfter even with positive resetArchiveRetention", () => {
      expect(
        pruneAfterRule.match?.(
          { resetArchiveRetention: "30d", pruneAfter: "0h" },
          {} as Record<string, unknown>,
        ),
      ).toBe(true);
    });

    it("message mentions pruneAfter and 30d default", () => {
      expect(pruneAfterRule.message).toContain("pruneAfter");
      expect(pruneAfterRule.message).toContain("30d");
    });
  });

  // ── resetArchiveRetention rule match ───────────────────────

  describe("resetArchiveRetention rule", () => {
    it("detects literal zero strings", () => {
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: "0h" },
          {} as Record<string, unknown>,
        ),
      ).toBe(true);
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: "0d" },
          {} as Record<string, unknown>,
        ),
      ).toBe(true);
    });

    it("detects bare-number zero", () => {
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: "0" },
          {} as Record<string, unknown>,
        ),
      ).toBe(true);
    });

    it("detects numeric zero", () => {
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: 0 },
          {} as Record<string, unknown>,
        ),
      ).toBe(true);
    });

    it("does not match positive or false", () => {
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: "30d" },
          {} as Record<string, unknown>,
        ),
      ).toBe(false);
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: false },
          {} as Record<string, unknown>,
        ),
      ).toBe(false);
    });

    it("does not match missing or unparseable", () => {
      expect(resetArchiveRetentionRule.match?.({}, {} as Record<string, unknown>)).toBe(false);
      expect(
        resetArchiveRetentionRule.match?.(
          { resetArchiveRetention: "abc" },
          {} as Record<string, unknown>,
        ),
      ).toBe(false);
    });

    it("message mentions resetArchiveRetention and indefinite retention", () => {
      expect(resetArchiveRetentionRule.message).toContain("resetArchiveRetention");
      expect(resetArchiveRetentionRule.message).toContain("indefinitely");
    });

    it("does not match when only pruneAfter is present", () => {
      expect(
        resetArchiveRetentionRule.match?.({ pruneAfter: "0h" }, {} as Record<string, unknown>),
      ).toBe(false);
    });
  });

  // ── Migration apply (doctor --fix) ─────────────────────────

  describe("apply", () => {
    it("removes zero-duration resetArchiveRetention and reports change", () => {
      for (const val of ["0h", "0d", "0ms", "0", "0s", "0m", "0.0h", "0h0m"]) {
        const changes: string[] = [];
        const raw = { session: { maintenance: { resetArchiveRetention: val } } };
        migration.apply(raw, changes);

        expect(raw.session?.maintenance).not.toHaveProperty("resetArchiveRetention");
        expect(changes).toHaveLength(1);
        expect(changes[0]).toContain("resetArchiveRetention");
        expect(changes[0]).toContain(val);
        expect(changes[0]).toContain("indefinitely");
      }
    });

    it("removes zero-duration pruneAfter and reports change", () => {
      for (const val of ["0h", "0d", "0ms", "0", "0s", "0m"]) {
        const changes: string[] = [];
        const raw = { session: { maintenance: { pruneAfter: val } } };
        migration.apply(raw, changes);

        expect(raw.session?.maintenance).not.toHaveProperty("pruneAfter");
        expect(changes).toHaveLength(1);
        expect(changes[0]).toContain("pruneAfter");
        expect(changes[0]).toContain(val);
        expect(changes[0]).toContain("30d");
      }
    });

    it("removes numeric zeroes and reports field-specific restore", () => {
      // pruneAfter: 30d
      {
        const changes: string[] = [];
        const raw = { session: { maintenance: { pruneAfter: 0 } } };
        migration.apply(raw, changes);
        expect(changes[0]).toContain("30d");
      }
      // resetArchiveRetention: indefinitely
      {
        const changes: string[] = [];
        const raw = { session: { maintenance: { resetArchiveRetention: 0 } } };
        migration.apply(raw, changes);
        expect(changes[0]).toContain("indefinitely");
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

    it("removes only zero pruneAfter when resetArchiveRetention is positive", () => {
      const changes: string[] = [];
      const raw = {
        session: { maintenance: { resetArchiveRetention: "30d", pruneAfter: "0h" } },
      };
      migration.apply(raw, changes);

      expect(raw.session?.maintenance).not.toHaveProperty("pruneAfter");
      expect(raw.session?.maintenance).toHaveProperty("resetArchiveRetention", "30d");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain("pruneAfter");
      expect(changes[0]).toContain("30d");
    });

    it("removes both fields when both are zero", () => {
      const changes: string[] = [];
      const raw = {
        session: { maintenance: { resetArchiveRetention: "0h", pruneAfter: 0 } },
      };
      migration.apply(raw, changes);

      expect(raw.session?.maintenance).not.toHaveProperty("resetArchiveRetention");
      expect(raw.session?.maintenance).not.toHaveProperty("pruneAfter");
      expect(changes).toHaveLength(2);
      expect(changes[0]).toContain("resetArchiveRetention");
      expect(changes[0]).toContain("indefinitely");
      expect(changes[1]).toContain("pruneAfter");
      expect(changes[1]).toContain("30d");
    });

    it("handles empty maintenance section", () => {
      const changes: string[] = [];
      const raw = { session: { maintenance: {} } };
      migration.apply(raw, changes);
      expect((raw.session as Record<string, unknown>)?.maintenance).toEqual({});
      expect(changes).toHaveLength(0);
    });

    it("does nothing when session/maintenance is not an object", () => {
      for (const raw of [
        { session: "not-an-object" },
        { session: { maintenance: "not-an-object" } },
      ]) {
        const changes: string[] = [];
        migration.apply(raw, changes);
        expect(changes).toHaveLength(0);
      }
    });

    // ── Rule re-applies after migration ──────────────────────

    it("pruneAfter rule no longer matches after apply removed it", () => {
      const raw = { session: { maintenance: { pruneAfter: "0h" } } };
      expect(pruneAfterRule.match?.(raw.session.maintenance, raw)).toBe(true);
      migration.apply(raw, []);
      expect(pruneAfterRule.match?.(raw.session?.maintenance, raw)).toBe(false);
    });

    it("resetArchiveRetention rule no longer matches after apply removed it", () => {
      const raw = { session: { maintenance: { resetArchiveRetention: "0h" } } };
      expect(resetArchiveRetentionRule.match?.(raw.session.maintenance, raw)).toBe(true);
      migration.apply(raw, []);
      expect(resetArchiveRetentionRule.match?.(raw.session?.maintenance, raw)).toBe(false);
    });
  });
});
