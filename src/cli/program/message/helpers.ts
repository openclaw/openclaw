import { resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { messageCommand } from "../../../commands/message.js";
import { danger, setVerbose } from "../../../globals.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { buildGatewayConnectionDetails, callGateway, randomIdempotencyKey } from "../../../gateway/call.js";
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
 * Classify an error thrown by callGateway:
 *   - "unreachable": connection-level failure; gateway is not running or not reachable
 *   - "server": the gateway was reached but returned an error (invalid params, auth, etc.)
 */
function classifyGatewayError(err: unknown): "unreachable" | "server" {
  if (!(err instanceof Error)) return "unreachable";
  const msg = err.message.toLowerCase();
  // Connection-level errors: ECONNREFUSED, WebSocket failures, timeout before connect, etc.
  if (
    msg.includes("econnrefused") ||
    msg.includes("connect failed") ||
    msg.includes("gateway connect failed") ||
    msg.includes("connect timed out") ||
    msg.includes("websocket error")
  ) {
    return "unreachable";
  }
  // GatewayClientRequestError means the gateway was reachable and returned an error response
  if (err.constructor?.name === "GatewayClientRequestError") return "server";
  // Remote-mode misconfiguration: gateway was configured but URL is missing — surface to user
  if (msg.includes("gateway remote mode misconfigured")) return "server";
  // Unsupported method: gateway is reachable but doesn't expose this RPC method
  if (msg.includes("does not support required method")) return "server";
  // Auth/close-frame errors: gateway accepted the connection but rejected the request
  // formatGatewayCloseError produces "gateway closed (code...): reason"
  if (msg.startsWith("gateway closed")) return "server";
  // Explicit auth failures
  if (msg.includes("unauthorized") || msg.includes("forbidden")) return "server";
  return "unreachable";
}

/**
 * Try to send a message via the gateway RPC "send" method.
 *
 * Returns:
 *   - { ok: true, result } on success
 *   - { ok: false, reason: "unreachable" } if the gateway is not reachable (fall through to local)
 *   - { ok: false, reason: "server", error } if the gateway returned an error (surface to user)
 *
 * This avoids the "No active WhatsApp Web listener" error that occurs when the
 * CLI tries to use the WhatsApp plugin directly (in its own process, where no
 * listener exists). The gateway process always has the active listener.
 */
async function trySendViaGateway(opts: Record<string, unknown>): Promise<
  | { ok: true; result: unknown }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "server"; error: Error }
> {
  const target = typeof opts.target === "string" ? opts.target.trim() : "";
  const message = typeof opts.message === "string" ? opts.message : "";
  const channel = typeof opts.channel === "string" ? opts.channel : undefined;
  const accountId = typeof opts.accountId === "string" ? opts.accountId : undefined;
  // Resolve relative media paths to absolute so the gateway process (which may
  // have a different cwd) can locate the file correctly.
  const rawMedia = typeof opts.media === "string" ? opts.media : undefined;
  const mediaUrl = rawMedia
    ? rawMedia.startsWith("http://") || rawMedia.startsWith("https://") || rawMedia.startsWith("/")
      ? rawMedia
      : resolvePath(process.cwd(), rawMedia)
    : undefined;
  const threadId = typeof opts.threadId === "string" ? opts.threadId : undefined;
  const gifPlayback = typeof opts.gifPlayback === "boolean" ? opts.gifPlayback : undefined;

  if (!target || (!message && !mediaUrl)) return { ok: false, reason: "unreachable" };

  try {
    const result = await callGateway({
      url: typeof opts.url === "string" ? opts.url : undefined,
      token: typeof opts.token === "string" ? opts.token : undefined,
      method: "send",
      params: {
        to: target,
        message,
        channel,
        accountId,
        mediaUrl,
        threadId,
        gifPlayback,
        idempotencyKey: randomIdempotencyKey(),
      },
      expectFinal: false,
      timeoutMs: 15_000,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });

    return { ok: true, result };
  } catch (err) {
    const reason = classifyGatewayError(err);
    if (reason === "server") {
      return { ok: false, reason: "server", error: err instanceof Error ? err : new Error(String(err)) };
    }
    return { ok: false, reason: "unreachable" };
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
      const gatewayResult = await trySendViaGateway(normalized);

      if (gatewayResult.ok) {
        // Gateway delivered successfully — emit output using the stable CLI JSON envelope
        // so programmatic consumers that parse action/channel/dryRun/handledBy/payload
        // continue to work correctly.
        if (opts.json) {
          const channel =
            typeof normalized.channel === "string" ? normalized.channel : "unknown";
          const envelope = {
            action: "send",
            channel,
            dryRun: false,
            handledBy: "gateway" as const,
            payload: gatewayResult.result,
          };
          defaultRuntime.log(JSON.stringify(envelope));
        }
        // Run gateway_stop hooks before exit so plugin-backed channels can
        // perform cleanup (e.g. releasing one-shot CLI connections).
        await runPluginStopHooks();
        defaultRuntime.exit(0);
        return;
      }

      if (gatewayResult.reason === "server") {
        // Gateway was reachable but returned an error — surface it, don't fall through
        defaultRuntime.error(danger(gatewayResult.error.message));
        await runPluginStopHooks();
        defaultRuntime.exit(1);
        return;
      }

      // reason === "unreachable": gateway not running.
      // Safety check: if the active gateway URL came from a remote source
      // (config gateway.remote.url or env/cli override), the local plugin path
      // would not be the right fallback — the user explicitly configured a remote
      // gateway. Surface an error rather than silently falling through to a local
      // plugin that almost certainly cannot reach the intended channel either.
      const connDetails = buildGatewayConnectionDetails({
        url: typeof normalized.url === "string" ? normalized.url : undefined,
      });
      if (connDetails.urlSource !== "local loopback") {
        defaultRuntime.error(
          danger(
            `Gateway is unreachable (${connDetails.urlSource}: ${connDetails.url}). ` +
              `Cannot fall back to local plugin when a remote gateway is configured.`,
          ),
        );
        await runPluginStopHooks();
        defaultRuntime.exit(1);
        return;
      }

      // Local loopback gateway not running — fall through to local plugin path
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
