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
  pendingGatewayErrors?: unknown[];
  releaseEarlyGatewayErrorGuard?: () => void;
}) {
  const HELLO_TIMEOUT_MS = 30000;
  const RECONNECT_STALL_TIMEOUT_MS = 15000;
  const gateway = params.client.getPlugin<GatewayPlugin>("gateway");
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime,
  });

  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let isShuttingDown = false;
  const clearHelloTimeout = () => {
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = undefined;
    }
  };
  const clearReconnectTimeout = () => {
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = undefined;
    }
  };
  const onAbort = () => {
    isShuttingDown = true;
    clearHelloTimeout();
    clearReconnectTimeout();
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

  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    if (message.includes("WebSocket connection opened")) {
      clearReconnectTimeout();
      clearHelloTimeout();
      helloTimeoutId = setTimeout(() => {
        if (!gateway || isShuttingDown) {
          helloTimeoutId = undefined;
          return;
        }
        if (!gateway.isConnected) {
          params.runtime.log?.(
            danger(
              `connection stalled: no HELLO received within ${HELLO_TIMEOUT_MS}ms, forcing reconnect`,
            ),
          );
          gateway.disconnect();
          gateway.connect(false);
        }
        helloTimeoutId = undefined;
      }, HELLO_TIMEOUT_MS);
      return;
    }
    if (!message.includes("WebSocket connection closed")) {
      return;
    }
    clearHelloTimeout();
    if (isShuttingDown) {
      return;
    }
    clearReconnectTimeout();
    reconnectTimeoutId = setTimeout(() => {
      if (!gateway || isShuttingDown) {
        reconnectTimeoutId = undefined;
        return;
      }
      if (!gateway.isConnected) {
        params.runtime.log?.(
          danger(
            `connection stalled: no reconnect within ${RECONNECT_STALL_TIMEOUT_MS}ms after close, forcing reconnect`,
          ),
        );
        gateway.disconnect();
        gateway.connect(false);
      }
      reconnectTimeoutId = undefined;
    }, RECONNECT_STALL_TIMEOUT_MS);
  };
  gatewayEmitter?.on("debug", onGatewayDebug);

  let sawDisallowedIntents = false;
  const logGatewayError = (err: unknown) => {
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
  };
  const shouldStopOnGatewayError = (err: unknown) => {
    const message = String(err);
    return (
      message.includes("Max reconnect attempts") ||
      message.includes("Fatal Gateway error") ||
      params.isDisallowedIntentsError(err)
    );
  };
  try {
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.start();
    }

    // Drain gateway errors emitted before lifecycle listeners were attached.
    const pendingGatewayErrors = params.pendingGatewayErrors ?? [];
    if (pendingGatewayErrors.length > 0) {
      const queuedErrors = [...pendingGatewayErrors];
      pendingGatewayErrors.length = 0;
      for (const err of queuedErrors) {
        logGatewayError(err);
        if (!shouldStopOnGatewayError(err)) {
          continue;
        }
        if (params.isDisallowedIntentsError(err)) {
          return;
        }
        throw err;
      }
    }

    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            emitter: gatewayEmitter,
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal: params.abortSignal,
      onGatewayError: logGatewayError,
      shouldStopOnError: shouldStopOnGatewayError,
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    params.releaseEarlyGatewayErrorGuard?.();
    unregisterGateway(params.accountId);
    stopGatewayLogging();
    clearHelloTimeout();
    clearReconnectTimeout();
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
