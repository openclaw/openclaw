import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { ChannelHeartbeatAdapter } from "../channels/plugins/types.adapters.js";
import { createTypingCallbacks, type TypingCallbacks } from "../channels/typing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryTypingParams } from "./server-instance-runtime.types.js";

/** Cosmetic activity only: the original command still owns all final delivery and retries. */
export function createRecoveryTypingManager(options: {
  isAvailable: () => boolean;
  getConfig: () => OpenClawConfig;
  resolveAdapter: (channel: string) => Promise<ChannelHeartbeatAdapter | undefined>;
  onError?: (error: unknown) => void;
}) {
  const active = new Map<string, () => void>();
  let closed = false;
  return {
    start(params: GatewayRecoveryTypingParams): () => void {
      if (closed) {
        return () => {};
      }
      const existing = active.get(params.runId);
      if (existing) {
        return existing;
      }
      let stopped = false;
      const controller = new AbortController();
      let callbacks: TypingCallbacks | undefined;
      const stop = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        controller.abort();
        active.delete(params.runId);
        callbacks?.onCleanup?.();
      };
      const current = (cfg = options.getConfig()) =>
        !stopped && !closed && options.isAvailable() && params.isCurrent(cfg);
      active.set(params.runId, stop);
      void (async () => {
        if (!current()) {
          stop();
          return;
        }
        const [adapter, { resolveAgentConfig }] = await Promise.all([
          options.resolveAdapter(params.channel),
          import("../agents/agent-scope-config.js"),
        ]);
        if (!current() || !adapter?.sendTypingGuarded) {
          stop();
          return;
        }
        const sendTypingGuarded = adapter.sendTypingGuarded;
        const typingEnabled = (cfg: OpenClawConfig) =>
          (params.agentId
            ? (resolveAgentConfig(cfg, params.agentId)?.typingMode ??
              cfg.agents?.defaults?.typingMode)
            : cfg.agents?.defaults?.typingMode) !== "never";
        const cfg = options.getConfig();
        if (!typingEnabled(cfg)) {
          stop();
          return;
        }
        const target = {
          cfg,
          to: params.to,
          accountId: params.accountId,
          threadId: params.threadId,
        };
        const assertPlatformSendAuthorized = () => {
          controller.signal.throwIfAborted();
          const currentConfig = options.getConfig();
          if (!current(currentConfig) || !typingEnabled(currentConfig)) {
            stop();
            controller.signal.throwIfAborted();
          }
        };
        callbacks = createTypingCallbacks({
          start: async () => {
            const currentConfig = options.getConfig();
            if (!current(currentConfig) || !typingEnabled(currentConfig)) {
              stop();
              return;
            }
            await sendTypingGuarded({
              ...target,
              cfg: currentConfig,
              signal: controller.signal,
              assertPlatformSendAuthorized,
            });
          },
          stop: async () => {
            stop();
            await adapter.clearTyping?.(target);
          },
          // Use the same configured budget as the recovered command, not an unbounded indicator.
          maxDurationMs: resolveAgentTimeoutMs({ cfg }),
          onStartError: (error) => {
            stop();
            options.onError?.(error);
          },
          onStopError: options.onError,
        });
        await callbacks.onReplyStart();
      })().catch((error: unknown) => {
        stop();
        options.onError?.(error);
      });
      return stop;
    },
    close() {
      closed = true;
      for (const stop of active.values()) {
        stop();
      }
    },
  };
}
