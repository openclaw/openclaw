import { confirm as clackConfirm } from "@clack/prompts";

import {
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
} from "../agents/sandbox.js";
import type { RuntimeEnv } from "../runtime.js";

// --- Types ---

type SandboxListOptions = {
  browser: boolean;
  json: boolean;
};

type SandboxRecreateOptions = {
  all: boolean;
  session?: string;
  agent?: string;
  browser: boolean;
  force: boolean;
};

type ContainerItem = SandboxContainerInfo | SandboxBrowserInfo;

type FilteredContainers = {
  containers: SandboxContainerInfo[];
  browsers: SandboxBrowserInfo[];
};

// --- List Command ---

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
    runtime.log(JSON.stringify({ containers, browsers }, null, 2));
    return;
  }

  if (opts.browser) {
    displayBrowsers(browsers, runtime);
  } else {
    displayContainers(containers, runtime);
  }

  displaySummary(containers, browsers, runtime);
}

// --- Recreate Command ---

export async function sandboxRecreateCommand(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  validateRecreateOptions(opts, runtime);

  const filtered = await fetchAndFilterContainers(opts);

  if (filtered.containers.length + filtered.browsers.length === 0) {
    runtime.log("No containers found matching the criteria.");
    return;
  }

  displayRecreatePreview(filtered, runtime);

  if (!opts.force && !(await confirmRecreate())) {
    runtime.log("Cancelled.");
    return;
  }

  const result = await removeContainers(filtered, runtime);
  displayRecreateResult(result, runtime);

  if (result.failCount > 0) {
    runtime.exit(1);
  }
}

// --- Validation ---

function validateRecreateOptions(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
): void {
  if (!opts.all && !opts.session && !opts.agent) {
    runtime.error("Please specify --all, --session <key>, or --agent <id>");
    runtime.exit(1);
  }

  const exclusiveCount = [opts.all, opts.session, opts.agent].filter(Boolean)
    .length;
  if (exclusiveCount > 1) {
    runtime.error("Please specify only one of: --all, --session, --agent");
    runtime.exit(1);
  }
}

// --- Filtering ---

async function fetchAndFilterContainers(
  opts: SandboxRecreateOptions,
): Promise<FilteredContainers> {
  const allContainers = await listSandboxContainers().catch(() => []);
  const allBrowsers = await listSandboxBrowsers().catch(() => []);

  let containers = opts.browser ? [] : allContainers;
  let browsers = opts.browser ? allBrowsers : [];

  if (opts.session) {
    containers = containers.filter((c) => c.sessionKey === opts.session);
    browsers = browsers.filter((b) => b.sessionKey === opts.session);
  } else if (opts.agent) {
    const matchesAgent = createAgentMatcher(opts.agent);
    containers = containers.filter(matchesAgent);
    browsers = browsers.filter(matchesAgent);
  }

  return { containers, browsers };
}

function createAgentMatcher(agentId: string) {
  const agentPrefix = `agent:${agentId}`;
  return (item: ContainerItem) =>
    item.sessionKey === agentPrefix ||
    item.sessionKey.startsWith(`${agentPrefix}:`);
}

// --- Display Functions ---

function displayContainers(
  containers: SandboxContainerInfo[],
  runtime: RuntimeEnv,
): void {
  if (containers.length === 0) {
    runtime.log("No sandbox containers found.");
    return;
  }

  runtime.log("\n📦 Sandbox Containers:\n");
  for (const container of containers) {
    runtime.log(`  ${container.containerName}`);
    runtime.log(`    Status:  ${formatStatus(container.running)}`);
    runtime.log(`    Image:   ${container.image} ${formatImageMatch(container.imageMatch)}`);
    runtime.log(`    Age:     ${formatAge(Date.now() - container.createdAtMs)}`);
    runtime.log(`    Idle:    ${formatAge(Date.now() - container.lastUsedAtMs)}`);
    runtime.log(`    Session: ${container.sessionKey}`);
    runtime.log("");
  }
}

