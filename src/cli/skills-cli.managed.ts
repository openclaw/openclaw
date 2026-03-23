import type { Command } from "commander";
import {
  auditManagedSkills,
  listManagedSkills,
  updateManagedSkills,
} from "../agents/skills-hub/managed.js";
import { defaultRuntime } from "../runtime.js";

type ManagedListOptions = { json?: boolean };
type ManagedUpdateOptions = { json?: boolean; force?: boolean };

export function registerManagedSkillsCli(skills: Command): void {
  const managed = skills.command("managed").description("Manage OpenClaw-managed skills");

  managed
    .command("list")
    .description("List managed skills and provenance lock data")
    .option("--json", "Output as JSON", false)
    .action(async (opts: ManagedListOptions) => {
      try {
        const rows = await listManagedSkills();
        if (opts.json) {
          defaultRuntime.writeJson({ rows });
          return;
        }
        if (rows.length === 0) {
          defaultRuntime.log("No managed skills tracked.");
          return;
        }
        for (const row of rows) {
          const source = row.lock?.source ?? "unknown";
          const ref = row.lock?.ref ?? "unknown";
          const status = row.exists ? "present" : "missing";
          defaultRuntime.log(`${row.name}  ${source}@${ref}  ${status}`);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  managed
    .command("audit")
    .description("Scan managed skills and refresh lockfile verdicts")
    .option("--json", "Output as JSON", false)
    .action(async (opts: ManagedListOptions) => {
      try {
        const result = await auditManagedSkills();
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        if (result.rows.length === 0) {
          defaultRuntime.log("No managed skills tracked.");
          return;
        }
        for (const row of result.rows) {
          const summary = result.summaries[row.name];
          if (!summary) {
            defaultRuntime.log(`${row.name}  skipped`);
            continue;
          }
          defaultRuntime.log(
            `${row.name}  critical=${summary.critical} warn=${summary.warn} info=${summary.info}`,
          );
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  managed
    .command("update")
    .description("Update managed skills using lockfile provenance")
    .option("--force", "Allow updates with critical findings", false)
    .option("--json", "Output as JSON", false)
    .action(async (opts: ManagedUpdateOptions) => {
      try {
        const results = await updateManagedSkills({ force: Boolean(opts.force) });
        if (opts.json) {
          defaultRuntime.writeJson({ results });
          return;
        }
        if (results.length === 0) {
          defaultRuntime.log("No managed skills tracked.");
          return;
        }
        for (const row of results) {
          if (row.ok) {
            defaultRuntime.log(`${row.name}  updated`);
          } else {
            defaultRuntime.error(`${row.name}  ${row.message}`);
          }
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
