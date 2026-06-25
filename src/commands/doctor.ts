/** Top-level doctor command wrapper, including post-upgrade probe mode. */
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";
import type { DoctorOptions } from "./doctor-prompter.js";

/** Runs doctor or the post-upgrade probe submode using the provided runtime. */
export async function doctorCommand(runtime?: RuntimeEnv, options?: DoctorOptions): Promise<void> {
  if (options?.sessionSqlite) {
    const outputRuntime = runtime ?? defaultRuntime;
    const { runDoctorSessionSqlite } = await import("./doctor-session-sqlite.js");
    const report = await runDoctorSessionSqlite({
      mode: options.sessionSqlite,
      ...(options.sessionSqliteStore ? { store: options.sessionSqliteStore } : {}),
      ...(options.sessionSqliteAgent ? { agent: options.sessionSqliteAgent } : {}),
      ...(options.sessionSqliteAllAgents ? { allAgents: true } : {}),
    });
    if (options.json) {
      writeRuntimeJson(outputRuntime, report);
    } else {
      outputRuntime.log(
        `session-sqlite ${report.mode}: ${report.totals.targets} target(s), ${report.totals.legacyEntries} legacy entries, ${report.totals.sqliteEntries} sqlite entries, ${report.totals.issues} issue(s)`,
      );
      for (const target of report.targets) {
        outputRuntime.log(
          `- ${target.agentId}: imported=${target.importedEntries}/${target.importedTranscriptEvents} events, validated=${target.validatedEntries}/${target.validatedTranscriptEvents} events, unreferenced-jsonl=${target.unreferencedJsonlFiles.length}`,
        );
        for (const issue of target.issues.slice(0, 10)) {
          outputRuntime.log(
            `  [${issue.code}]${issue.sessionKey ? ` ${issue.sessionKey}:` : ""} ${issue.message}`,
          );
        }
        if (target.issues.length > 10) {
          outputRuntime.log(`  ...and ${target.issues.length - 10} more issue(s)`);
        }
      }
    }
    outputRuntime.exit(report.totals.issues > 0 ? 1 : 0);
    return;
  }
  if (options?.postUpgrade) {
    const outputRuntime = runtime ?? defaultRuntime;
    const report = await runPostUpgradeProbes({});
    if (options.json) {
      writeRuntimeJson(outputRuntime, report);
    } else {
      for (const f of report.findings) {
        outputRuntime.log(`[${f.level}] ${f.code}: ${f.message}`);
      }
      if (report.findings.length === 0) {
        outputRuntime.log("post-upgrade: no findings");
      }
    }
    const hasError = report.findings.some((f) => f.level === "error");
    outputRuntime.exit(hasError ? 1 : 0);
    return;
  }
  const doctorHealth = await import("../flows/doctor-health.js");
  await doctorHealth.doctorCommand(runtime, options);
}
