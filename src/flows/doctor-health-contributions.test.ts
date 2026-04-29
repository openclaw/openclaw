import { describe, expect, it } from "vitest";
import {
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorMetadataWrite,
} from "./doctor-health-contributions.js";

describe("doctor health contributions", () => {
  it("repairs bundled runtime deps before channel-owned doctor paths can import runtimes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:bundled-plugin-runtime-deps")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:bundled-plugin-runtime-deps")).toBeLessThan(
      ids.indexOf("doctor:auth-profiles"),
    );
    expect(ids.indexOf("doctor:bundled-plugin-runtime-deps")).toBeLessThan(
      ids.indexOf("doctor:startup-channel-maintenance"),
    );
  });

  it("runs plugin registry repair before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });
  it("checks command owner configuration before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:command-owner")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:command-owner")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("skips metadata-only doctor writes under legacy update parents", () => {
    expect(
      shouldSkipLegacyUpdateDoctorMetadataWrite({
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        before: { gateway: { mode: "local" }, meta: { lastTouchedVersion: "2026.4.26" } },
        after: {
          gateway: { mode: "local" },
          meta: { lastTouchedVersion: "2026.4.27" },
          wizard: { lastRunCommand: "doctor" },
        },
      }),
    ).toBe(true);
  });

  it("keeps real doctor repairs writable during update", () => {
    expect(
      shouldSkipLegacyUpdateDoctorMetadataWrite({
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        before: { gateway: { mode: "local" } },
        after: { gateway: { mode: "remote" } },
      }),
    ).toBe(false);
  });

  it("keeps current update parents writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorMetadataWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        before: { meta: { lastTouchedVersion: "2026.4.26" } },
        after: { meta: { lastTouchedVersion: "2026.4.27" } },
      }),
    ).toBe(false);
  });
});
