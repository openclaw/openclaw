import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

it("migrates only explicitly selected legacy device inference and preserves other settings", () => {
  const profiles = {
    legacy: {
      provider: "device",
      settings: { device: "paired-node", inference: "runtime-local", region: "fixture" },
    },
    canonical: { provider: "device", settings: { device: "paired-node", inference: "worker" } },
    gateway: { provider: "device", settings: { device: "paired-node", inference: "gateway" } },
    default: { provider: "device", settings: { device: "paired-node" } },
    foreign: { provider: "static-ssh", settings: { inference: "runtime-local" } },
    invalid: { provider: "device", settings: { inference: "unknown" } },
  };
  const raw = { cloudWorkers: { profiles } };
  const original = structuredClone(raw);
  expect(findLegacyConfigIssues(raw)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "cloudWorkers.profiles",
        message: expect.stringContaining("inference"),
      }),
    ]),
  );
  const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
  expect(migrated.partiallyValid).toBeUndefined();
  const expectedProfiles = {
    ...profiles,
    legacy: { ...profiles.legacy, settings: { ...profiles.legacy.settings, inference: "worker" } },
  };
  expect(migrated.sourceConfig).toEqual({ cloudWorkers: { profiles: expectedProfiles } });
  expect(migrated.config?.cloudWorkers?.profiles).toEqual(
    Object.fromEntries(
      Object.entries(expectedProfiles).map(([id, profile]) => [
        id,
        { install: "bundle", ...profile },
      ]),
    ),
  );
  expect(raw).toEqual(original);
  expect(migrated.changes).toContain(
    'Renamed cloudWorkers.profiles.legacy.settings.inference from "runtime-local" to "worker".',
  );
  expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
  expect(
    migrateLegacyConfig(migrated.sourceConfig, {
      sourceConfigBeforeMigrations: migrated.sourceConfig,
    }).changes,
  ).toEqual([]);
});
