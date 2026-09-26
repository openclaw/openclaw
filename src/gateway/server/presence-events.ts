import { formatErrorMessage } from "../../infra/errors.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";

const log = createSubsystemLogger("gateway/presence");

/** One Gateway owns queued publications; authoritative reads never wait for this turn boundary. */
export function createPresencePublisher(params: {
  broadcast: GatewayBroadcastFn;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  prepare: () => Promise<void> | undefined;
}) {
  let pending: ReturnType<typeof setImmediate> | undefined;
  let flushing = false;
  let version = 0;
  let stopped = false;
  const schedule = () => {
    if (!stopped && !pending && !flushing) {
      pending = setImmediate(() => void flush());
      pending.unref();
    }
  };
  const flush = async () => {
    pending = undefined;
    flushing = true;
    let publishedVersion = version;
    try {
      for (let preparation = params.prepare(); preparation; preparation = params.prepare()) {
        await preparation;
        if (stopped) {
          return;
        }
      }
      publishedVersion = version;
      params.broadcast(
        "presence",
        { presence: listSystemPresence() },
        {
          dropIfSlow: true,
          stateVersion: { presence: publishedVersion, health: params.getHealthVersion() },
        },
      );
    } catch (error) {
      log.warn(`Presence publication failed: ${formatErrorMessage(error)}`);
    } finally {
      flushing = false;
      if (version !== publishedVersion) {
        schedule();
      }
    }
  };
  return {
    publish: () => {
      if (!stopped) {
        version = params.incrementPresenceVersion();
        schedule();
      }
    },
    stop: () => {
      stopped = true;
      clearImmediate(pending);
      pending = undefined;
    },
  };
}
