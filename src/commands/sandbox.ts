import { confirm as clackConfirm } from "@clack/prompts";
import {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
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

  displayRecreatePreview(containers, opts.browser, runtime);

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
  displayRecreateResult({ successCount, failCount }, runtime);
  if (failCount > 0) {
    runtime.error(
      `Run ${formatCliCommand(`openclaw sandbox list${opts.browser ? " --browser" : ""}`)} to inspect what remains.`,
    );
    runtime.exit(1);
  }
}
