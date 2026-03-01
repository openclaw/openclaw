import type { Command } from "commander";
import {
  computeSavingsMetrics,
  fmtTokens,
  pct,
  readSavingsLedger,
  recordAdaptiveRun,
  savingsFilePath,
} from "../agents/adaptive-routing-savings.js";
import { resolveStateDir } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";

export function registerAdaptiveRoutingCli(program: Command) {
  const ar = program
    .command("adaptive-routing")
    .description("Adaptive Model Routing management and token savings stats")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw adaptive-routing stats", "Show token savings summary."],
          ["openclaw adaptive-routing stats --json", "Output savings as JSON."],
          ["openclaw adaptive-routing stats --reset", "Reset the savings ledger."],
        ])}\n`,
    );

  ar.command("stats")
    .description("Show token usage savings from adaptive model routing")
    .option("--json", "Output as JSON", false)
    .option("--reset", "Reset the savings ledger after displaying it", false)
    .action(async (opts: { json?: boolean; reset?: boolean }) => {
      const stateDir = resolveStateDir();
      const ledger = await readSavingsLedger(stateDir);
      const m = computeSavingsMetrics(ledger);

      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify({ ...m, ledgerFile: savingsFilePath(stateDir) }, null, 2),
        );
      } else {
        printStats(m, savingsFilePath(stateDir));
      }

      if (opts.reset) {
        // Overwrite with a fresh ledger but preserve 'since' as now.
        await recordAdaptiveRun(stateDir, { kind: "bypassed" }); // touch file
        const fresh = await readSavingsLedger(stateDir);
        fresh.totals = {
          runsTotal: 0,
          runsLocal: 0,
          runsEscalated: 0,
          runsBypassed: 0,
          localTokensInput: 0,
          localTokensOutput: 0,
          localTokensCacheRead: 0,
          cloudTokensInput: 0,
          cloudTokensOutput: 0,
        };
        fresh.since = new Date().toISOString();
        fresh.lastUpdated = fresh.since;
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { default: path } = await import("node:path");
        await mkdir(path.dirname(savingsFilePath(stateDir)), { recursive: true });
        await writeFile(savingsFilePath(stateDir), JSON.stringify(fresh, null, 2), "utf8");
        defaultRuntime.log(theme.success("\nLedger reset."));
      }
    });
}

function printStats(m: ReturnType<typeof computeSavingsMetrics>, ledgerFile: string): void {
  const rich = process.stdout.isTTY;
  const t = (color: (s: string) => string, s: string) => (rich ? color(s) : s);

  const lines: string[] = [];
  lines.push("");
  lines.push(t(theme.heading, "  Adaptive Model Routing — Token Savings"));
  lines.push(`  ${t(theme.muted, `Ledger: ${ledgerFile}`)}`);
  lines.push(`  ${t(theme.muted, `Since: ${new Date(m.since).toLocaleString()}`)}`);
  lines.push(`  ${t(theme.muted, `Last updated: ${new Date(m.lastUpdated).toLocaleString()}`)}`);
  lines.push("");

  // Runs breakdown
  lines.push(t(theme.heading, "  Run Counts"));
  lines.push(`  ${"Total AR runs".padEnd(24)} ${t(theme.accent, String(m.runsTotal))}`);
  lines.push(
    `  ${"Local success".padEnd(24)} ${t(theme.success, String(m.runsLocal))}  (${pct(m.runsLocal, m.runsTotal)} handled locally)`,
  );
  lines.push(
    `  ${"Escalated to cloud".padEnd(24)} ${t(theme.warn, String(m.runsEscalated))}  (${pct(m.runsEscalated, m.runsTotal)} escalated)`,
  );
  lines.push(`  ${"Bypassed (override)".padEnd(24)} ${t(theme.muted, String(m.runsBypassed))}`);
  lines.push("");

  // Token breakdown
  lines.push(t(theme.heading, "  Token Usage"));
  lines.push(`  ${"Local tokens (total)".padEnd(24)} ${t(theme.accent, fmtTokens(m.localTotal))}`);
  lines.push(`  ${"Cloud tokens (total)".padEnd(24)} ${t(theme.warn, fmtTokens(m.cloudTotal))}`);
  lines.push("");

  // Savings highlight
  lines.push(t(theme.heading, "  Savings Estimate"));
  if (m.cloudSavedTokens > 0) {
    lines.push(
      `  ${"Cloud tokens saved".padEnd(24)} ${t(theme.success, `~${fmtTokens(m.cloudSavedTokens)}`)}  (local-only runs, not charged to cloud)`,
    );
  } else {
    lines.push(
      `  ${t(theme.muted, "No savings recorded yet. Run at least one successful local-model turn.")}`,
    );
  }
  lines.push(`  ${"Local success rate".padEnd(24)} ${t(theme.success, m.savingsRate)}`);
  lines.push("");

  if (m.runsTotal === 0) {
    lines.push(
      `  ${t(theme.muted, "No adaptive routing runs yet. Enable via agents.defaults.model.adaptiveRouting.enabled=true.")}`,
    );
    lines.push("");
  }

  defaultRuntime.log(lines.join("\n"));
}
