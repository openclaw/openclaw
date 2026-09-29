import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObject } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const migrate = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw, pluginContracts: false });

it("leaves public-origin inheritance out of persisted config", () => {
  expect(
    migrate({ gateway: { bind: "lan", publicOrigin: "https://gateway.example.com" } }),
  ).toEqual({ next: null, changes: [] });
});

it("removes even a false tool-title preference without changing other settings", () => {
  const raw = { gateway: { controlUi: { enabled: true, toolTitles: false } } };
  expect(findLegacyConfigIssues(raw)).toContainEqual(
    expect.objectContaining({
      path: "gateway.controlUi.toolTitles",
      message: expect.stringContaining("openclaw doctor --fix"),
    }),
  );
  expect(validateConfigObject(raw).ok).toBe(false);
  const result = migrate(raw);
  expect(result.next).toEqual({ gateway: { controlUi: { enabled: true } } });
  expect(result.changes).toHaveLength(1);
  expect(validateConfigObject(result.next).ok).toBe(true);
  expect(findLegacyConfigIssues(result.next)).toEqual([]);
  expect(migrate(result.next)).toEqual({ next: null, changes: [] });
  expect(raw.gateway.controlUi.toolTitles).toBe(false);
});
