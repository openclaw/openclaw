import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayEventFrame } from "../api/gateway.ts";

export function createGatewayEventObserver(options: {
  isAttached: () => boolean;
  isCurrent: () => boolean;
  project: (event: GatewayEventFrame) => GatewayEventFrame | undefined;
  record: (event: GatewayEventFrame) => void;
  listeners: ReadonlySet<(event: GatewayEventFrame) => void>;
}): (event: GatewayEventFrame) => void {
  return (incomingEvent) => {
    if (!options.isAttached()) {
      return;
    }
    const event = options.project(incomingEvent);
    if (!event) {
      return;
    }
    try {
      options.record(event);
    } catch (error) {
      // A broken log observer must not prevent application observers from updating.
      console.error("[gateway] event handler error:", error);
    }
    notifyGatewayObservers(options.listeners, event, "event listener", options.isCurrent);
  };
}

export function notifyGatewayObservers<T>(
  listeners: ReadonlySet<(value: T) => void>,
  value: T,
  errorLabel: string,
  isCurrent?: (value: T) => boolean,
): void {
  // Snapshot membership because callbacks may mutate subscriptions or replace their owner.
  for (const listener of Array.from(listeners)) {
    if (isCurrent && !isCurrent(value)) {
      return;
    }
    try {
      listener(value);
    } catch (error) {
      console.error(`[gateway] ${errorLabel} handler error:`, error);
    }
  }
}

export function createGatewayEventLog() {
  let entries: EventLogEntry[] = [];
  let revision = 0;
  let recoveryScope: string | null = null;
  const retire = () => {
    revision += 1;
    entries = [];
    return entries;
  };
  return {
    get entries(): readonly EventLogEntry[] {
      return entries;
    },
    get revision() {
      return revision;
    },
    resetConnection() {
      recoveryScope = null;
      return retire();
    },
    bindRecoveryScope(value: string | undefined) {
      const nextScope = value ?? "";
      const changed = recoveryScope !== null && recoveryScope !== nextScope;
      recoveryScope = nextScope;
      return changed ? retire() : null;
    },
    record(event: GatewayEventFrame) {
      entries = [{ ts: Date.now(), event: event.event, payload: event.payload }, ...entries].slice(
        0,
        250,
      );
      return entries;
    },
  };
}
