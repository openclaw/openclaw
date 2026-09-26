import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObject } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

describe("Control UI origin defaults", () => {
  it("leaves public-origin inheritance out of persisted config", () => {
    const raw = { gateway: { bind: "lan", publicOrigin: "https://gateway.example.com" } };
    expect(
      applyLegacyDoctorMigrations(raw, {
        sourceConfigBeforeMigrations: raw,
        pluginContracts: false,
      }),
    ).toEqual({ next: null, changes: [] });
  });
});

describe("retired Control UI tool-title preference", () => {
  it.each([true, false, null, "true"])(
    "detects and removes toolTitles=%j without changing other Control UI settings",
    (toolTitles) => {
      const raw = { gateway: { controlUi: { enabled: true, toolTitles } } };
      expect(findLegacyConfigIssues(raw)).toContainEqual({
        path: "gateway.controlUi.toolTitles",
        message: expect.stringContaining("openclaw doctor --fix"),
      });
      expect(validateConfigObject(raw).ok).toBe(false);

      const result = applyLegacyDoctorMigrations(raw, {
        sourceConfigBeforeMigrations: raw,
        pluginContracts: false,
      });
      expect(result.next).toEqual({ gateway: { controlUi: { enabled: true } } });
      expect(result.changes).toContain(
        "Removed retired gateway.controlUi.toolTitles; tool activity descriptions are automatic and make no utility-model calls.",
      );
      expect(validateConfigObject(result.next).ok).toBe(true);
      expect(findLegacyConfigIssues(result.next)).toEqual([]);
      expect(
        applyLegacyDoctorMigrations(result.next, {
          sourceConfigBeforeMigrations: result.next,
          pluginContracts: false,
        }),
      ).toEqual({ next: null, changes: [] });
      expect(raw.gateway.controlUi.toolTitles).toBe(toolTitles);
    },
  );
});
