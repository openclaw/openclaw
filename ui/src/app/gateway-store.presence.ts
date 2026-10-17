import type {
  PresenceReset,
  PresenceUpdate,
} from "../../../packages/gateway-protocol/src/presence-deltas.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { PresenceEntry } from "../api/types.ts";

/** Normalize the negotiated wire format before any presence consumer sees it. */
export function createGatewayPresenceObserver(options: {
  requestSnapshot: () => Promise<PresenceReset>;
  publish: (event: GatewayEventFrame) => void;
  onError: (error: unknown) => void;
}) {
  let scope: object | null = null;
  let version: number | undefined;
  let rows = new Map<string, PresenceEntry>();
  let recovery: object | undefined;

  const accept = (nextVersion: number, nextRows: Map<string, PresenceEntry>) => {
    version = nextVersion;
    rows = nextRows;
    recovery = undefined;
    return { presence: Array.from(rows.values()) };
  };
  const applyReset = (update: PresenceReset) => {
    if (
      !update ||
      !update.reset ||
      !Number.isSafeInteger(update.version) ||
      !Array.isArray(update.presence) ||
      !Array.isArray(update.keys) ||
      update.presence.length !== update.keys.length ||
      !update.keys.every((key) => typeof key === "string") ||
      new Set(update.keys).size !== update.keys.length
    ) {
      return undefined;
    }
    return accept(
      update.version,
      new Map(update.keys.map((key, index) => [key, update.presence[index]!])),
    );
  };
  const recover = () => {
    if (!scope || recovery) {
      return;
    }
    const request = {};
    recovery = request;
    // Applying any newer snapshot or changing hello retires this request token.
    void options.requestSnapshot().then(
      (snapshot) => {
        if (recovery !== request) {
          return;
        }
        recovery = undefined;
        const payload = applyReset(snapshot);
        if (payload) {
          options.publish({ type: "event", event: "presence", payload });
        } else {
          options.onError(new Error("Gateway returned an invalid presence snapshot"));
        }
      },
      (error: unknown) => {
        if (recovery === request) {
          recovery = undefined;
          options.onError(error);
        }
      },
    );
  };
  return {
    synchronize(nextScope: object | null) {
      if (nextScope === scope) {
        return;
      }
      scope = nextScope;
      version = undefined;
      rows = new Map();
      recovery = undefined;
    },
    receive(event: GatewayEventFrame): GatewayEventFrame | undefined {
      if (event.event !== "presence") {
        return event;
      }
      if (!scope) {
        return undefined;
      }
      // SAFETY: The authenticated negotiated presence event owns this wire contract.
      const update = event.payload as PresenceUpdate | undefined;
      if (!update || typeof update !== "object") {
        recover();
        return undefined;
      }
      let payload: { presence: PresenceEntry[] } | undefined;
      if ("reset" in update && update.reset) {
        payload = applyReset(update);
      } else if ("base" in update) {
        if (
          version !== undefined &&
          update.base === version &&
          Number.isSafeInteger(update.version) &&
          Array.isArray(update.upsert) &&
          Array.isArray(update.remove) &&
          Array.isArray(update.order) &&
          update.remove.every((key) => typeof key === "string")
        ) {
          const next = new Map(rows);
          for (const key of update.remove) {
            next.delete(key);
          }
          const complete = update.upsert.every((entry) => {
            const key = entry?.key;
            if (typeof key !== "string") {
              return false;
            }
            if ("presence" in entry) {
              if (!entry.presence) {
                return false;
              }
              next.set(key, entry.presence);
              return true;
            }
            const before = next.get(key);
            const { set, unset } = entry;
            if (
              !before ||
              !set ||
              typeof set !== "object" ||
              Array.isArray(set) ||
              !Array.isArray(unset) ||
              !unset.every((field) => typeof field === "string")
            ) {
              return false;
            }
            const row: PresenceEntry & Record<string, unknown> = { ...before, ...set };
            for (const field of unset) {
              delete row[field];
            }
            next.set(key, row);
            return true;
          });
          if (
            complete &&
            new Set(update.order).size === next.size &&
            update.order.length === next.size &&
            update.order.every((key) => next.has(key))
          ) {
            payload = accept(
              update.version,
              new Map(update.order.map((key) => [key, next.get(key)!])),
            );
          }
        }
      }
      if (!payload) {
        recover();
        return undefined;
      }
      return { ...event, payload };
    },
  };
}
