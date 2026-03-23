import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import { getResearchArtifactStats, getResearchPolicy } from "../research/events/writer.js";
import { exportTrajectoryV1 } from "../research/trajectory/export.js";

export function registerResearchCli(program: Command): void {
  const research = program.command("research").description("Research telemetry helpers");

  research
    .command("stats")
    .description("Print effective research policy and artifact stats")
    .option("--json", "Output machine-readable JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const cfg = loadConfig();
      const policy = getResearchPolicy(cfg);
      const { stats } = await getResearchArtifactStats(cfg);
      const payload = { policy, stats };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Research enabled: ${policy.enabled ? "yes" : "no"}`);
      console.log(`TTL days: ${policy.ttlDays}`);
      console.log(`Max bytes: ${policy.maxBytes}`);
      console.log(`Root: ${stats.root}`);
      console.log(`Files: ${stats.fileCount}`);
      console.log(`Total bytes: ${stats.totalBytes}`);
      console.log(
        `Last write: ${stats.lastWriteTimeMs ? new Date(stats.lastWriteTimeMs).toISOString() : "n/a"}`,
      );
    });

  research
    .command("export")
    .description("Export deterministic trajectory JSON for a session")
    .requiredOption("--session <sessionId>", "Session ID to export")
    .option("--agent <agentId>", "Agent ID for transcript/events lookup", "default")
    .option("--session-key <sessionKey>", "Optional session key to include")
    .option("--out <path>", "Optional output path")
    .action(
      async (opts: { session: string; agent?: string; sessionKey?: string; out?: string }) => {
        const result = await exportTrajectoryV1({
          agentId: opts.agent ?? "default",
          sessionId: opts.session,
          sessionKey: opts.sessionKey,
          outputPath: opts.out,
        });
        console.log(result.outputPath);
      },
    );
}
