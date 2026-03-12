import type { Command } from "commander";
import {
  migratePersistenceToPostgres,
  type StorageVerificationSummary,
  verifyPostgresPersistence,
} from "../persistence/storage.js";
import { defaultRuntime } from "../runtime.js";

type StorageMigrateOptions = {
  to?: string;
  dryRun?: boolean;
  json?: boolean;
};

type StorageVerifyOptions = {
  json?: boolean;
};

function printMigrationSummary(
  summary: Awaited<ReturnType<typeof migratePersistenceToPostgres>>,
): void {
  defaultRuntime.log(
    [
      `dryRun=${summary.dryRun}`,
      `sessionStores=${summary.sessionStores}`,
      `sessions=${summary.sessions}`,
      `transcripts=${summary.transcripts}`,
      `transcriptEvents=${summary.transcriptEvents}`,
      `authStores=${summary.authStores}`,
      `subagentRuns=${summary.subagentRuns}`,
      `memoryDocuments=${summary.memoryDocuments}`,
    ].join(" "),
  );
}

function printVerificationSummary(report: StorageVerificationSummary): void {
  defaultRuntime.log(
    [
      `sessions=${report.postgres.sessions}/${report.discovered.sessions}`,
      `sessionEvents=${report.postgres.sessionEvents}/${report.discovered.transcriptEvents}`,
      `authProfiles=${report.postgres.authProfiles}/${report.discovered.authStores}`,
      `subagentRuns=${report.postgres.subagentRuns}/${report.discovered.subagentRuns}`,
      `memoryDocuments=${report.postgres.memoryDocuments}/${report.discovered.memoryDocuments}`,
      `matches=${report.matches}`,
    ].join(" "),
  );
  if (report.matches) {
    return;
  }
  for (const mismatch of report.mismatches.slice(0, 20)) {
    defaultRuntime.error(
      `${mismatch.kind} key=${mismatch.key} expected=${mismatch.expected} actual=${mismatch.actual}`,
    );
  }
  if (report.mismatches.length > 20) {
    defaultRuntime.error(`... ${report.mismatches.length - 20} more mismatch(es) omitted`);
  }
}

export function registerStorageCli(program: Command): void {
  const storage = program.command("storage").description("Migrate and verify persistence backends");

  storage
    .command("migrate")
    .description("Import file-backed state into PostgreSQL persistence")
    .requiredOption("--to <backend>", 'Target backend (currently only "postgres")')
    .option("--dry-run", "Scan and summarize without writing to PostgreSQL", false)
    .option("--json", "Output JSON", false)
    .action(async (opts: StorageMigrateOptions) => {
      if (opts.to !== "postgres") {
        defaultRuntime.error(`Unsupported storage backend: ${opts.to ?? "<missing>"}`);
        defaultRuntime.exit(1);
      }
      try {
        const summary = await migratePersistenceToPostgres({
          dryRun: Boolean(opts.dryRun),
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(summary, null, 2));
          return;
        }
        printMigrationSummary(summary);
      } catch (error) {
        defaultRuntime.error(error instanceof Error ? error.message : String(error));
        defaultRuntime.exit(1);
      }
    });

  storage
    .command("verify")
    .description("Compare discovered file-backed artifacts with PostgreSQL counts")
    .option("--json", "Output JSON", false)
    .action(async (opts: StorageVerifyOptions) => {
      try {
        const report = await verifyPostgresPersistence();
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(report, null, 2));
          if (!report.matches) {
            defaultRuntime.exit(1);
          }
          return;
        }
        printVerificationSummary(report);
        if (!report.matches) {
          defaultRuntime.exit(1);
        }
      } catch (error) {
        defaultRuntime.error(error instanceof Error ? error.message : String(error));
        defaultRuntime.exit(1);
      }
    });
}
