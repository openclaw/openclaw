import type { Command } from "commander";
import { messageCommand } from "../../../commands/message.js";
import { danger, setVerbose } from "../../../globals.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { callGateway, buildGatewayConnectionDetails } from "../../../gateway/call.js";
import { runGlobalGatewayStopSafely } from "../../../plugins/hook-runner-global.js";
import { defaultRuntime } from "../../../runtime.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { createDefaultDeps } from "../../deps.js";
import { ensurePluginRegistryLoaded } from "../../plugin-registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../utils/message-channel.js";

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

/**
 * Try to send a message via the gateway RPC "send" method.
 * Returns true on success, false if the gateway is unreachable or returns an error.
 *
 * This avoids the "No active WhatsApp Web listener" error that occurs when the
 * CLI tries to use the WhatsApp plugin directly (in its own process, where no
 * listener exists). The gateway process always has the active listener.
 */
async function trySendViaGateway(opts: Record<string, unknown>): Promise<boolean> {
  const target = typeof opts.target === "string" ? opts.target.trim() : "";
  const message = typeof opts.message === "string" ? opts.message : "";
  const channel = typeof opts.channel === "string" ? opts.channel : undefined;
  const accountId = typeof opts.accountId === "string" ? opts.accountId : undefined;
  const mediaUrl = typeof opts.media === "string" ? opts.media : undefined;

  if (!target || (!message && !mediaUrl)) return false;

  try {
    const connDetails = buildGatewayConnectionDetails({
      url: typeof opts.url === "string" ? opts.url : undefined,
    });
    const url = connDetails.url;
    const token = typeof opts.token === "string" ? opts.token : undefined;
    const idempotencyKey = `cli-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await callGateway({
      url,
      token,
      method: "send",
      params: {
        to: target,
        message,
        channel,
        accountId,
        mediaUrl,
        idempotencyKey,
      },
      expectFinal: false,
      timeoutMs: 15_000,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });

    return true;
  } catch {
    // Gateway unreachable or error — fall through to local plugin path
    return false;
  }
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

    // For "send" actions: attempt gateway RPC first. The gateway process owns
    // the active channel listeners (e.g. WhatsApp Web socket). The CLI running
    // as a separate process has no listener, causing "No active WhatsApp Web
    // listener" errors even when the gateway is connected and healthy.
    if (action === "send" && !opts.dryRun) {
      const normalized = normalizeMessageOptions(opts);
      const sentViaGateway = await trySendViaGateway(normalized);
      if (sentViaGateway) {
        defaultRuntime.exit(0);
        return;
      }
      // Gateway path failed — fall through to local plugin path below
    }

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
