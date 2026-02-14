import type { Command } from "commander";
import { messageCommand } from "../../../commands/message.js";
import { danger, setVerbose } from "../../../globals.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { defaultRuntime } from "../../../runtime.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { createDefaultDeps } from "../../deps.js";
import { ensurePluginRegistryLoaded } from "../../plugin-registry.js";

export type MessageCliHelpers = {
  withMessageBase: (command: Command) => Command;
  withMessageTarget: (command: Command) => Command;
  withRequiredMessageTarget: (command: Command) => Command;
  runMessageAction: (action: string, opts: Record<string, unknown>) => Promise<void>;
};

function normalizeMessageOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const { account, ...rest } = opts;
  return {
    ...rest,
    accountId: typeof account === "string" ? account : undefined,
  };
}

export function createMessageCliHelpers(
  message: Command,
  messageChannelOptions: string,
): MessageCliHelpers {
  const withMessageBase = (command: Command) =>
    command
      .option("--channel <channel>", `Channel: ${messageChannelOptions}`)
      .option("--account <id>", "Channel account id (accountId)")
      .option("--json", "Output result as JSON", false)
      .option("--dry-run", "Print payload and skip sending", false)
      .option("--verbose", "Verbose logging", false);

  const withMessageTarget = (command: Command) =>
    command.option("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
  const withRequiredMessageTarget = (command: Command) =>
    command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);

  const runMessageAction = async (action: string, opts: Record<string, unknown>) => {
    setVerbose(Boolean(opts.verbose));
    ensurePluginRegistryLoaded();
    const deps = createDefaultDeps();
    let failed = false;
    await runCommandWithRuntime(
      defaultRuntime,
      async () => {
        await messageCommand(
          {
            ...normalizeMessageOptions(opts),
            action,
          },
          deps,
          defaultRuntime,
        );
      },
      (err) => {
        failed = true;
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      },
    );
    if (failed) {
      return;
    }
    defaultRuntime.exit(0);
  };

  // `message` is only used for `message.help({ error: true })`, keep the
  // command-specific helpers grouped here.
  void message;

  return {
    withMessageBase,
    withMessageTarget,
    withRequiredMessageTarget,
    runMessageAction,
  };
}
