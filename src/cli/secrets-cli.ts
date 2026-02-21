import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import {
  rollbackSecretsMigration,
  runSecretsMigration,
  type SecretsMigrationRollbackResult,
  type SecretsMigrationRunResult,
} from "../secrets/migrate.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";

type SecretsReloadOptions = GatewayRpcOpts & { json?: boolean };
type SecretsMigrateOptions = {
  write?: boolean;
  rollback?: string;
  scrubEnv?: boolean;
  json?: boolean;
};

function printMigrationResult(
  result: SecretsMigrationRunResult | SecretsMigrationRollbackResult,
  json: boolean,
): void {
  if (json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }

  if ("restoredFiles" in result) {
    defaultRuntime.log(
      `Secrets rollback complete for backup ${result.backupId}. Restored ${result.restoredFiles} file(s), deleted ${result.deletedFiles} file(s).`,
    );
    return;
  }

  if (result.mode === "dry-run") {
    if (!result.changed) {
      defaultRuntime.log("Secrets migrate dry run: no changes needed.");
      return;
    }
    defaultRuntime.log(
      `Secrets migrate dry run: ${result.changedFiles.length} file(s) would change, ${result.counters.secretsWritten} secret value(s) would move to ${result.secretsFilePath}.`,
    );
    return;
  }

  if (!result.changed) {
    defaultRuntime.log("Secrets migrate: no changes applied.");
    return;
  }
  defaultRuntime.log(
    `Secrets migrated. Backup: ${result.backupId}. Moved ${result.counters.secretsWritten} secret value(s) into ${result.secretsFilePath}.`,
  );
}

export function registerSecretsCli(program: Command) {
  const secrets = program
    .command("secrets")
    .description("Secrets runtime controls")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/gateway/security", "docs.openclaw.ai/gateway/security")}\n`,
    );

  addGatewayClientOptions(
    secrets
      .command("reload")
      .description("Re-resolve secret references and atomically swap runtime snapshot")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SecretsReloadOptions) => {
    try {
      const result = await callGatewayFromCli("secrets.reload", opts, undefined, {
        expectFinal: false,
      });
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      const warningCount = Number(
        (result as { warningCount?: unknown } | undefined)?.warningCount ?? 0,
      );
      if (Number.isFinite(warningCount) && warningCount > 0) {
        defaultRuntime.log(`Secrets reloaded with ${warningCount} warning(s).`);
        return;
      }
      defaultRuntime.log("Secrets reloaded.");
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });

  secrets
    .command("migrate")
    .description("Migrate plaintext secrets to file-backed SecretRefs (sops)")
    .option("--write", "Apply migration changes (default is dry-run)", false)
    .option("--rollback <backup-id>", "Rollback a previous migration backup id")
    .option("--no-scrub-env", "Keep matching plaintext values in ~/.openclaw/.env")
    .option("--json", "Output JSON", false)
    .action(async (opts: SecretsMigrateOptions) => {
      try {
        if (typeof opts.rollback === "string" && opts.rollback.trim()) {
          const result = await rollbackSecretsMigration({ backupId: opts.rollback.trim() });
          printMigrationResult(result, Boolean(opts.json));
          return;
        }

        const result = await runSecretsMigration({
          write: Boolean(opts.write),
          scrubEnv: opts.scrubEnv ?? true,
        });
        printMigrationResult(result, Boolean(opts.json));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