function displayBrowsers(
  browsers: SandboxBrowserInfo[],
  runtime: RuntimeEnv,
): void {
  if (browsers.length === 0) {
    runtime.log("No sandbox browser containers found.");
    return;
  }

  runtime.log("\n🌐 Sandbox Browser Containers:\n");
  for (const browser of browsers) {
    runtime.log(`  ${browser.containerName}`);
    runtime.log(`    Status:  ${formatStatus(browser.running)}`);
    runtime.log(`    Image:   ${browser.image} ${formatImageMatch(browser.imageMatch)}`);
    runtime.log(`    CDP:     ${browser.cdpPort}`);
    if (browser.noVncPort) {
      runtime.log(`    noVNC:   ${browser.noVncPort}`);
    }
    runtime.log(`    Age:     ${formatAge(Date.now() - browser.createdAtMs)}`);
    runtime.log(`    Idle:    ${formatAge(Date.now() - browser.lastUsedAtMs)}`);
    runtime.log(`    Session: ${browser.sessionKey}`);
    runtime.log("");
  }
}

function displaySummary(
  containers: SandboxContainerInfo[],
  browsers: SandboxBrowserInfo[],
  runtime: RuntimeEnv,
): void {
  const totalCount = containers.length + browsers.length;
  const runningCount = countRunning(containers) + countRunning(browsers);
  const mismatchCount = countMismatches(containers) + countMismatches(browsers);

  runtime.log(`Total: ${totalCount} (${runningCount} running)`);

  if (mismatchCount > 0) {
    runtime.log(
      `\n⚠️  ${mismatchCount} container(s) with image mismatch detected.`,
    );
    runtime.log(
      `   Run 'clawd sandbox recreate --all' to update all containers.`,
    );
  }
}

function displayRecreatePreview(
  filtered: FilteredContainers,
  runtime: RuntimeEnv,
): void {
  runtime.log("\nContainers to be recreated:\n");

  if (filtered.containers.length > 0) {
    runtime.log("📦 Sandbox Containers:");
    for (const container of filtered.containers) {
      runtime.log(
        `  - ${container.containerName} (${formatSimpleStatus(container.running)})`,
      );
    }
  }

  if (filtered.browsers.length > 0) {
    runtime.log("\n🌐 Browser Containers:");
    for (const browser of filtered.browsers) {
      runtime.log(
        `  - ${browser.containerName} (${formatSimpleStatus(browser.running)})`,
      );
    }
  }

  const total = filtered.containers.length + filtered.browsers.length;
  runtime.log(`\nTotal: ${total} container(s)`);
}

function displayRecreateResult(
  result: { successCount: number; failCount: number },
  runtime: RuntimeEnv,
): void {
  runtime.log(
    `\nDone: ${result.successCount} removed, ${result.failCount} failed`,
  );

  if (result.successCount > 0) {
    runtime.log(
      "\nContainers will be automatically recreated when the agent is next used.",
    );
  }
}

// --- Container Operations ---

async function confirmRecreate(): Promise<boolean> {
  const result = await clackConfirm({
    message: "This will stop and remove these containers. Continue?",
    initialValue: false,
  });

  return result !== false && result !== Symbol.for("clack:cancel");
}

async function removeContainers(
  filtered: FilteredContainers,
  runtime: RuntimeEnv,
): Promise<{ successCount: number; failCount: number }> {
  runtime.log("\nRemoving containers...\n");

  let successCount = 0;
  let failCount = 0;

  for (const container of filtered.containers) {
    const result = await removeContainer(
      container.containerName,
      removeSandboxContainer,
      runtime,
    );
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  for (const browser of filtered.browsers) {
    const result = await removeContainer(
      browser.containerName,
      removeSandboxBrowserContainer,
      runtime,
    );
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  return { successCount, failCount };
}

async function removeContainer(
  containerName: string,
  removeFn: (name: string) => Promise<void>,
  runtime: RuntimeEnv,
): Promise<{ success: boolean }> {
  try {
    await removeFn(containerName);
    runtime.log(`✓ Removed ${containerName}`);
    return { success: true };
  } catch (err) {
    runtime.error(`✗ Failed to remove ${containerName}: ${String(err)}`);
    return { success: false };
  }
}

// --- Formatting Helpers ---

function formatStatus(running: boolean): string {
  return running ? "🟢 running" : "⚫ stopped";
}

function formatSimpleStatus(running: boolean): string {
  return running ? "running" : "stopped";
}

function formatImageMatch(matches: boolean): string {
  return matches ? "✓" : "⚠️  mismatch";
}

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

// --- Counting Helpers ---

function countRunning(items: ContainerItem[]): number {
  return items.filter((item) => item.running).length;
}

function countMismatches(items: ContainerItem[]): number {
  return items.filter((item) => !item.imageMatch).length;
}
