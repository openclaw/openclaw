import path from "node:path";
import { type Command, Option } from "commander";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

type DatabaseOutputOptions = { json?: boolean };

function writeDatabaseError(error: unknown, json: boolean): void {
  if (json) {
    writeRuntimeJson(defaultRuntime, formatCliJsonFailure(error));
  } else {
    defaultRuntime.error(formatErrorMessage(error));
  }
  defaultRuntime.exit(1);
}

async function runDatabasePreflight(
  databasePath: string,
  options: DatabaseOutputOptions & { agentId?: string },
) {
  const result =
    options.agentId === undefined
      ? await (
          await import("../../state/openclaw-database-preflight.js")
        ).preflightOpenClawStateDatabasePath(databasePath)
      : await (
          await import("../../state/openclaw-agent-schema-inspection.js")
        ).preflightOpenClawAgentDatabasePath(databasePath, options.agentId);
  if (options.json) {
    writeRuntimeJson(defaultRuntime, result);
  } else {
    const detail = result.reason ?? result.issues[0]?.message;
    writeRuntimeStdout(
      defaultRuntime,
      `Database preflight: ${result.status} (found ${result.foundVersion ?? "unknown"}, target ${result.targetVersion}).${detail ? `\n${detail}` : ""}\nSee ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.\n`,
    );
  }
  if (result.status === "incompatible" || result.status === "indeterminate") {
    defaultRuntime.exit(1);
  }
}

async function runDatabaseOwnership(
  options: DatabaseOutputOptions & { manager?: string },
): Promise<void> {
  try {
    const databasePath = path.resolve(resolveOpenClawStateSqlitePath(process.env));
    const managerId = options.manager;
    const ownership =
      managerId !== undefined
        ? await (
            await import("../local-state-owner.js")
          ).runWithLocalStateOwner({
            method: "database.ownership.claim",
            params: { manager: managerId },
            target: databasePath,
            onForeignOwner: async () => {
              throw new Error(
                "Cannot claim shared-state ownership while a Gateway or embedded agent is running. Stop the Gateway through the external supervisor and stop any embedded agents, then retry the ownership claim.",
              );
            },
            runLocal: async ({ env, assertCurrent }) => {
              const { claimOpenClawStateOwnership } =
                await import("../../state/openclaw-state-ownership-operations.js");
              assertCurrent();
              return claimOpenClawStateOwnership(managerId, { path: databasePath, env });
            },
          })
        : (
            await import("../../state/openclaw-state-ownership.js")
          ).inspectOpenClawStateOwnershipAtPath(databasePath);
    const status = ownership
      ? { status: "external" as const, ownership }
      : { status: "unowned" as const };
    if (options.json) {
      writeRuntimeJson(defaultRuntime, { databasePath, ...status });
      return;
    }
    const message =
      status.status === "external"
        ? `Shared state is externally owned by ${status.ownership.managerId}.`
        : "Shared state is not externally owned.";
    writeRuntimeStdout(defaultRuntime, `${message}\nSee ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.\n`);
  } catch (error) {
    writeDatabaseError(error, options.json === true);
  }
}

