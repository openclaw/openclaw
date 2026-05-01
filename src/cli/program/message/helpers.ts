import type { Command } from "commander";
import { resolveMessageSecretScope } from "../../../cli/message-secret-scope.js";
import { messageCommand } from "../../../commands/message.js";
import { callGateway, randomIdempotencyKey } from "../../../gateway/call.js";
import { danger, setVerbose } from "../../../globals.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { runGlobalGatewayStopSafely } from "../../../plugins/hook-runner-global.js";
import { defaultRuntime } from "../../../runtime.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { createDefaultDeps } from "../../deps.js";
import { ensurePluginRegistryLoaded, type PluginRegistryScope } from "../../plugin-registry.js";

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

async function runPluginStopHooks(): Promise<void> {
  await runGlobalGatewayStopSafely({
    event: { reason: "cli message action complete" },
    ctx: {},
    onError: (err) => defaultRuntime.error(danger(`gateway_stop hook failed: ${String(err)}`)),
  });
}

function resolveMessagePluginLoadOptions(
  opts: Record<string, unknown>,
): { scope: PluginRegistryScope; onlyChannelIds?: string[] } | undefined {
  const scopedChannel = resolveMessageSecretScope({
    channel: opts.channel,
    target: opts.target,
    targets: opts.targets,
  }).channel;
  if (scopedChannel) {
    return { scope: "configured-channels", onlyChannelIds: [scopedChannel] };
  }
  return { scope: "configured-channels" };
}

function readStringOption(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBooleanOption(opts: Record<string, unknown>, key: string): boolean | undefined {
  return typeof opts[key] === "boolean" ? opts[key] : undefined;
}

function shouldUseTelegramGatewayFastPath(action: string, opts: Record<string, unknown>): boolean {
  return (
    action === "send" &&
    opts.dryRun !== true &&
    readStringOption(opts, "channel") === "telegram" &&
    Boolean(readStringOption(opts, "target"))
  );
}

async function runTelegramGatewayFastPath(action: string, opts: Record<string, unknown>) {
  const normalized = normalizeMessageOptions(opts);
  const target = readStringOption(normalized, "target");
  if (!target) {
    throw new Error("Telegram message send requires --target.");
  }
  const message = readStringOption(normalized, "message") ?? "";
  const mediaUrl = readStringOption(normalized, "media");
  if (!message && !mediaUrl) {
    throw new Error("Telegram message send requires --message or --media.");
  }
  const params: Record<string, unknown> = {
    to: target,
    message,
  };
  const accountId = readStringOption(normalized, "accountId");
  const threadId = readStringOption(normalized, "threadId");
  const replyToId = readStringOption(normalized, "replyTo");
  const presentation = readStringOption(normalized, "presentation");
  const delivery = readStringOption(normalized, "delivery");
  if (mediaUrl) {
    params.mediaUrl = mediaUrl;
  }
  if (threadId) {
    params.threadId = threadId;
  }
  if (replyToId) {
    params.replyTo = replyToId;
  }
  if (presentation) {
    params.presentation = presentation;
  }
  if (delivery) {
    params.delivery = delivery;
  }
  for (const key of ["pin", "gifPlayback", "forceDocument", "silent"] as const) {
    const value = readBooleanOption(normalized, key);
    if (value !== undefined) {
      params[key] = value;
    }
  }
  const payload = await callGateway<Record<string, unknown>>({
    method: "message.action",
    params: {
      channel: "telegram",
      action,
      params,
      accountId,
      idempotencyKey: randomIdempotencyKey(),
    },
    timeoutMs: 30_000,
    clientName: "cli",
    mode: "cli",
  });
  if (normalized.json === true) {
    defaultRuntime.log(
      JSON.stringify(
        {
          action,
          channel: "telegram",
          dryRun: false,
          handledBy: "gateway",
          payload,
        },
        null,
        2,
      ),
    );
    return;
  }
  defaultRuntime.log(`Telegram message sent${payload.messageId ? ` (${payload.messageId})` : ""}`);
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
    if (shouldUseTelegramGatewayFastPath(action, opts)) {
      let failed = false;
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          await runTelegramGatewayFastPath(action, opts);
        },
        (err) => {
          failed = true;
          defaultRuntime.error(danger(String(err)));
        },
      );
      defaultRuntime.exit(failed ? 1 : 0);
      return;
    }
    ensurePluginRegistryLoaded(resolveMessagePluginLoadOptions(opts));
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
      },
    );
    await runPluginStopHooks();
    defaultRuntime.exit(failed ? 1 : 0);
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
