import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

function migrate(maintenance: Record<string, unknown>) {
  const raw = { session: { maintenance } };
  return applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
}

describe("session maintenance zero-duration migration", () => {
  it.each([0, "0h0m"])("detects and removes pruneAfter=%s", (pruneAfter) => {
    const raw = { session: { maintenance: { pruneAfter } } };
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("pruneAfter") }),
    );
    const result = migrate(raw.session.maintenance);
    expect(result.next?.session).toEqual({ maintenance: {} });
    expect(result.changes).toEqual([expect.stringContaining("30d")]);
    expect(
      applyLegacyDoctorMigrations(result.next, {
        sourceConfigBeforeMigrations: result.next,
      }),
    ).toEqual({ next: null, changes: [] });
  });

  it.each([
    { pruneAfter: "500ms" },
    { pruneAfter: 30 },
    { pruneAfter: "invalid" },
    { resetArchiveRetention: false },
  ])("preserves nonzero, invalid, and disabled retention: %j", (maintenance) => {
    expect(findLegacyConfigIssues({ session: { maintenance } })).toEqual([]);
    expect(migrate(maintenance)).toEqual({ next: null, changes: [] });
  });

  it("removes both zero durations in one pass", () => {
    const result = migrate({ pruneAfter: 0, resetArchiveRetention: "0h" });
    expect(result.next?.session).toEqual({ maintenance: {} });
    expect(result.changes).toHaveLength(2);
    expect(result.changes.join("\n")).toContain("30d");
    expect(result.changes.join("\n")).toContain("keep-by-default");
  });

  it("removes only the zero field", () => {
    const result = migrate({ pruneAfter: "0h", resetArchiveRetention: "30d" });
    expect(result.next?.session).toEqual({ maintenance: { resetArchiveRetention: "30d" } });
    expect(result.changes).toHaveLength(1);
  });
});