export function registerDatabaseCommand(program: Command): void {
  const database = program
    .command("database")
    .description("Inspect database compatibility, manage ownership, and port database stores")
    .addHelpText("after", `\nDocs: ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}\n`);

  const migrationCapture = database
    .command("migration-capture")
    .description("Preserve exact offline or externally quiesced SQLite state for migration");
  migrationCapture
    .command("capabilities")
    .option("--json", "emit machine-readable JSON", false)
    .action(() =>
      writeRuntimeJson(defaultRuntime, {
        schema: "openclaw.database-migration-capture.capabilities.v1",
        protocol: 1,
        sourceEngine: "sqlite",
        profile: "exact-sqlite-migration",
        restoreTarget: "empty-staging-only",
        logicalPaths: "same-state-and-config-roots",
        externallyQuiesced: true,
      }),
    );
  migrationCapture
    .command("create")
    .option(
      "--base-archive <archive>",
      "fresh verified filesystem archive for the same stopped source (offline capture)",
    )
    .option(
      "--externally-quiesced",
      "capture from an existing host-held Gateway suspension without stopping it",
      false,
    )
    .option("--request-id <id>", "request ID of the existing non-drain suspension")
    .option("--suspension-id <id>", "existing ready suspension ID")
    .requiredOption(
      "--output <directory>",
      "new private capture directory outside the source roots",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options) => {
      try {
        const { createDatabaseMigrationCapture } =
          await import("../../commands/database-migration-capture.js");
        const result = await createDatabaseMigrationCapture(options);
        if (options.json) {
          writeRuntimeJson(defaultRuntime, result);
        } else {
          writeRuntimeStdout(defaultRuntime, `Exact migration capture: ${result.manifestPath}\n`);
        }
      } catch (error) {
        writeDatabaseError(error, options.json === true);
      }
    });
  migrationCapture
    .command("restore")
    .argument("<capture>", "completed exact migration capture directory")
    .requiredOption("--target <directory>", "empty private staging directory outside live state")
    .requiredOption(
      "--manifest-sha256 <digest>",
      "manifest digest returned by the exact capture producer",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action(async (capture, options) => {
      try {
        const { restoreDatabaseMigrationCapture } =
          await import("../../commands/database-migration-capture.js");
        const result = await restoreDatabaseMigrationCapture(defaultRuntime, {
          capture,
          target: options.target,
          manifestSha256: options.manifestSha256,
        });
        if (options.json) {
          writeRuntimeJson(defaultRuntime, result);
        } else {
          writeRuntimeStdout(
            defaultRuntime,
            `Exact migration restored to staging: ${result.targetPath}\n`,
          );
        }
      } catch (error) {
        writeDatabaseError(error, options.json === true);
      }
    });

  database
    .command("port")
    .description("Port existing database stores offline between SQLite and PostgreSQL")
    .addOption(
      new Option("--to <postgres|sqlite>", "destination engine").choices(["postgres", "sqlite"]),
    )
    .addOption(
      new Option("--family <family>", "port one database family").choices([
        "state",
        "agent",
        "workboard",
        "logbook",
        "team-reports",
      ]),
    )
    .option("--dry-run", "inspect prerequisites without creating port artifacts", false)
    .option("--json", "emit machine-readable JSON", false)
    .addOption(
      new Option("--resume <manifest>", "resume an interrupted port").conflicts([
        "rollback",
        "to",
        "dryRun",
        "family",
      ]),
    )
    .addOption(
      new Option(
        "--rollback <manifest>",
        "restore an interrupted port's complete original set",
      ).conflicts(["to", "dryRun", "family"]),
    )
    .hook("preAction", (command) => {
      const { to, resume, rollback } = command.opts();
      if (!to && !resume && !rollback) {
        command.error("Specify --to postgres|sqlite, --resume, or --rollback.");
      }
    })
    .action(async (options) => {
      try {
        const { doctorDatabasePort } = await import("../../commands/doctor-database-port.js");
        const result = await doctorDatabasePort(options);
        const statistics = [
          ...("plannerStatistics" in result ? result.plannerStatistics : []).map(
            ({ path: storePath, result: statisticsResult }) => ({
              label: storePath,
              result: statisticsResult,
            }),
          ),
          ...("memoryRebuilds" in result ? result.memoryRebuilds : []).flatMap((rebuild) =>
            rebuild.plannerStatistics
              ? [{ label: `memory ${rebuild.agentId}`, result: rebuild.plannerStatistics }]
              : [],
          ),
        ];
        for (const { label, result: statisticsResult } of statistics) {
          if (statisticsResult.status === "warning") {
            defaultRuntime.error(
              `Planner statistics WARNING (${label}): ${statisticsResult.warning}`,
            );
          }
        }
        if ("memoryRebuilds" in result) {
          for (const rebuild of result.memoryRebuilds) {
            if (rebuild.warning) {
              defaultRuntime.error(
                `Memory rebuild WARNING (${rebuild.agentId}): ${rebuild.warning}`,
              );
            }
          }
        }
        if (options.json) {
          writeRuntimeJson(defaultRuntime, result);
        } else {
          writeRuntimeStdout(
            defaultRuntime,
            `Database port: ${result.phase} (${result.engine}${"to" in result ? ` → ${result.to}` : ""}); ${result.stores.length} database stores.\n${"remainingSqlite" in result ? `${result.remainingSqlite.length} other stores remain on SQLite.\n` : ""}${"backup" in result ? `Original backup: ${result.backup}\n${result.restart}\n` : ""}${"verification" in result ? `${result.verification}\n` : ""}`,
          );
          for (const { label, result: statisticsResult } of statistics) {
            if (statisticsResult.status === "analyzed") {
              writeRuntimeStdout(
                defaultRuntime,
                `Planner statistics (${label}): ANALYZE completed for ${statisticsResult.tables} tables.\n`,
              );
            }
          }
          if ("memoryRebuilds" in result) {
            for (const rebuild of result.memoryRebuilds) {
              writeRuntimeStdout(
                defaultRuntime,
                `Memory index (${rebuild.agentId}): ${rebuild.status}${rebuild.elapsedMs === undefined ? "" : ` in ${(rebuild.elapsedMs / 1000).toFixed(1)}s`}.\n`,
              );
            }
          }
        }
      } catch (error) {
        writeDatabaseError(error, options.json === true);
      }
    });

  database
    .command("restore-migration-backup")
    .description("Restore a scoped migration backup's tables and schema version while offline")
    .argument("<backup>", "table-scoped pre-migration SQLite backup")
    .argument("<database>", "original SQLite database; undeclared tables are preserved")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (backupPath, sourcePath, options) => {
      try {
        const { restoreDoctorMigrationBackup } =
          await import("../../commands/doctor-migration-backup-restore.js");
        const result = await restoreDoctorMigrationBackup({ sourcePath, backupPath });
        if (options.json) {
          writeRuntimeJson(defaultRuntime, result);
        } else {
          writeRuntimeStdout(defaultRuntime, `Restored scoped migration backup: ${backupPath}\n`);
        }
      } catch (error) {
        writeDatabaseError(error, options.json === true);
      }
    });

  database
    .command("preflight")
    .description("Compare one copied SQLite file with this release's state schema")
    .argument("<path>", "explicit copied SQLite database path")
    .option("--json", "emit machine-readable JSON", false)
    .action(runDatabasePreflight);

  database
    .command("preflight-agent")
    .description("Compare one copied agent SQLite file with this release's agent schema and owner")
    .argument("<path>", "explicit copied agent SQLite database path")
    .requiredOption("--agent-id <id>", "exact agent owner ID")
    .option("--json", "emit machine-readable JSON", false)
    .action(runDatabasePreflight);

  database
    .command("verify-preservation")
    .description(
      "Compare retained recovery captures without changing state or authorizing activation",
    )
    .argument("<original-manifest>", "sealed original recovery manifest")
    .argument("<candidate-manifest>", "sealed capture after migration")
    .requiredOption(
      "--original-sha256 <digest>",
      "original manifest digest recorded before migration",
    )
    .requiredOption("--candidate-sha256 <digest>", "candidate manifest digest")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (originalPath, candidatePath, options) => {
      try {
        const ref = (manifestPath: string, manifestSha256: string) => ({
          manifestPath: path.resolve(manifestPath),
          directory: path.dirname(path.resolve(manifestPath)),
          manifestSha256,
        });
        const { inspectDoctorMigrationPreservation } =
          await import("../../commands/doctor-migration-preservation.js");
        const result = await inspectDoctorMigrationPreservation({
          original: ref(originalPath, options.originalSha256),
          candidate: ref(candidatePath, options.candidateSha256),
        });
        if (options.json) {
          writeRuntimeJson(defaultRuntime, result);
        } else {
          writeRuntimeStdout(
            defaultRuntime,
            `Migration preservation: ${result.status}; ${result.databases} databases, ${result.files} files. Inspection only.\n${result.warnings.join("\n")}\n`,
          );
        }
      } catch (error) {
        writeDatabaseError(error, options.json === true);
      }
    });

  const ownership = database.command("ownership").description("Inspect or claim write ownership");
  ownership
    .command("status")
    .description("Show durable shared-state write ownership")
    .option("--json", "emit machine-readable JSON", false)
    .action(runDatabaseOwnership);
  ownership
    .command("claim")
    .description("Claim shared-state writes for the active external supervisor")
    .requiredOption("--manager <id>", "stable external manager identifier")
    .option("--json", "emit machine-readable JSON", false)
    .action(runDatabaseOwnership);
  applyParentDefaultHelpAction(ownership);
  applyParentDefaultHelpAction(database);
}
