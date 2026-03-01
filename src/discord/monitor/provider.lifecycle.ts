import type { Client } from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";

type ExecApprovalsHandler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
  client: Client;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  isDisallowedIntentsError: (err: unknown) => boolean;
  voiceManager: DiscordVoiceManager | null;
  voiceManagerRef: { current: DiscordVoiceManager | null };
  execApprovalsHandler: ExecApprovalsHandler | null;
  threadBindings: { stop: () => void };
}) {
  const gateway = params.client.getPlugin<GatewayPlugin>("gateway");
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime,
  });

  const onAbort = () => {
    if (!gateway) {
      return;
    }
    gatewayEmitter?.once("error", () => {});
    gateway.options.reconnect = { maxAttempts: 0 };
    gateway.disconnect();
  };

  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  const HELLO_TIMEOUT_MS = 30000;
  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;

  // Reconnect watchdog: if the WebSocket closes and does not re-open within
  // this window we force-stop the lifecycle so the outer channel manager can
  // restart the whole provider with exponential backoff. 5 minutes gives the
  // carbon library's built-in reconnect logic (up to 50 attempts) enough time
  // to succeed before we escalate to a full provider restart.
  const RECONNECT_WATCHDOG_MS = 5 * 60_000;
  let reconnectWatchdogId: ReturnType<typeof setTimeout> | undefined;
  // Populated once waitForDiscordGatewayStop registers the forceStop callback.
  let forceStopLifecycle: ((err: unknown) => void) | null = null;

  const clearReconnectWatchdog = () => {
    if (reconnectWatchdogId !== undefined) {
      clearTimeout(reconnectWatchdogId);
      reconnectWatchdogId = undefined;
    }
  };

  const startReconnectWatchdog = () => {
    clearReconnectWatchdog();
    reconnectWatchdogId = setTimeout(() => {
      reconnectWatchdogId = undefined;
      params.runtime.error?.(
        danger(
          `[${params.accountId}] discord reconnect watchdog: WebSocket has been closed for ${Math.round(RECONNECT_WATCHDOG_MS / 1000)}s without recovery — forcing provider restart`,
        ),
      );
      forceStopLifecycle?.(
        new Error(
          `discord: reconnect watchdog timeout — WebSocket connection not re-established within ${RECONNECT_WATCHDOG_MS}ms`,
        ),
      );
    }, RECONNECT_WATCHDOG_MS);
  };

  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    if (message.includes("WebSocket connection opened")) {
      // Connection (re-)established — clear any pending watchdog and start the
      // HELLO timeout to guard against a stalled handshake.
      clearReconnectWatchdog();
      if (helloTimeoutId) {
        clearTimeout(helloTimeoutId);
      }
      helloTimeoutId = setTimeout(() => {
        if (!gateway?.isConnected) {
          params.runtime.log?.(
            danger(
              `connection stalled: no HELLO received within ${HELLO_TIMEOUT_MS}ms, forcing reconnect`,
            ),
          );
          gateway?.disconnect();
          gateway?.connect(false);
        }
        helloTimeoutId = undefined;
      }, HELLO_TIMEOUT_MS);
      return;
    }

    // Connection dropped — start the watchdog. The carbon library will attempt
    // its own reconnects (up to maxAttempts); if it succeeds the "WebSocket
    // connection opened" branch above will clear the watchdog. If it silently
    // exhausts retries without emitting an error event the watchdog fires and
    // forces a clean provider restart.
    if (message.includes("WebSocket connection closed")) {
      startReconnectWatchdog();
    }
  };
  gatewayEmitter?.on("debug", onGatewayDebug);

  let sawDisallowedIntents = false;
  try {
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.start();
    }

    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            emitter: gatewayEmitter,
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal: params.abortSignal,
      onGatewayError: (err) => {
        if (params.isDisallowedIntentsError(err)) {
          sawDisallowedIntents = true;
          params.runtime.error?.(
            danger(
              "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config.",
            ),
          );
          return;
        }
        params.runtime.error?.(danger(`discord gateway error: ${String(err)}`));
      },
      shouldStopOnError: (err) => {
        const message = String(err);
        return (
          message.includes("Max reconnect attempts") ||
          message.includes("Fatal Gateway error") ||
          params.isDisallowedIntentsError(err)
        );
      },
      registerForceStop: (fn) => {
        forceStopLifecycle = fn;
      },
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    clearReconnectWatchdog();
    forceStopLifecycle = null;
    unregisterGateway(params.accountId);
    stopGatewayLogging();
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
    }
    gatewayEmitter?.removeListener("debug", onGatewayDebug);
    params.abortSignal?.removeEventListener("abort", onAbort);
    if (params.voiceManager) {
      await params.voiceManager.destroy();
      params.voiceManagerRef.current = null;
    }
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.stop();
    }
    params.threadBindings.stop();
  }
}
