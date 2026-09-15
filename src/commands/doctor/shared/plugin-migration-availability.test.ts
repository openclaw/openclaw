import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.types.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { inspectPluginMigrationAvailability } from "./plugin-migration-availability.js";

const fixture = vi.hoisted(
  (): {
    metadata?: PluginMetadataSnapshot;
    missingArtifact: boolean;
    unavailable?: "unknown" | "payload" | "repair" | "descriptor";
  } => ({ missingArtifact: false }),
);

vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: () => fixture.metadata,
}));
vi.mock("../../../plugins/doctor-contract-artifact.js", () => ({
  resolvePluginDoctorContractArtifact: () =>
    fixture.missingArtifact
      ? null
      : { modulePath: "/fixture/doctor-contract-api.mjs", boundaryRoot: "/fixture" },
}));
vi.mock("../../../plugins/payload-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/payload-verification.js")>()),
  isPayloadMissing: () => fixture.unavailable === "payload",
}));
vi.mock("./missing-configured-plugin-install.candidates.js", () => ({
  collectUpdateDeferredPluginIds: () => new Set(["fixture"]),
  resolveConfiguredPluginInstallContext: async () => {
    const records: Record<string, PluginInstallRecord> =
      fixture.unavailable === "payload"
        ? { fixture: { source: "path", installPath: "/fixture" } }
        : {};
    return {
      knownIds: new Set(fixture.unavailable === "unknown" ? [] : ["fixture"]),
      bundledPluginsById: new Map(),
      configuredChannelOwnerPluginIds: new Map(),
      records,
      installedPluginIdsWithRepairablePackages: new Set(
        fixture.unavailable === "repair" ? ["fixture"] : [],
      ),
      configuredPluginIdsWithStaleDescriptors: new Set(
        fixture.unavailable === "descriptor" ? ["fixture"] : [],
      ),
    };
  },
}));

type AvailabilityCase = {
  name: string;
  plugin?: Partial<PluginManifestRecord>;
  retained?: boolean;
  missingArtifact?: boolean;
  unavailable?: typeof fixture.unavailable;
  policy?: "disabled" | "denied" | "allowlist";
  ready?: boolean;
  required?: boolean;
  inspection?: boolean;
};

const cases: AvailabilityCase[] = [
  { name: "ready config-only contract", ready: true },
  { name: "retained obligation", retained: true },
  { name: "unknown plugin", unavailable: "unknown" },
  { name: "missing recorded payload", unavailable: "payload" },
  { name: "repairable package", unavailable: "repair" },
  { name: "stale descriptor", unavailable: "descriptor" },
  { name: "missing Doctor artifact", missingArtifact: true },
  {
    name: "declared state migrations",
    plugin: { doctorContract: { configRepair: true, stateMigrations: true } },
    required: true,
  },
  {
    name: "named state migration",
    plugin: { doctorContract: { configRepair: true, stateMigrations: [{ id: "legacy" }] } },
    required: true,
  },
  { name: "undeclared Doctor contract", plugin: { doctorContract: undefined }, inspection: true },
  {
    name: "migration list requiring inspection",
    plugin: { doctorContract: { configRepair: true, stateMigrations: [] } },
    inspection: true,
  },
  {
    name: "legacy channel setup",
    plugin: { channels: ["fixture"], setupSource: "/fixture/setup.mjs" },
    inspection: true,
  },
  { name: "disabled plugin", policy: "disabled" },
  { name: "denied plugin", policy: "denied" },
  { name: "plugin outside allowlist", policy: "allowlist" },
];

describe("plugin migration availability during installation deferral", () => {
  beforeEach(() => {
    fixture.missingArtifact = false;
    fixture.unavailable = undefined;
  });

  it.each(cases)("preserves the owner boundary for $name", async (entry) => {
    fixture.missingArtifact = entry.missingArtifact === true;
    fixture.unavailable = entry.unavailable;
    fixture.metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          origin: "config",
          doctorContract: { configRepair: true },
          ...entry.plugin,
        },
      ],
    });
    const cfg: OpenClawConfig = {
      plugins: {
        entries: { fixture: { enabled: entry.policy !== "disabled" } },
        ...(entry.policy === "denied" ? { deny: ["fixture"] } : {}),
        ...(entry.policy === "allowlist" ? { allow: ["other"] } : {}),
      },
    };

    const result = await inspectPluginMigrationAvailability({
      cfg,
      env: {},
      deferInstallation: true,
      ...(entry.retained ? { retainedPluginIds: ["fixture"] } : {}),
    });

    expect(result).toEqual({
      pending:
        entry.ready || entry.policy
          ? []
          : [
              {
                pluginId: "fixture",
                reason:
                  "Package convergence must wait until the updating parent releases its install records.",
                command: "openclaw update repair",
                ...(entry.required ? { requiresStateMigration: true } : {}),
                ...(entry.inspection ? { requiresDoctorInspection: true } : {}),
              },
            ],
      requiredPluginIds: entry.required ? ["fixture"] : [],
      inspectionRequiredPluginIds: entry.inspection ? ["fixture"] : [],
      statelessPluginIds: entry.ready ? ["fixture"] : [],
    });
  });
});
