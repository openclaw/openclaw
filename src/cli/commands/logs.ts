/**
 * Audit log querying CLI commands.
 *
 * Provides read access to security audit events for operators and auditors.
 * CMMC CP-11: audit logs must be queryable and exportable.
 */

import type { Command } from "commander";
import { AuditLogger, type AuditEventType, type AuditEntry } from "../../logging/audit-logger.js";
import { theme } from "../../terminal/theme.js";

/** Shared in-process audit logger (replace with persistent sink in prod). */
export let sharedAuditLogger = new AuditLogger();

export function registerLogsCli(program: Command): void {
  const logs = program.command("logs").description("Audit log management (CMMC CP-11)");

  // ── logs query ──────────────────────────────────────────────────────────
  logs
    .command("query")
    .description("Query security audit log entries")
    .option("--subject <subject>", "Filter by subject (who acted)")
    .option("--action <action>", "Filter by event type")
    .option("--outcome <outcome>", "Filter by outcome: success | failure | denied")
    .option("--since <iso>", "Filter entries at or after this ISO-8601 timestamp")
    .option("--until <iso>", "Filter entries at or before this ISO-8601 timestamp")
    .option("--limit <n>", "Return at most N most-recent entries", parseInt)
    .option("--json", "Output as JSON")
    .action(
      (opts: {
        subject?: string;
        action?: string;
        outcome?: string;
        since?: string;
        until?: string;
        limit?: number;
        json?: boolean;
      }) => {
        try {
          const entries = sharedAuditLogger.query({
            subject: opts.subject,
            action: opts.action as AuditEventType | undefined,
            outcome: opts.outcome as AuditEntry["outcome"] | undefined,
            since: opts.since,
            until: opts.until,
            limit: opts.limit,
          });

          if (opts.json) {
            console.log(JSON.stringify(entries, null, 2));
          } else {
            if (entries.length === 0) {
              console.log(theme.muted("No entries match the query."));
              return;
            }
            for (const e of entries) {
              console.log(
                `[${e.timestamp}] seq=${e.seq} ${e.subject} -> ${e.object} | ${e.action} | ${e.outcome}`,
              );
            }
          }
        } catch (err) {
          console.error(theme.error(String(err)));
          process.exitCode = 1;
        }
      },
    );

  // ── logs verify ─────────────────────────────────────────────────────────
  logs
    .command("verify")
    .description("Verify audit log hash chain integrity")
    .option("--json", "Output result as JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const result = sharedAuditLogger.verifyIntegrity();
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.valid) {
          console.log(theme.success(`Audit log integrity OK (${sharedAuditLogger.size} entries)`));
        } else {
          console.error(theme.error(`Audit log integrity FAILED: ${result.error}`));
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(theme.error(String(err)));
        process.exitCode = 1;
      }
    });

  // ── logs stats ──────────────────────────────────────────────────────────
  logs
    .command("stats")
    .description("Show audit log statistics")
    .action(() => {
      const total = sharedAuditLogger.size;
      console.log(`Total audit entries: ${total}`);
    });
}
