import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { isPathInside } from "./path-guards.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";
import { readImmutableSchemaContracts } from "./update-immutable-generation.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import { assertImmutableDescriptorCurrent, directoryIdentity } from "./update-immutable-layout.js";

type DatabaseCoverage = UpdateStateSchemaVersion &
  StateDatabaseDiscovery & {
    external: boolean;
    targetVersion?: number;
    coverage:
      | "unknown"
      | "absent"
      | "matching-version"
      | "migration-required"
      | "newer-than-candidate";
  };

export type ImmutableUpdateCoverage = {
  target: {
    sha?: string;
    preparation: "unknown" | "prepared";
    schemaVersions?: OpenClawSchemaVersions;
  };
  currentSchemaVersions?: OpenClawSchemaVersions;
  databases?: DatabaseCoverage[];
  resources?: {
    path: string;
    kind: string;
    present: boolean;
    external: boolean;
    coverage: "unknown";
  }[];
  unsupportedReasons: string[];
  warnings: string[];
};

/** Read recorded preparation and live inventory only; never execute candidate code. */
export async function inspectImmutableUpdateCoverage(params: {
  root: string;
  targetSha?: string;
}): Promise<ImmutableUpdateCoverage> {
  const result: ImmutableUpdateCoverage = {
    target: { sha: params.targetSha, preparation: "unknown" },
    unsupportedReasons: [],
    warnings: [],
  };
  const record = await readImmutableInstallRecord(params.root);
  if (!record) {
    throw new Error("Immutable adoption record is unavailable.");
  }
  assertImmutableDescriptorCurrent(record.descriptor);
  const selected = record.prepared;
  const hasPrepared = selected && (!params.targetSha || selected.sha === params.targetSha);
  if (hasPrepared) {
    result.target.sha = selected.sha;
    try {
      if (directoryIdentity(selected.path) !== selected.identity) {
        throw new Error("Prepared generation identity differs from its receipt.");
      }
      const contracts = await readImmutableSchemaContracts(record);
      result.currentSchemaVersions = contracts.current;
      result.unsupportedReasons.push(...contracts.reasons);
      if (contracts.candidate && isDeepStrictEqual(contracts.candidate, selected.schemaVersions)) {
        result.target = {
          sha: selected.sha,
          preparation: "prepared",
          schemaVersions: contracts.candidate,
        };
      }
    } catch (error) {
      result.warnings.push(formatErrorMessage(error));
    }
  }
  if (result.target.preparation === "unknown") {
    result.unsupportedReasons.push(
      "Target coverage is unknown: no matching readable preparation receipt and generation. Prepare the exact target with openclaw update --sha <commit> --no-restart, then inspect again.",
    );
  }
  if (!record.descriptor.activationEnabled) {
    result.unsupportedReasons.push(
      "This installation is adopted for preparation only; activation is disabled.",
    );
  }
  const { withArtifactPreservingStateReads, withOpenClawStateDatabaseReadSnapshot } =
    await import("../state/openclaw-state-db-readonly.js");
  await withArtifactPreservingStateReads(
    async () => {
      try {
        const { readImmutableService } = await import("./update-immutable-service.js");
        const { descriptor } = record;
        const { command } = await readImmutableService(
          descriptor.service,
          descriptor.root,
          descriptor.current.path,
          descriptor.runtime.path,
        );
        const env = {
          ...process.env,
          OPENCLAW_AGENT_DIR: undefined,
          PI_CODING_AGENT_DIR: undefined,
          ...command.environment,
        };
        const { createConfigIO } = await import("../config/io.js");
        const snapshot = await createConfigIO({
          env,
          configPath: descriptor.service.configPath,
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
        if (!snapshot.valid) {
          throw new Error(
            "Adopted service configuration is invalid; live resource coverage is unknown.",
          );
        }
        const stateDir = descriptor.service.stateDir;
        const config = snapshot.sourceConfig;
        const { readUpdateStateSchemaVersions, resolveUpdateStateContentVersion } =
          await import("./update-candidate-state.js");
        let inventory: ReadonlyMap<string, StateDatabaseDiscovery> = new Map();
        const versions = await readUpdateStateSchemaVersions({
          stateDir,
          config,
          env,
          preserveSourceArtifacts: true,
          onInventory: (files) => {
            inventory = files;
          },
        });
        const byPath = new Map(versions.map((entry) => [entry.path, entry]));
        const shared = path.resolve(stateDir, "state", "openclaw.sqlite");
        result.databases = [...inventory.values()].map((discovery) => {
          const file = discovery.spellings[0];
          const version = byPath.get(file);
          if (!version) {
            throw new Error(`Schema inspection omitted ${file}.`);
          }
          const found = resolveUpdateStateContentVersion(version);
          const target = result.target.schemaVersions?.[file === shared ? "state" : "agent"];
          const coverage: DatabaseCoverage["coverage"] =
            found === null
              ? "absent"
              : target === undefined
                ? "unknown"
                : found === target
                  ? "matching-version"
                  : found < target
                    ? "migration-required"
                    : "newer-than-candidate";
          return Object.assign({}, discovery, version, {
            external: !isPathInside(stateDir, file),
            targetVersion: target,
            coverage,
          });
        });
        for (const database of result.databases) {
          if (
            database.coverage === "migration-required" ||
            database.coverage === "newer-than-candidate"
          ) {
            result.unsupportedReasons.push(
              `${database.path}: schema ${resolveUpdateStateContentVersion(database)} → ${database.targetVersion} (${database.coverage}); immutable activation does not migrate live stores.`,
            );
          }
        }
        const { preparePluginDoctorMigrationBackupResources } =
          await import("../plugins/doctor-contract-registry.js");
        const { createPluginCache, withPluginCache, retirePluginCache } =
          await import("../plugins/plugin-cache.js");
        const { withPluginSourceCaptureStorage } =
          await import("../plugins/plugin-source-capture-context.js");
        const warnings: import("../plugins/doctor-contract-module.js").PluginDoctorMigrationBackupWarning[] =
          [];
        const cache = createPluginCache();
        let resources: Awaited<
          ReturnType<typeof preparePluginDoctorMigrationBackupResources>
        >["resources"];
        try {
          resources = await withPluginCache(cache, () =>
            withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, () =>
              withOpenClawStateDatabaseReadSnapshot(
                async () => {
                  const prepared = await preparePluginDoctorMigrationBackupResources({
                    config,
                    env,
                    stateDir,
                    warnings,
                  });
                  prepared.assertCurrent();
                  return prepared.resources;
                },
                { env },
              ),
            ),
          );
        } finally {
          result.warnings.push(...warnings.map((warning) => warning.message));
          const cleanup = await retirePluginCache(cache);
          result.warnings.push(
            ...cleanup.failures.map((failure) => formatErrorMessage(failure.error)),
          );
        }
        result.resources = await Promise.all(
          resources.map(async (resource) => ({
            path: resource.path,
            kind: resource.kind,
            present: await fs.stat(resource.path).then(
              () => true,
              (error: unknown) => {
                if (hasErrnoCode(error, "ENOENT")) {
                  return false;
                }
                throw error;
              },
            ),
            external: !isPathInside(stateDir, resource.path),
            coverage: "unknown" as const,
          })),
        );
      } catch (error) {
        result.warnings.push(`Live inventory inspection incomplete: ${formatErrorMessage(error)}`);
      }
    },
    { agentDatabases: true },
  );
  return result;
}

export function formatImmutableUpdateCoverage(coverage: ImmutableUpdateCoverage): string[] {
  return [
    `Target schema coverage: ${coverage.target.preparation}${coverage.target.sha ? ` (${coverage.target.sha})` : ""}.`,
    ...coverage.unsupportedReasons,
    ...(coverage.databases ?? []).map(
      (database) =>
        `Store ${database.path}: ${database.coverage}; schema ${database.contentVersion ?? database.userVersion ?? "absent"}${database.targetVersion === undefined ? "" : ` → ${database.targetVersion}`}${database.external ? "; external" : ""}${database.registeredPaths?.length ? `; registered as ${database.registeredPaths.join(", ")}` : ""}.`,
    ),
    ...(coverage.resources ?? []).map(
      (resource) =>
        `Plugin resource ${resource.path} (${resource.kind}): ${resource.present ? "present" : "absent"}${resource.external ? "; external" : ""}; migration coverage unknown.`,
    ),
    ...coverage.warnings,
    "Inspection only: schema versions are not physical-schema, migration, backup, or activation readiness proof.",
  ];
}
