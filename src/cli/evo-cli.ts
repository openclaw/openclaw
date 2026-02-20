import type { Command } from "commander";
import { EvoDaemon, isDaemonRunning, readDaemonStatus } from "../agents/evo-daemon.js";
import { EvolutionaryEngine } from "../agents/self-evolution.js";
import { getSharedMetricsCollector } from "../agents/self-metrics.js";
import { runSelfRepair, runHealthCheck } from "../agents/self-repair.js";
import { SelfReplicationEngine } from "../agents/self-replication.js";
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
        warn(`Health check failed: ${String(error)}`);
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
        warn(`Self-repair failed: ${String(error)}`);
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
        warn(`Evolution failed: ${String(error)}`);
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
        console.log(`Status check failed: ${String(error)}`);
      }
    });
  // ---------------------------------------------------------------------------
  // evo daemon
  // ---------------------------------------------------------------------------
  const daemon = evo.command("daemon").description("Autonomous self-management daemon");

  daemon
    .command("start")
    .description("Start the evo daemon (self-repair + evolution + replication)")
    .option("-r, --repair-interval <ms>", "Repair interval in ms", "300000")
    .option("-e, --evolve-interval <ms>", "Evolve interval in ms", "3600000")
    .action(async (opts: { repairInterval: string; evolveInterval: string }) => {
      info("Starting evo daemon...");
      const d = new EvoDaemon({
        repairIntervalMs: parseInt(opts.repairInterval, 10),
        evolveIntervalMs: parseInt(opts.evolveInterval, 10),
      });
      const started = await d.start();
      if (!started) {
        warn("Daemon is already running (or lock file exists). Use 'evo daemon status'.");
        process.exit(1);
      }
      success("Daemon started. PID: " + process.pid);
      // Keep alive — stop when signalled
      process.on("SIGINT", () => void d.stop().then(() => process.exit(0)));
      process.on("SIGTERM", () => void d.stop().then(() => process.exit(0)));
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      const running = await isDaemonRunning();
      const status = await readDaemonStatus();

      console.log("\n=== EvoDaemon Status ===");
      console.log(`  Running  : ${running ? "✓ YES" : "✗ NO"}`);

      if (status) {
        console.log(`  PID      : ${status.pid ?? "—"}`);
        console.log(
          `  Started  : ${status.startedAt ? new Date(status.startedAt).toLocaleString() : "—"}`,
        );
        console.log(`  Repairs  : ${status.repairCount}`);
        console.log(`  Evolves  : ${status.evolveCount}`);
        console.log(`  Clones   : ${status.cloneCount}`);
        console.log(
          `  BestFit  : ${status.bestFitness !== null ? status.bestFitness.toFixed(4) : "—"}`,
        );
        console.log(`  Gen      : ${status.currentGeneration}`);
      } else {
        console.log("  No status file found.");
      }
      console.log("");
      process.exit(0);
    });

  // ---------------------------------------------------------------------------
  // evo clone
  // ---------------------------------------------------------------------------
  const clone = evo.command("clone").description("Self-replication management");

  clone
    .command("list")
    .description("List all agent clones")
    .action(async () => {
      const engine = new SelfReplicationEngine();
      await engine.loadManifest();
      const clones = engine.getClones();

      if (clones.length === 0) {
        info("No clones found. Run 'evo daemon start' to begin self-replication.");
        return;
      }

      console.log(`\n=== Agent Clones (${clones.length}/${engine.getMaxClones()} max) ===\n`);
      for (const c of [...clones].toSorted((a, b) => b.fitness - a.fitness)) {
        const age = Math.round((Date.now() - c.createdAt) / 60_000);
        console.log(
          `  ${c.id.slice(0, 24)}  fit=${c.fitness.toFixed(4)}  gen=${c.generation}  age=${age}m`,
        );
        console.log(`    ${c.dir}`);
      }
      console.log("");
    });

  clone
    .command("prune")
    .description("Remove lowest-fitness clones, keeping the top N")
    .option("-k, --keep <n>", "Number of clones to keep", "3")
    .action(async (opts: { keep: string }) => {
      const keepCount = parseInt(opts.keep, 10);
      const engine = new SelfReplicationEngine();
      await engine.loadManifest();
      const removed = await engine.pruneWeakClones(keepCount);
      success(`Pruned ${removed} clone(s). ${engine.getClones().length} remaining.`);
    });

  clone
    .command("spawn")
    .description("Manually spawn a clone from the current best config")
    .action(async () => {
      info("Spawning new agent clone...");
      const snapshot = await readConfigFileSnapshot();
      const engine = new SelfReplicationEngine();
      await engine.loadManifest();
      const record = await engine.spawnClone(snapshot.config);
      if (!record) {
        warn(`Clone cap (${engine.getMaxClones()}) reached. Run 'evo clone prune' first.`);
        process.exit(1);
      }
      success(`Spawned clone: ${record.id}`);
      console.log(`  Dir: ${record.dir}`);
    });

  // ---------------------------------------------------------------------------
  // evo metrics
  // ---------------------------------------------------------------------------
  evo
    .command("metrics")
    .description("Show current agent performance metrics")
    .action(async () => {
      const collector = getSharedMetricsCollector();
      await collector.load();
      const m = collector.compute();

      console.log("\n=== Agent Performance Metrics ===\n");
      if (m.sampleSize === 0) {
        info("No metrics recorded yet. Metrics accumulate as the agent handles tasks.");
        return;
      }
      console.log(`  Sample size       : ${m.sampleSize} calls`);
      console.log(`  Avg response time : ${m.avgResponseTimeMs.toFixed(0)} ms`);
      console.log(`  Error rate        : ${(m.errorRate * 100).toFixed(1)}%`);
      console.log(`  Task completion   : ${(m.taskCompletionRate * 100).toFixed(1)}%`);
      console.log(`  Memory pressure   : ${(m.memoryPressure * 100).toFixed(1)}%`);
      console.log(`  Last updated      : ${new Date(m.lastUpdatedAt).toLocaleString()}`);
      console.log("");
    });
}
