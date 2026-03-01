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
  const HELLO_CONNECTED_POLL_MS = 250;
  const MAX_CONSECUTIVE_HELLO_STALLS = 3;
  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let helloConnectedPollId: ReturnType<typeof setInterval> | undefined;
  let consecutiveHelloStalls = 0;
  const clearHelloWatch = () => {
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = undefined;
    }
    if (helloConnectedPollId) {
      clearInterval(helloConnectedPollId);
      helloConnectedPollId = undefined;
    }
  };
  const resetHelloStallCounter = () => {
    consecutiveHelloStalls = 0;
  };
  const clearResumeState = () => {
    const mutableGateway = gateway as
      | (GatewayPlugin & {
          state?: {
            sessionId?: string | null;
            resumeGatewayUrl?: string | null;
            sequence?: number | null;
          };
          sequence?: number | null;
        })
      | undefined;
    if (!mutableGateway?.state) {
      return;
    }
    mutableGateway.state.sessionId = null;
    mutableGateway.state.resumeGatewayUrl = null;
    mutableGateway.state.sequence = null;
    mutableGateway.sequence = null;
  };
  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    if (message.includes("WebSocket connection closed")) {
      // Carbon marks `isConnected` true only after READY/RESUMED and flips it
      // false during reconnect handling after this debug line is emitted.
      if (gateway?.isConnected) {
        resetHelloStallCounter();
      }
      clearHelloWatch();
      return;
    }
    if (!message.includes("WebSocket connection opened")) {
      return;
    }
    clearHelloWatch();

    let sawConnected = gateway?.isConnected === true;
    helloConnectedPollId = setInterval(() => {
      if (!gateway?.isConnected) {
        return;
      }
      sawConnected = true;
      resetHelloStallCounter();
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = undefined;
      }
    }, HELLO_CONNECTED_POLL_MS);

    helloTimeoutId = setTimeout(() => {
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = undefined;
      }
      if (sawConnected || gateway?.isConnected) {
        resetHelloStallCounter();
      } else {
        consecutiveHelloStalls += 1;
        const forceFreshIdentify = consecutiveHelloStalls >= MAX_CONSECUTIVE_HELLO_STALLS;
        params.runtime.log?.(
          danger(
            forceFreshIdentify
              ? `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); forcing fresh identify`
              : `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); retrying resume`,
          ),
        );
        if (forceFreshIdentify) {
          clearResumeState();
          resetHelloStallCounter();
        }
        gateway?.disconnect();
        gateway?.connect(!forceFreshIdentify);
      }
      helloTimeoutId = undefined;
    }, HELLO_TIMEOUT_MS);
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
    clearHelloWatch();
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
