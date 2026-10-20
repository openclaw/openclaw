import { confirm as clackConfirm } from "@clack/prompts";
import {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxContainerInfo,
} from "../agents/sandbox/manage.js";
import { formatCliCommand } from "../cli/command-format.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

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

function formatRecreateRuntimeLabel(container: SandboxContainerInfo): string {
  return `${container.runtimeLabel ?? container.containerName} [${container.backendId ?? "docker"}]`;
}

export async function sandboxListCommand(
  opts: SandboxListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  // A failing backend/registry probe must surface, not render as an empty
  // list that reads as "no sandboxes".
  const containers = opts.browser ? [] : await listSandboxContainers();
  const browsers = opts.browser ? await listSandboxBrowsers() : [];

  if (opts.json) {
    writeRuntimeJson(runtime, { containers, browsers });
    return;
  }

  if (opts.browser) {
    if (browsers.length === 0) {
      runtime.log("No sandbox browser containers found.");
    } else {
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
  } else if (containers.length === 0) {
    runtime.log("No sandbox runtimes found.");
  } else {
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

  const entries = opts.browser ? browsers : containers;
  const runningCount = entries.filter((entry) => entry.running).length;
  const mismatchCount = entries.filter((entry) => !entry.imageMatch).length;
  runtime.log(`Total: ${entries.length} (${runningCount} running)`);
  if (mismatchCount > 0) {
    runtime.log(`\n⚠️  ${mismatchCount} runtime(s) with config mismatch detected.`);
    const command = formatCliCommand(
      `openclaw sandbox recreate --all${opts.browser ? " --browser" : ""}`,
    );
    runtime.log(`   Run '${command}' to update all runtimes.`);
  }
}

export async function sandboxRecreateCommand(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!opts.all && !opts.session && !opts.agent) {
    runtime.error(
      `Choose the sandbox scope: --all, --session <key>, or --agent <id>. Run ${formatCliCommand(`openclaw sandbox list${opts.browser ? " --browser" : ""}`)} to inspect active runtimes first.`,
    );
    runtime.exit(1);
    return;
  }
  if ([opts.all, opts.session, opts.agent].filter(Boolean).length > 1) {
    runtime.error("Choose only one sandbox scope: --all, --session, or --agent.");
    runtime.exit(1);
    return;
  }

  const selected = { ...opts };
  await runWithLocalStateOwner({
    method: "sandbox.recreate",
    params: {},
    target: selected.session ?? selected.agent ?? "all sandbox runtimes",
    onForeignOwner: "refuse",
    runLocal: ({ assertCurrent }) => recreateOwnedSandboxes(selected, runtime, assertCurrent),
  });
}

async function recreateOwnedSandboxes(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
  assertCurrent: () => void,
): Promise<void> {
  const agentPrefix = `agent:${opts.agent}`;
  const matches = opts.session
    ? (item: Pick<SandboxContainerInfo, "sessionKey">) => item.sessionKey === opts.session
    : opts.agent
      ? (item: Pick<SandboxContainerInfo, "sessionKey">) =>
          item.sessionKey === agentPrefix || item.sessionKey.startsWith(`${agentPrefix}:`)
      : undefined;
  const containers = opts.browser
    ? await listSandboxBrowsers(matches)
    : await listSandboxContainers(matches);
  assertCurrent();

  if (containers.length === 0) {
    runtime.log(
      `No sandbox runtimes found matching the criteria. Run ${formatCliCommand(`openclaw sandbox list${opts.browser ? " --browser" : ""}`)} to inspect active runtimes.`,
    );
    return;
  }

  runtime.log("\nSandbox runtimes to be recreated:\n");
  runtime.log(opts.browser ? "\n🌐 Browser Containers:" : "📦 Sandbox Runtimes:");
  for (const container of containers) {
    const label = opts.browser ? container.containerName : formatRecreateRuntimeLabel(container);
    runtime.log(`  - ${label} (${container.running ? "running" : "stopped"})`);
  }
  runtime.log(`\nTotal: ${containers.length} runtime(s)`);

  if (
    !opts.force &&
    (await clackConfirm({
      message: "This will stop and remove these containers. Continue?",
      initialValue: false,
    })) !== true
  ) {
    runtime.log("Cancelled.");
    return;
  }

  assertCurrent();
  runtime.log("\nRemoving sandbox runtimes...\n");

  let successCount = 0;
  const remove = opts.browser ? removeSandboxBrowserContainer : removeSandboxContainer;
  for (const { containerName } of containers) {
    try {
      assertCurrent();
      await remove(containerName);
      runtime.log(`✓ Removed ${containerName}`);
      successCount++;
    } catch (err) {
      runtime.error(`Failed to remove ${containerName}: ${formatErrorMessage(err)}.`);
    }
  }

  const failCount = containers.length - successCount;
  runtime.log(`\nDone: ${successCount} removed, ${failCount} failed`);
  if (successCount > 0) {
    runtime.log("\nRuntimes will be automatically recreated when the agent is next used.");
  }
  if (failCount > 0) {
    runtime.error(
      `Run ${formatCliCommand(`openclaw sandbox list${opts.browser ? " --browser" : ""}`)} to inspect what remains.`,
    );
    runtime.exit(1);
  }
}
