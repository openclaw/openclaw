import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const ZERO_DURATIONS = ["0", "0ms", "0h", "0d", "0.0h", "0h0m", 0] as const;
const POSITIVE_DURATIONS = ["1ms", "12h", "30d", 30] as const;

function getMaintenance(raw: Record<string, unknown> | null): Record<string, unknown> {
  const session = raw?.session as Record<string, unknown> | undefined;
  return (session?.maintenance as Record<string, unknown> | undefined) ?? {};
}

describe("session maintenance zero-duration migrations", () => {
  it.each(ZERO_DURATIONS)("detects and removes pruneAfter %s", (pruneAfter) => {
    const raw = { session: { maintenance: { pruneAfter } } };

    expect(findLegacyConfigIssues(raw)).toEqual([
      expect.objectContaining({
        path: "session.maintenance",
        message: expect.stringContaining("pruneAfter"),
      }),
    ]);

    const result = applyLegacyDoctorMigrations(raw);
    expect(getMaintenance(result.next)).not.toHaveProperty("pruneAfter");
    expect(result.changes).toEqual([expect.stringContaining("documented 30d default applies")]);
    expect(applyLegacyDoctorMigrations(result.next)).toEqual({ next: null, changes: [] });
  });

  it.each(ZERO_DURATIONS)(
    "detects and replaces resetArchiveRetention %s",
    (resetArchiveRetention) => {
      const raw = { session: { maintenance: { resetArchiveRetention } } };

      expect(findLegacyConfigIssues(raw)).toEqual([
        expect.objectContaining({
          path: "session.maintenance",
          message: expect.stringContaining("resetArchiveRetention"),
        }),
      ]);

      const result = applyLegacyDoctorMigrations(raw);
      expect(getMaintenance(result.next)).toHaveProperty("resetArchiveRetention", false);
      expect(result.changes).toEqual([expect.stringContaining("archives are kept")]);
      expect(applyLegacyDoctorMigrations(result.next)).toEqual({ next: null, changes: [] });
    },
  );

  it.each(POSITIVE_DURATIONS)("preserves positive durations %s", (duration) => {
    const raw = {
      session: {
        maintenance: { pruneAfter: duration, resetArchiveRetention: duration },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(applyLegacyDoctorMigrations(raw)).toEqual({ next: null, changes: [] });
  });

  it("leaves invalid values for schema diagnostics", () => {
    const raw = {
      session: {
        maintenance: { pruneAfter: "soon", resetArchiveRetention: "later" },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(applyLegacyDoctorMigrations(raw)).toEqual({ next: null, changes: [] });
  });

  it("repairs both fields in one pass and preserves explicit false", () => {
    const result = applyLegacyDoctorMigrations({
      session: { maintenance: { pruneAfter: "0h", resetArchiveRetention: "0d" } },
    });

    expect(getMaintenance(result.next)).toEqual({ resetArchiveRetention: false });
    expect(result.changes).toHaveLength(2);
    expect(
      applyLegacyDoctorMigrations({
        session: { maintenance: { pruneAfter: "30d", resetArchiveRetention: false } },
      }),
    ).toEqual({ next: null, changes: [] });
  });
});
