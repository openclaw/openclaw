import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelRuntimeContextEvent,
  ChannelRuntimeContextKey,
  ChannelRuntimeContextRegistry,
} from "../../channels/plugins/channel-runtime-surface.types.js";
import { createSubsystemLogger } from "../../logging.js";

type StoredRuntimeContext = {
  token: symbol;
  context: unknown;
};

const log = createSubsystemLogger("plugins/runtime-channel");

function normalizeRuntimeContextKey(params: ChannelRuntimeContextKey): {
  mapKey: string;
  normalizedKey: ChannelRuntimeContextEvent["key"];
} | null {
  const channelId = normalizeOptionalString(params.channelId);
  const capability = normalizeOptionalString(params.capability);
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!channelId || !capability) {
    return null;
  }
  return {
    mapKey: `${channelId}\u0000${accountId}\u0000${capability}`,
    normalizedKey: {
      channelId,
      capability,
      ...(accountId ? { accountId } : {}),
    },
  };
}

export function createChannelRuntimeContextRegistry(): ChannelRuntimeContextRegistry {
  const runtimeContexts = new Map<string, StoredRuntimeContext>();
  const runtimeContextWatchers = new Set<{
    filter: {
      channelId?: string;
      accountId?: string;
      capability?: string;
    };
    onEvent: (event: ChannelRuntimeContextEvent) => void;
  }>();
  const emitRuntimeContextEvent = (event: ChannelRuntimeContextEvent) => {
    for (const watcher of runtimeContextWatchers) {
      const { channelId, accountId, capability } = watcher.filter;
      if (
        (channelId && channelId !== event.key.channelId) ||
        (accountId !== undefined && accountId !== (event.key.accountId ?? "")) ||
        (capability && capability !== event.key.capability)
      ) {
        continue;
      }
      try {
        watcher.onEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `runtime context watcher failed during ${event.type} ` +
            `channel=${event.key.channelId} capability=${event.key.capability}` +
            (event.key.accountId ? ` account=${event.key.accountId}` : "") +
            `: ${message}`,
        );
      }
    }
  };
  return {
    register: (params) => {
      const normalized = normalizeRuntimeContextKey(params);
      if (!normalized || params.abortSignal?.aborted) {
        return { dispose: () => {} };
      }
      const token = Symbol(normalized.mapKey);
      let disposed = false;
      const dispose = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        // Detach before the token check: stale leases disposed after a replacement
        // registered must still release their listener on long-lived signals.
        params.abortSignal?.removeEventListener("abort", dispose);
        const current = runtimeContexts.get(normalized.mapKey);
        if (!current || current.token !== token) {
          return;
        }
        runtimeContexts.delete(normalized.mapKey);
        emitRuntimeContextEvent({
          type: "unregistered",
          key: normalized.normalizedKey,
        });
      };
      params.abortSignal?.addEventListener("abort", dispose, { once: true });
      if (params.abortSignal?.aborted) {
        dispose();
        return { dispose };
      }
      runtimeContexts.set(normalized.mapKey, {
        token,
        context: params.context,
      });
      if (disposed) {
        return { dispose };
      }
      emitRuntimeContextEvent({
        type: "registered",
        key: normalized.normalizedKey,
        context: params.context,
      });
      return { dispose };
    },
    get: (params) => {
      const normalized = normalizeRuntimeContextKey(params);
      if (!normalized) {
        return undefined;
      }
      return runtimeContexts.get(normalized.mapKey)?.context as never;
    },
    watch: (params) => {
      const watcher = {
        filter: {
          ...(params.channelId?.trim() ? { channelId: params.channelId.trim() } : {}),
          ...(params.accountId != null ? { accountId: params.accountId.trim() } : {}),
          ...(params.capability?.trim() ? { capability: params.capability.trim() } : {}),
        },
        onEvent: params.onEvent,
      };
      runtimeContextWatchers.add(watcher);
      return () => {
        runtimeContextWatchers.delete(watcher);
      };
    },
  };
}
