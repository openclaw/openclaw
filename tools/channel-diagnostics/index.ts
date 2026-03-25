#!/usr/bin/env node
/**
 * Channel Diagnostics Toolkit - Main Entry Point
 *
 * Usage:
 *   node --import tsx tools/channel-diagnostics/index.ts <command>
 *
 * Commands:
 *   health       - Run health check
 *   errors       - Analyze error patterns
 *   generate     - Generate tests for a channel
 *   debug        - Interactive debug assistant
 *   help         - Show this help message
 */

const commands = {
  health: "./health-check.ts",
  errors: "./error-analyzer.ts",
  generate: "./test-generator.ts",
  debug: "./debug-assistant.ts",
};

async function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     OpenClaw Channel Diagnostics Toolkit                  ║
╚════════════════════════════════════════════════════════════╝

Usage:
  node --import tsx tools/channel-diagnostics/index.ts <command>

Commands:
  health       Run health check on all channels
  errors       Analyze error patterns from changelog
  generate     Generate test suite for a channel
  debug        Interactive debug assistant
  help         Show this help message

Examples:
  # Check channel health
  node --import tsx tools/channel-diagnostics/index.ts health

  # Analyze errors
  node --import tsx tools/channel-diagnostics/index.ts errors

  # Generate tests
  node --import tsx tools/channel-diagnostics/index.ts generate --channel telegram

  # Interactive debug
  node --import tsx tools/channel-diagnostics/index.ts debug

Quick Start:
  See QUICKSTART.md for detailed usage instructions

Documentation:
  • README.md - Main documentation
  • QUICKSTART.md - Quick start guide
  • EXAMPLES.md - Real-world examples
  • CONTRIBUTING_TO_TOOLKIT.md - Contribution guidelines

Support:
  • Discord: https://discord.gg/clawd
  • GitHub: https://github.com/openclaw/openclaw
  • Docs: https://docs.openclaw.ai
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    await showHelp();
    process.exit(0);
  }

  if (!(command in commands)) {
    console.error(`❌ Unknown command: ${command}`);
    console.log("\nRun 'node --import tsx tools/channel-diagnostics/index.ts help' for usage\n");
    process.exit(1);
  }

  // Dynamic import and run the command
  const modulePath = commands[command as keyof typeof commands];

  try {
    // Re-run with the specific tool
    const { spawn } = await import("node:child_process");
    const child = spawn("node", ["--import", "tsx", modulePath, ...args.slice(1)], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    child.on("exit", (code) => {
      process.exit(code || 0);
    });
  } catch (error) {
    console.error(`❌ Failed to run command: ${String(error)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
