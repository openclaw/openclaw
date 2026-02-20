import type { Command } from "commander";
import { EvolutionaryEngine } from "../agents/self-evolution.js";
import { runSelfRepair, runHealthCheck } from "../agents/self-repair.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { info, success, warn } from "../globals.js";

export function registerEvoCommands(program: Command): void {
  const evo = program.command("evo").description("Self-evolution and self-repair commands");

  evo
    .command("health")
    .description("Run health checks on current configuration")
    .action(async () => {
      info("Running health checks...");

      try {
        const checks = await runHealthCheck();

        console.log("\n=== Health Check Results ===\n");

        let hasWarning = false;
        let hasCritical = false;

        for (const check of checks) {
          const icon = check.status === "healthy" ? "✓" : check.status === "warning" ? "⚠" : "✗";

          console.log(`${icon} [${check.status.toUpperCase()}] ${check.name}`);
          console.log(`   ${check.message}`);

          if (check.suggestion) {
            console.log(`   Suggestion: ${check.suggestion}`);
          }
          console.log("");

          if (check.status === "warning") {
            hasWarning = true;
          }
          if (check.status === "critical") {
            hasCritical = true;
          }
        }

        if (hasCritical) {
          warn("Critical issues found. Run 'openclaw evo repair' to fix.");
          process.exit(1);
        } else if (hasWarning) {
          warn("Warnings found. Run 'openclaw evo repair' to optimize.");
        } else {
          success("All checks passed!");
        }
      } catch (error) {
        warn(`Health check failed: ${error}`);
        process.exit(1);
      }
    });

  evo
    .command("repair")
    .description("Automatically repair configuration issues")
    .action(async () => {
      info("Running self-repair...");

      try {
        const result = await runSelfRepair();

        console.log("\n=== Repair Results ===\n");

        if (result.success) {
          if (result.repairs.length === 0) {
            info("No repairs needed. Configuration is healthy.");
          } else {
            success(`Completed ${result.repairs.length} repair(s):`);

            for (const repair of result.repairs) {
              console.log(`\n  [${repair.type}] ${repair.description}`);
              console.log(`     Before: ${JSON.stringify(repair.before)}`);
              console.log(`     After: ${JSON.stringify(repair.after)}`);
            }

            console.log("\nConfiguration saved successfully.");
          }
        } else {
          warn("Repair completed with errors:");
          for (const error of result.errors) {
            console.log(`  - ${error}`);
          }
          process.exit(1);
        }
      } catch (error) {
        warn(`Self-repair failed: ${error}`);
        process.exit(1);
      }
    });

  evo
    .command("evolve")
    .description("Run evolutionary optimization of configuration")
    .option("-g, --generations <number>", "Number of generations", "10")
    .option("-p, --population <number>", "Population size", "10")
    .action(async (opts: { generations: string; population: string }) => {
      info("Starting evolutionary optimization...");

      try {
        const snapshot = await readConfigFileSnapshot();
        const initialConfig = snapshot.config;

        const generations = parseInt(opts.generations, 10);
        const population = parseInt(opts.population, 10);

        console.log(`\n=== Evolution Configuration ===`);
        console.log(`Initial population: ${population}`);
        console.log(`Generations: ${generations}`);
        console.log("");

        const engine = new EvolutionaryEngine({
          populationSize: population,
          maxGenerations: generations,
        });

        await engine.initialize(initialConfig);

        for (let g = 0; g < generations; g++) {
          const best = await engine.evolve();

          if (best) {
            console.log(`\nGeneration ${g + 1}/${generations}:`);
            console.log(`  Best fitness: ${best.fitness.toFixed(4)}`);
            console.log(`  Mutations: ${best.mutations.join(", ") || "none"}`);
          }
        }

        const finalBest = engine.getBestIndividual();
        if (finalBest) {
          console.log("\n=== Evolution Complete ===");
          console.log(`Best fitness achieved: ${finalBest.fitness.toFixed(4)}`);
          console.log(`Generation: ${finalBest.generation}`);

          await engine.saveBestConfig();
          success("Best configuration saved!");
        }
      } catch (error) {
        warn(`Evolution failed: ${error}`);
        process.exit(1);
      }
    });

  evo
    .command("status")
    .description("Show evolution and repair status")
    .action(async () => {
      console.log("=== OpenClaw Self-Management Status ===\n");

      try {
        const healthChecks = await runHealthCheck();

        console.log("Health Status:");
        for (const check of healthChecks) {
          const icon = check.status === "healthy" ? "✓" : check.status === "warning" ? "⚠" : "✗";
          console.log(`  ${icon} ${check.name}: ${check.status}`);
        }

        console.log("\nUse commands:");
        console.log("  openclaw evo health  - Run health checks");
        console.log("  openclaw evo repair  - Auto-repair issues");
        console.log("  openclaw evo evolve  - Run optimization");
      } catch (error) {
        console.log(`Status check failed: ${error}`);
      }
    });
}
