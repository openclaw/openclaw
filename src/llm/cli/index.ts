#!/usr/bin/env node
/**
 * LLM Guardrails CLI
 *
 * Usage:
 *   npx tsx src/llm/cli/index.ts measure [--hours 48] [--threshold 0.05]
 *   npx tsx src/llm/cli/index.ts evaluate [--format table|json|markdown]
 *   npx tsx src/llm/cli/index.ts export [--output metrics.json]
 *   npx tsx src/llm/cli/index.ts health
 *   npx tsx src/llm/cli/index.ts reset
 *   npx tsx src/llm/cli/index.ts example
 */

import {
  runMeasurement,
  evaluateDecisionGate,
  exportMetrics,
  checkHealth,
  resetTracking,
  runExample,
  type DecisionGateCLIOptions,
} from "./decision-gate.js";

type Command = DecisionGateCLIOptions["command"] | "example";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] as Command | undefined;

  if (!command || command === "--help" || command === "-h") {
    console.log(`
LLM Guardrails CLI — Phase 3: 48-Hour Error Rate Measurement

Commands:
  measure [--hours N] [--threshold 0.05] [--output file.json]
    Run 48-hour (or custom duration) error rate measurement

  evaluate [--format json|table|markdown] [--output file]
    Evaluate decision gate immediately and show recommendation

  export [--format json|table] [--output file]
    Export current metrics

  health [--format json|table|markdown]
    Run health checks

  reset
    Reset all tracking data (starts fresh measurement)

  example
    Run example demonstrating all guardrails features

Options:
  --hours N          Measurement window in hours (default: 48)
  --threshold N      Error rate threshold 0-1 (default: 0.05)
  --format FORMAT    Output format: json, table, markdown (default: json)
  --output FILE      Write output to file
  --quiet            Suppress console output
  --helicone         Enable Helicone observability (default: true)

Environment Variables:
  OPENAI_API_KEY     Required for LLM calls
  HELICONE_API_KEY   Required for observability
  
Examples:
  npx tsx src/llm/cli/index.ts measure --hours 24 --threshold 0.03
  npx tsx src/llm/cli/index.ts evaluate --format table
  npx tsx src/llm/cli/index.ts health --format markdown
`);
    process.exit(0);
  }

  // Parse options
  const options: DecisionGateCLIOptions = {
    command: command as DecisionGateCLIOptions["command"],
    config: {},
    format: "json",
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--hours":
        options.config = { ...options.config, measurementWindowHours: parseInt(args[++i], 10) };
        break;
      case "--threshold":
        options.config = { ...options.config, errorRateThreshold: parseFloat(args[++i]) };
        break;
      case "--format":
        options.format = args[++i] as "json" | "table" | "markdown";
        break;
      case "--output":
        options.output = args[++i];
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--helicone":
        options.config = { ...options.config, enableHelicone: true };
        break;
      case "--no-helicone":
        options.config = { ...options.config, enableHelicone: false };
        break;
    }
  }

  try {
    switch (command) {
      case "measure":
        await runMeasurement(options);
        break;
      case "evaluate":
        await evaluateDecisionGate(options);
        break;
      case "export":
        await exportMetrics(options);
        break;
      case "health":
        await checkHealth(options);
        break;
      case "reset":
        await resetTracking(options);
        break;
      case "example":
        await runExample();
        break;
      default:
        console.error(`Unknown command: ${String(command)}`);
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", (error as Error).message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
