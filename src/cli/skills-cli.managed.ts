import type { Command } from "commander";
import {
  auditManagedSkills,
  listManagedSkills,
  updateManagedSkills,
} from "../agents/skills-hub/managed.js";
import { loadConfig } from "../config/config.js";
import { parseSkillFeedV1FromFile, syncHiveSkillFeed } from "../hive/skill-feed-sync.js";
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

  const hive = managed
    .command("hive")
    .description("Hive registry (optional; requires skills.hive.enabled)");
  hive
    .command("sync")
    .description("Install/update managed skills from a v1 feed manifest (ClawHub slugs only)")
    .requiredOption("--manifest <path>", "Path to skill-feed v1 JSON (version + entries)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { manifest: string; json?: boolean }) => {
      try {
        const cfg = loadConfig();
        const manifest = await parseSkillFeedV1FromFile(opts.manifest.trim());
        const result = await syncHiveSkillFeed({ cfg, manifest });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        if (result.skipped) {
          defaultRuntime.log("skills.hive.enabled is not true; nothing to do.");
          return;
        }
        for (const row of result.results) {
          if (row.ok) {
            defaultRuntime.log(`${row.slug}  ok`);
          } else {
            defaultRuntime.error(`${row.slug}  ${row.message ?? "failed"}`);
          }
        }
        if (!result.ok) {
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
