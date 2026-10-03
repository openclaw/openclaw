import { confirm as clackConfirm } from "@clack/prompts";
import {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
} from "../agents/sandbox.js";
import { formatCliCommand } from "../cli/command-format.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  displayBrowsers,
  displayContainers,
  displayRecreatePreview,
  displayRecreateResult,
  displaySummary,
} from "./sandbox-display.js";

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

/** Lists active sandbox containers or browser containers. */
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
    displayBrowsers(browsers, runtime);
  } else {
    displayContainers(containers, runtime);
  }

  displaySummary(opts.browser ? browsers : containers, opts.browser, runtime);
}

/** Stops and removes sandbox runtimes matching the requested scope. */
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
  assertCurrent();
  const filtered = await fetchAndFilterContainers(opts);
  assertCurrent();

  if (filtered.containers.length + filtered.browsers.length === 0) {
    runtime.log(
      `No sandbox runtimes found matching the criteria. Run ${formatCliCommand(`openclaw sandbox list${opts.browser ? " --browser" : ""}`)} to inspect active runtimes.`,
    );
    return;
  }

  displayRecreatePreview(filtered.containers, filtered.browsers, runtime);

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
  const result = await removeContainers(filtered, runtime, assertCurrent);
  displayRecreateResult(result, runtime);

  if (result.failCount > 0) {
    runtime.error(
      `Run ${formatCliCommand(`openclaw sandbox list${opts.browser ? " --browser" : ""}`)} to inspect what remains.`,
    );
    runtime.exit(1);
  }
}

async function fetchAndFilterContainers(opts: SandboxRecreateOptions): Promise<FilteredContainers> {
  const matches = opts.session
    ? (item: Pick<ContainerItem, "sessionKey">) => item.sessionKey === opts.session
    : opts.agent
      ? createAgentMatcher(opts.agent)
      : undefined;
  return {
    containers: opts.browser ? [] : await listSandboxContainers(matches),
    browsers: opts.browser ? await listSandboxBrowsers(matches) : [],
  };
}

function createAgentMatcher(agentId: string) {
  const agentPrefix = `agent:${agentId}`;
  return (item: Pick<ContainerItem, "sessionKey">) =>
    item.sessionKey === agentPrefix || item.sessionKey.startsWith(`${agentPrefix}:`);
}

async function removeContainers(
  filtered: FilteredContainers,
  runtime: RuntimeEnv,
  assertCurrent: () => void,
): Promise<{ successCount: number; failCount: number }> {
  runtime.log("\nRemoving sandbox runtimes...\n");

  let successCount = 0;
  let failCount = 0;

  // Remove normal sandboxes first, then browser containers; reporting keeps one
  // aggregate fail count so callers can exit non-zero on partial cleanup.
  for (const [containers, remove] of [
    [filtered.containers, removeSandboxContainer],
    [filtered.browsers, removeSandboxBrowserContainer],
  ] as const) {
    for (const { containerName } of containers) {
      try {
        assertCurrent();
        await remove(containerName);
        runtime.log(`✓ Removed ${containerName}`);
        successCount++;
      } catch (err) {
        runtime.error(`Failed to remove ${containerName}: ${formatErrorMessage(err)}.`);
        failCount++;
      }
    }
  }

  return { successCount, failCount };
}
