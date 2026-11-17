import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { tryReadJson } from "../infra/json-files.js";
import { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
import { readPackageVersion } from "../infra/package-json.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/path-existence.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { updateInstallRootsMatch } from "../infra/update-install-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { parsePackageOpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

/** Admission failed before schema writes; restore the service we parked, not the candidate. */
export class DoctorRepairSchemaConsentRefusal extends DoctorMaintenanceRefusalError {
  constructor(
    message: string,
    readonly installedRoot: string,
    options?: ErrorOptions,
  ) {
    super(message, { kind: "data-at-risk", reason: "incomplete-migration" }, options);
  }
}

/** Public repair's parent admits migration before starting any candidate Doctor continuation. */
export async function admitDoctorRepairSchemaMigration(params: {
  root: string;
  serviceRoot?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  yes: boolean;
  json: boolean;
  fullIntegrityCheck?: boolean;
  runtime: RuntimeEnv;
}) {
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  const observed = getGatewayServiceInstallation();
  const installedRoot =
    params.serviceRoot ??
    (observed?.databasePath === resolveIdentityPathViaExistingAncestorSync(databasePath)
      ? observed.root
      : undefined);
  // Accepted edge: absent/uninspectable installations keep today's offline repair behavior.
  if (!installedRoot || updateInstallRootsMatch(installedRoot, params.root)) {
    return;
  }
  const [installedVersion, repairingVersion, manifest] = await Promise.all([
    readPackageVersion(installedRoot),
    readPackageVersion(params.root),
    tryReadJson<unknown>(path.join(installedRoot, "package.json")),
  ]);
  const supported = parsePackageOpenClawSchemaVersions(manifest);
  if (
    !installedVersion ||
    !repairingVersion ||
    !supported ||
    (compareOpenClawReleaseVersions(repairingVersion, installedVersion) ?? 0) <= 0
  ) {
    return;
  }
  try {
    const { prepareDoctorDatabasePreflight } = await import("./doctor-database-preflight.js");
    const schemas = await prepareDoctorDatabasePreflight();
    if (
      !schemas.pendingMigrations?.some(
        (migration) =>
          migration.foundVersion < migration.supportedVersion &&
          migration.supportedVersion > supported[migration.kind],
      )
    ) {
      return;
    }
    const { resolveDoctorMigrationDatabaseTargets } =
      await import("./doctor-heartbeat-migration-backup.js");
    const { backupDoctorMigrationDatabases } = await import("./doctor-migration-backup.js");
    const targets = await resolveDoctorMigrationDatabaseTargets(schemas);
    const backups = await backupDoctorMigrationDatabases({
      env: params.env,
      check: params.fullIntegrityCheck ? "full" : "quick",
      databasePaths: targets?.map((target) => target.path) ?? [],
      agentDatabaseTargets: targets,
      pendingDatabasePaths: schemas.pendingMigrations.map((migration) => migration.path),
      pendingMigrations: schemas.pendingMigrations,
      versionMigrationsOnly: true,
    });
    const { classifyDoctorMigrationBackupPath } =
      await import("./doctor-migration-backup-names.js");
    const command = (args: string) =>
      formatCliCommand(`openclaw ${args}`, params.env).replace(
        /^openclaw\b/u,
        `${quoteCliArg(process.execPath)} ${quoteCliArg(path.join(params.root, "openclaw.mjs"))}`,
      );
    const restore = (backups.snapshots ?? []).map(({ sourcePath, path: backupPath }) =>
      classifyDoctorMigrationBackupPath(sourcePath, backupPath) === "scoped"
        ? command(
            `database restore-migration-backup ${quoteCliArg(backupPath)} ${quoteCliArg(sourcePath)}`,
          )
        : `sqlite3 ${quoteCliArg(sourcePath)} ${quoteCliArg(`.restore ${JSON.stringify(backupPath)}`)}`,
    );
    const message = [
      `Installed OpenClaw ${installedVersion} will not be able to read state/agent databases after this repair by ${repairingVersion}.`,
      ...backups.changes,
      ...backups.warnings,
      "To restore, stop the Gateway and other OpenClaw processes, preserve the repaired databases, restore every original listed above, and use the matching installed release.",
      ...restore,
      ...(backups.postgresGenerations
        ? [
            "PostgreSQL originals use their matching release's offline database recovery: https://docs.openclaw.ai/install/backups",
          ]
        : []),
      `Keep the same state/configuration environment. Rerun ${command("update repair --yes")} to explicitly consent.`,
    ].join("\n");
    params.runtime.log(message);
    const { createDoctorPrompter } = await import("./doctor-prompter.js");
    const consent =
      params.yes ||
      (await createDoctorPrompter({
        runtime: params.runtime,
        options: { nonInteractive: params.json },
        signal: params.signal,
      }).confirmRuntimeRepair({
        message: "Proceed with these one-way database migrations?",
        initialValue: false,
        requiresInteractiveConfirmation: true,
      }));
    if (!consent) {
      throw new DoctorRepairSchemaConsentRefusal(message, installedRoot);
    }
  } catch (cause) {
    if (cause instanceof DoctorRepairSchemaConsentRefusal) {
      throw cause;
    }
    throw new DoctorRepairSchemaConsentRefusal(
      `Cross-version repair admission failed before schema migration: ${formatErrorMessage(cause)}`,
      installedRoot,
      { cause },
    );
  }
}
