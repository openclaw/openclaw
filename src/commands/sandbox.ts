import { confirm as clackConfirm } from "@clack/prompts";

import {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
} from "../agents/sandbox.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

// --- List Command ---

type SandboxListOptions = {
  browser: boolean;
  json: boolean;
};

export async function sandboxListCommand(
  opts: SandboxListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const containers = opts.browser
    ? []
    : await listSandboxContainers().catch(() => []);
  const browsers = opts.browser
    ? await listSandboxBrowsers().catch(() => [])
    : [];

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        { containers, browsers },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.browser) {
    if (browsers.length === 0) {
      runtime.log("No sandbox browser containers found.");
      return;
    }

    runtime.log("\n🌐 Sandbox Browser Containers:\n");
    for (const browser of browsers) {
      const status = browser.running ? "🟢 running" : "⚫ stopped";
      const imageStatus = browser.imageMatch ? "✓" : "⚠️  mismatch";
      const age = formatAge(Date.now() - browser.createdAtMs);
      const idle = formatAge(Date.now() - browser.lastUsedAtMs);

      runtime.log(`  ${browser.containerName}`);
      runtime.log(`    Status:  ${status}`);
      runtime.log(`    Image:   ${browser.image} ${imageStatus}`);
      runtime.log(`    CDP:     ${browser.cdpPort}`);
      if (browser.noVncPort) {
        runtime.log(`    noVNC:   ${browser.noVncPort}`);
      }
      runtime.log(`    Age:     ${age}`);
      runtime.log(`    Idle:    ${idle}`);
      runtime.log(`    Session: ${browser.sessionKey}`);
      runtime.log("");
    }
  } else {
    if (containers.length === 0) {
      runtime.log("No sandbox containers found.");
      return;
    }

    runtime.log("\n📦 Sandbox Containers:\n");
    for (const container of containers) {
      const status = container.running ? "🟢 running" : "⚫ stopped";
      const imageStatus = container.imageMatch ? "✓" : "⚠️  mismatch";
      const age = formatAge(Date.now() - container.createdAtMs);
      const idle = formatAge(Date.now() - container.lastUsedAtMs);

      runtime.log(`  ${container.containerName}`);
      runtime.log(`    Status:  ${status}`);
      runtime.log(`    Image:   ${container.image} ${imageStatus}`);
      runtime.log(`    Age:     ${age}`);
      runtime.log(`    Idle:    ${idle}`);
      runtime.log(`    Session: ${container.sessionKey}`);
      runtime.log("");
    }
  }

  // Summary
  const totalContainers = containers.length + browsers.length;
  const runningCount =
    containers.filter((c) => c.running).length +
    browsers.filter((b) => b.running).length;
  const mismatchCount =
    containers.filter((c) => !c.imageMatch).length +
    browsers.filter((b) => !b.imageMatch).length;

  runtime.log(`Total: ${totalContainers} (${runningCount} running)`);
  if (mismatchCount > 0) {
    runtime.log(
      `\n⚠️  ${mismatchCount} container(s) with image mismatch detected.`,
    );
    runtime.log(
      `   Run 'clawd sandbox recreate --all' to update all containers.`,
    );
  }
}

// --- Recreate Command ---

type SandboxRecreateOptions = {
  all: boolean;
  session?: string;
  agent?: string;
  browser: boolean;
  force: boolean;
};

export async function sandboxRecreateCommand(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  // Validation
  if (!opts.all && !opts.session && !opts.agent) {
    runtime.error(
      "Please specify --all, --session <key>, or --agent <id>",
    );
    runtime.exit(1);
    return;
  }

  if (
    (opts.all && opts.session) ||
    (opts.all && opts.agent) ||
    (opts.session && opts.agent)
  ) {
    runtime.error("Please specify only one of: --all, --session, --agent");
    runtime.exit(1);
    return;
  }

  // Fetch containers
  const allContainers = await listSandboxContainers().catch(() => []);
  const allBrowsers = await listSandboxBrowsers().catch(() => []);

  // Filter based on options
  let containersToRemove = opts.browser ? [] : allContainers;
  let browsersToRemove = opts.browser ? allBrowsers : [];

  if (opts.session) {
    containersToRemove = containersToRemove.filter(
      (c) => c.sessionKey === opts.session,
    );
    browsersToRemove = browsersToRemove.filter(
      (b) => b.sessionKey === opts.session,
    );
  } else if (opts.agent) {
    const agentPrefix = `agent:${opts.agent}`;
    containersToRemove = containersToRemove.filter(
      (c) => c.sessionKey === agentPrefix || c.sessionKey.startsWith(`${agentPrefix}:`),
    );
    browsersToRemove = browsersToRemove.filter(
      (b) => b.sessionKey === agentPrefix || b.sessionKey.startsWith(`${agentPrefix}:`),
    );
  }

  const totalToRemove = containersToRemove.length + browsersToRemove.length;

  if (totalToRemove === 0) {
    runtime.log("No containers found matching the criteria.");
    return;
  }

  // Show what will be removed
  runtime.log("\nContainers to be recreated:\n");

  if (containersToRemove.length > 0) {
    runtime.log("📦 Sandbox Containers:");
    for (const container of containersToRemove) {
      const status = container.running ? "running" : "stopped";
      runtime.log(`  - ${container.containerName} (${status})`);
    }
  }

  if (browsersToRemove.length > 0) {
    runtime.log("\n🌐 Browser Containers:");
    for (const browser of browsersToRemove) {
      const status = browser.running ? "running" : "stopped";
      runtime.log(`  - ${browser.containerName} (${status})`);
    }
  }

  runtime.log(`\nTotal: ${totalToRemove} container(s)`);

  // Confirmation
  if (!opts.force) {
    const shouldContinue = await clackConfirm({
      message: "This will stop and remove these containers. Continue?",
      initialValue: false,
    });

    if (!shouldContinue || shouldContinue === Symbol.for("clack:cancel")) {
      runtime.log("Cancelled.");
      return;
    }
  }

  // Remove containers
  runtime.log("\nRemoving containers...\n");

  let successCount = 0;
  let failCount = 0;

  for (const container of containersToRemove) {
    try {
      await removeSandboxContainer(container.containerName);
      runtime.log(`✓ Removed ${container.containerName}`);
      successCount++;
    } catch (err) {
      runtime.error(
        `✗ Failed to remove ${container.containerName}: ${String(err)}`,
      );
      failCount++;
    }
  }

  for (const browser of browsersToRemove) {
    try {
      await removeSandboxBrowserContainer(browser.containerName);
      runtime.log(`✓ Removed ${browser.containerName}`);
      successCount++;
    } catch (err) {
      runtime.error(
        `✗ Failed to remove ${browser.containerName}: ${String(err)}`,
      );
      failCount++;
    }
  }

  // Summary
  runtime.log(`\nDone: ${successCount} removed, ${failCount} failed`);

  if (successCount > 0) {
    runtime.log(
      "\nContainers will be automatically recreated when the agent is next used.",
    );
  }

  if (failCount > 0) {
    runtime.exit(1);
  }
}

// --- Helpers ---

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
