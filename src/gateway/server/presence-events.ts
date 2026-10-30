import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";

const log = createSubsystemLogger("gateway/presence");

/** One Gateway owns fixed publication windows; authoritative reads never wait for them. */
export function createPresencePublisher(params: {
  scheduler: GatewayScheduler;
  broadcast: GatewayBroadcastFn;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  prepare: () => Promise<void> | undefined;
}) {
  const scheduler = params.scheduler.scope();
  let pending = false;
  let version = 0;
  const schedule = () => {
    if (!scheduler.signal.aborted && !pending) {
      pending = true;
      scheduler.schedule({ id: "presence/publication", delayMs: 200, run: flush });
    }
  };
  const flush = async () => {
    let publishedVersion = version;
    try {
      for (let preparation = params.prepare(); preparation; preparation = params.prepare()) {
        await preparation;
        if (scheduler.signal.aborted) {
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
      pending = false;
      if (version !== publishedVersion) {
        schedule();
      }
    }
  };
  return {
    publish: () => {
      if (!scheduler.signal.aborted) {
        version = params.incrementPresenceVersion();
        schedule();
      }
    },
    stop: scheduler.beginClose,
  };
}
