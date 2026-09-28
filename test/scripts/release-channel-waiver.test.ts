import { describe, expect, it } from "vitest";
import {
  normalizeReleaseTelegramWaiver,
  releaseWaivedIntegrationChannels,
  validateReleaseTelegramWaiverBinding,
} from "../../scripts/full-release-validation-policy.mjs";

const approved = {
  telegramWaiver: "2026.9.5-owner-approved",
  targetVersion: "2026.9.5",
  candidateVersion: "2026.9.5",
  releaseProfile: "full",
  rerunGroup: "all",
  liveSuiteFilter: "",
  releasePackageSpec: "",
  packageAcceptancePackageSpec: "",
  npmTelegramPackageSpec: "",
};

describe("reviewed release channel waiver", () => {
  it("owns the exact 9.5 channel set without extending historical waivers", () => {
    expect(releaseWaivedIntegrationChannels(approved)).toEqual(["telegram", "matrix"]);
    for (const version of ["2026.8.1", "2026.9.1"]) {
      expect(
        releaseWaivedIntegrationChannels({
          ...approved,
          targetVersion: version,
          candidateVersion: version,
          telegramWaiver: `${version}-owner-approved`,
          liveSuiteFilter: "qa-live-matrix",
        }),
      ).toEqual(["telegram"]);
    }
    const projection = releaseWaivedIntegrationChannels(approved);
    projection.push("buzz");
    expect(releaseWaivedIntegrationChannels(approved)).toEqual(["telegram", "matrix"]);
    expect(releaseWaivedIntegrationChannels({ ...approved, telegramWaiver: "" })).toEqual([]);
  });

  it.each(["qa-live-matrix", "qa-matrix", "matrix", "MATRIX", "qa-live-matrix,qa-live-buzz"])(
    "rejects explicit Matrix selection %s under the combined 9.5 declaration",
    (liveSuiteFilter) => {
      const inputs = { ...approved, liveSuiteFilter };
      expect(() => normalizeReleaseTelegramWaiver(inputs)).toThrow(/waived-channel/u);
      expect(() => validateReleaseTelegramWaiverBinding(approved, inputs)).toThrow(
        /waived-channel/u,
      );
    },
  );

  it("preserves other QA selectors and exact candidate/package/plan bindings", () => {
    expect(normalizeReleaseTelegramWaiver({ ...approved, liveSuiteFilter: "qa-live-buzz" })).toBe(
      approved.telegramWaiver,
    );
    for (const drift of [
      { candidateVersion: "2026.9.6" },
      { targetVersion: "2026.9.6" },
      { releaseProfile: "beta" },
      { releasePackageSpec: "openclaw@latest" },
      { packageAcceptancePackageSpec: "openclaw@2026.9.4" },
      { npmTelegramPackageSpec: "openclaw@beta" },
      { liveSuiteFilter: "qa-live-all" },
      { liveSuiteFilter: "qa-live-telegram" },
    ]) {
      expect(() => normalizeReleaseTelegramWaiver({ ...approved, ...drift })).toThrow(/waiver/u);
    }
    expect(() =>
      validateReleaseTelegramWaiverBinding(approved, {
        ...approved,
        telegramWaiver: "",
      }),
    ).toThrow(/immutable execution plan/u);
  });
});
