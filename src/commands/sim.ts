import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import { deriveScenario, loadScenario, runSimulation } from "../simulation/index.js";

export function registerSimCli(program: Command) {
  const sim = program.command("sim").description("Gateway simulation harness");

  sim
    .command("run")
    .description("Run a simulation scenario")
    .argument("<scenario>", "Path to scenario YAML file")
    .option("--verbose", "Stream diagnostic events to stderr", false)
    .option("--out <dir>", "Output directory for report files")
    .option("--seed <number>", "Override scenario seed for reproducibility")
    .action(
      async (
        scenarioPath: string,
        opts: {
          verbose: boolean;
          out?: string;
          seed?: string;
        },
      ) => {
        const resolvedPath = resolve(scenarioPath);
        if (!existsSync(resolvedPath)) {
          console.error(`Scenario file not found: ${resolvedPath}`);
          process.exitCode = 1;
          return;
        }

        const base = loadScenario(resolvedPath);
        const scenario =
          opts.seed !== undefined
            ? deriveScenario(base, { seed: Number.parseInt(opts.seed, 10) })
            : base;

        const controller = new AbortController();
        process.on("SIGINT", () => controller.abort());
        process.on("SIGTERM", () => controller.abort());

        const report = await runSimulation(scenario, {
          signal: controller.signal,
          verbose: opts.verbose,
          onEvent: opts.verbose ? (msg) => process.stderr.write(`${msg}\n`) : undefined,
        });

        // Output report
        const json = JSON.stringify(report, null, 2);
        if (opts.out) {
          const outDir = resolve(opts.out);
          const safeName = basename(report.scenario).replace(/[^\w\-. ]/g, "_");
          const outPath = join(outDir, `sim-report-${safeName}.json`);
          writeFileSync(outPath, json);
          console.log(`Report written to ${outPath}`);
        } else {
          console.log(json);
        }

        // Exit with non-zero if any assertions failed
        const failed = report.assertions.filter((a) => !a.passed);
        if (failed.length > 0) {
          console.error(`\n${failed.length} assertion(s) failed:`);
          for (const f of failed) {
            console.error(`  - ${f.name}: actual=${f.actual} threshold=${f.threshold}`);
          }
          process.exitCode = 1;
        }
      },
    );

  sim
    .command("validate")
    .description("Validate a scenario YAML file without running it")
    .argument("<scenario>", "Path to scenario YAML file")
    .action((scenarioPath: string) => {
      const resolvedPath = resolve(scenarioPath);
      if (!existsSync(resolvedPath)) {
        console.error(`Scenario file not found: ${resolvedPath}`);
        process.exitCode = 1;
        return;
      }
      try {
        loadScenario(resolvedPath);
        console.log(`Valid scenario: ${resolvedPath}`);
      } catch (err) {
        console.error(`Invalid scenario: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  sim
    .command("list")
    .description("List available scenario files")
    .option("--dir <path>", "Directory to search for scenarios", "scenarios/examples")
    .action((opts: { dir: string }) => {
      const dir = resolve(opts.dir);
      if (!existsSync(dir)) {
        console.error(`Scenarios directory not found: ${dir}`);
        process.exitCode = 1;
        return;
      }
      const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
      if (files.length === 0) {
        console.log("No scenario files found.");
        return;
      }
      console.log("Available scenarios:");
      for (const f of files) {
        console.log(`  ${join(dir, f)}`);
      }
    });
}
