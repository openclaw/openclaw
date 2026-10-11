import type { SandboxBrowserInfo, SandboxContainerInfo } from "../agents/sandbox.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import type { RuntimeEnv } from "../runtime.js";

function displayUsage(container: SandboxContainerInfo, runtime: RuntimeEnv): void {
  runtime.log(
    `    Age:     ${formatDurationCompact(Date.now() - container.createdAtMs, { spaced: true }) ?? "0s"}`,
  );
  runtime.log(
    `    Idle:    ${formatDurationCompact(Date.now() - container.lastUsedAtMs, { spaced: true }) ?? "0s"}`,
  );
  runtime.log(`    Session: ${container.sessionKey}`);
  runtime.log("");
}

export function displayContainers(containers: SandboxContainerInfo[], runtime: RuntimeEnv): void {
  if (containers.length === 0) {
    runtime.log("No sandbox runtimes found.");
    return;
  }

  runtime.log("\n📦 Sandbox Runtimes:\n");
  for (const container of containers) {
    runtime.log(`  ${container.runtimeLabel ?? container.containerName}`);
    runtime.log(`    Status:  ${container.running ? "🟢 running" : "⚫ stopped"}`);
    runtime.log(
      `    ${container.configLabelKind ?? "Image"}:   ${container.image} ${container.imageMatch ? "✓" : "⚠️  mismatch"}`,
    );
    runtime.log(`    Backend: ${container.backendId ?? "docker"}`);
    displayUsage(container, runtime);
  }
}

export function displayBrowsers(browsers: SandboxBrowserInfo[], runtime: RuntimeEnv): void {
  if (browsers.length === 0) {
    runtime.log("No sandbox browser containers found.");
    return;
  }

  runtime.log("\n🌐 Sandbox Browser Containers:\n");
  for (const browser of browsers) {
    runtime.log(`  ${browser.containerName}`);
    runtime.log(`    Status:  ${browser.running ? "🟢 running" : "⚫ stopped"}`);
    runtime.log(`    Image:   ${browser.image} ${browser.imageMatch ? "✓" : "⚠️  mismatch"}`);
    runtime.log(`    CDP:     ${browser.cdpPort}`);
    if (browser.noVncPort) {
      runtime.log(`    noVNC:   ${browser.noVncPort}`);
    }
    displayUsage(browser, runtime);
  }
}

export function displaySummary(
  entries: (SandboxContainerInfo | SandboxBrowserInfo)[],
  browser: boolean,
  runtime: RuntimeEnv,
): void {
  const runningCount = entries.filter((entry) => entry.running).length;
  const mismatchCount = entries.filter((entry) => !entry.imageMatch).length;

  runtime.log(`Total: ${entries.length} (${runningCount} running)`);

  if (mismatchCount > 0) {
    runtime.log(`\n⚠️  ${mismatchCount} runtime(s) with config mismatch detected.`);
    const command = formatCliCommand(
      `openclaw sandbox recreate --all${browser ? " --browser" : ""}`,
    );
    runtime.log(`   Run '${command}' to update all runtimes.`);
  }
}

export function displayRecreatePreview(
  containers: SandboxContainerInfo[],
  browser: boolean,
  runtime: RuntimeEnv,
): void {
  runtime.log("\nSandbox runtimes to be recreated:\n");
  runtime.log(browser ? "\n🌐 Browser Containers:" : "📦 Sandbox Runtimes:");
  for (const container of containers) {
    const label = browser
      ? container.containerName
      : `${container.runtimeLabel ?? container.containerName} [${container.backendId ?? "docker"}]`;
    runtime.log(`  - ${label} (${container.running ? "running" : "stopped"})`);
  }
  runtime.log(`\nTotal: ${containers.length} runtime(s)`);
}

export function displayRecreateResult(
  result: { successCount: number; failCount: number },
  runtime: RuntimeEnv,
): void {
  runtime.log(`\nDone: ${result.successCount} removed, ${result.failCount} failed`);

  if (result.successCount > 0) {
    runtime.log("\nRuntimes will be automatically recreated when the agent is next used.");
  }
}
