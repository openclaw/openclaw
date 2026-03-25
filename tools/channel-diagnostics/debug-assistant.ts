#!/usr/bin/env node
/**
 * Interactive Debug Assistant
 *
 * Helps developers debug channel issues interactively.
 */

import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

type DebugContext = {
  channelId?: string;
  issueType?: string;
  symptoms?: string[];
};

const ISSUE_TYPES = {
  connection: "Connection Issues",
  messages: "Message Delivery",
  threads: "Thread Routing",
  auth: "Authentication",
  performance: "Performance",
  other: "Other",
};

const COMMON_SOLUTIONS = {
  connection: [
    "Check network connectivity",
    "Verify credentials are correct",
    "Check if service is down: https://status.openclaw.ai",
    "Review recent changelog for connection fixes",
    "Run: openclaw channels status --probe",
  ],
  messages: [
    "Check message format and size limits",
    "Verify channel is properly configured",
    "Look for echo prevention issues",
    "Check thread ID handling",
    "Run: openclaw message send --to <target> --message 'test'",
  ],
  threads: [
    "Verify thread metadata is present",
    "Check forum/topic configuration",
    "Review thread routing logic",
    "Look for missing thread ID fallbacks",
  ],
  auth: [
    "Verify credentials are set correctly",
    "Check token expiration",
    "Review SecretRef configuration",
    "Run: openclaw channels login <channel>",
    "Check: ~/.openclaw/credentials/",
  ],
  performance: [
    "Check system resources (CPU, memory)",
    "Review log file sizes",
    "Look for rate limiting",
    "Check database performance",
    "Run: pnpm test:perf:budget",
  ],
};

const DIAGNOSTIC_COMMANDS = {
  connection: [
    "openclaw channels status --probe",
    "openclaw gateway status --deep",
    "openclaw doctor",
  ],
  messages: ["openclaw message send --to <target> --message 'test'", "openclaw channels status"],
  threads: ["openclaw sessions list", "openclaw channels status"],
  auth: ["openclaw channels login <channel>", "openclaw config get channels.<channel>"],
  performance: [
    "pnpm test:perf:budget",
    "pnpm test:perf:hotspots",
    "openclaw gateway status --deep",
  ],
};

async function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  const answer = await rl.question(`${question} `);
  return answer.trim();
}

async function selectFromList(
  rl: readline.Interface,
  prompt: string,
  options: Record<string, string>,
): Promise<string> {
  console.log(`\n${prompt}`);
  const keys = Object.keys(options);

  keys.forEach((key, index) => {
    console.log(`  ${index + 1}. ${options[key]}`);
  });

  const answer = await askQuestion(rl, "\nSelect (1-" + keys.length + "):");
  const index = parseInt(answer) - 1;

  if (index >= 0 && index < keys.length) {
    return keys[index];
  }

  return keys[0];
}

async function gatherContext(rl: readline.Interface): Promise<DebugContext> {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║          OpenClaw Debug Assistant                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Let's diagnose your issue step by step.\n");

  const context: DebugContext = {};

  // Ask about channel
  const channelAnswer = await askQuestion(
    rl,
    "Which channel are you having issues with? (e.g., telegram, discord, whatsapp):",
  );

  if (channelAnswer) {
    context.channelId = channelAnswer.toLowerCase();
  }

  // Ask about issue type
  context.issueType = await selectFromList(
    rl,
    "What type of issue are you experiencing?",
    ISSUE_TYPES,
  );

  // Ask about symptoms
  console.log("\nDescribe the symptoms (one per line, empty line to finish):");
  context.symptoms = [];

  while (true) {
    const symptom = await askQuestion(rl, "  •");
    if (!symptom) {
      break;
    }
    context.symptoms.push(symptom);
  }

  return context;
}

function provideSolutions(context: DebugContext): void {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║          Diagnostic Results                                ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Show context summary
  console.log("📋 Issue Summary:");
  if (context.channelId) {
    console.log(`   Channel: ${context.channelId}`);
  }
  if (context.issueType) {
    console.log(`   Type: ${ISSUE_TYPES[context.issueType as keyof typeof ISSUE_TYPES]}`);
  }
  if (context.symptoms && context.symptoms.length > 0) {
    console.log(`   Symptoms:`);
    context.symptoms.forEach((s) => console.log(`      • ${s}`));
  }
  console.log();

  // Provide solutions
  if (context.issueType) {
    const solutions = COMMON_SOLUTIONS[context.issueType as keyof typeof COMMON_SOLUTIONS];

    if (solutions) {
      console.log("💡 Suggested Solutions:");
      solutions.forEach((solution, index) => {
        console.log(`   ${index + 1}. ${solution}`);
      });
      console.log();
    }

    // Provide diagnostic commands
    const commands = DIAGNOSTIC_COMMANDS[context.issueType as keyof typeof DIAGNOSTIC_COMMANDS];

    if (commands) {
      console.log("🔧 Diagnostic Commands:");
      commands.forEach((cmd) => {
        console.log(`   $ ${cmd}`);
      });
      console.log();
    }
  }

  // Channel-specific advice
  if (context.channelId) {
    console.log("📚 Channel-Specific Resources:");
    console.log(`   • Docs: https://docs.openclaw.ai/channels/${context.channelId}`);
    console.log(`   • Extension: extensions/${context.channelId}/`);
    console.log(`   • Tests: pnpm test:extension ${context.channelId}`);
    console.log();
  }

  // General advice
  console.log("🔍 Additional Steps:");
  console.log("   1. Check CHANGELOG.md for recent fixes");
  console.log("   2. Run: openclaw doctor");
  console.log("   3. Check logs for detailed error messages");
  console.log("   4. Search GitHub issues: https://github.com/openclaw/openclaw/issues");
  console.log("   5. Ask in Discord: https://discord.gg/clawd");
  console.log();
}

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    const context = await gatherContext(rl);
    provideSolutions(context);

    console.log("💬 Need more help?");
    console.log("   • Discord: https://discord.gg/clawd");
    console.log("   • GitHub Issues: https://github.com/openclaw/openclaw/issues");
    console.log("   • Docs: https://docs.openclaw.ai");
    console.log();
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
