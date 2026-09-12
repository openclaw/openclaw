import type {
  ModelCatalogTarget,
  ModelsSnapshotEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { invalidateChatMetadataStore } from "../lib/chat/chat-metadata-cache.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import {
  beginModelCatalogRead,
  publishModelCatalogResult,
  type ModelCatalogRead,
  type ModelCatalogReadScope,
} from "../lib/model-catalog-cache.ts";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

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

/** Reserve within the connected publication before subscribers can supersede the read. */
export function createGatewayMetadataObserver(
  isCurrent: (snapshot: ApplicationGatewaySnapshot) => boolean,
) {
  let target: ModelCatalogTarget | undefined;
  let read: ModelCatalogRead | undefined;
  const targetKey = (value: ModelCatalogTarget) =>
    JSON.stringify(
      "shortId" in value
        ? ["short", value.agentId, value.shortId, value.slugHint]
        : ["scope", value.agentId, value.sessionKey],
    );
  return {
    captureTarget(value: ModelCatalogTarget | undefined) {
      target = value;
      return value;
    },
    synchronize(previous: ApplicationGatewaySnapshot, next: ApplicationGatewaySnapshot): boolean {
      const connectionChanged = previous.client !== next.client || previous.hello !== next.hello;
      if (
        previous.client &&
        (connectionChanged ||
          previous.selfUser?.id !== next.selfUser?.id ||
          (previous.phase === "connected" && next.phase !== "connected"))
      ) {
        invalidateModelAuthStatusRequests(previous.client);
        invalidateChatMetadataStore(previous.client);
        if (!isCurrent(next)) {
          return false;
        }
      }
      if (
        !next.client ||
        !next.hello ||
        next.phase !== "connected" ||
        (!connectionChanged && previous.phase === "connected")
      ) {
        return true;
      }
      const { client, hello } = next;
      const scope: ModelCatalogReadScope | undefined =
        target && !("shortId" in target)
          ? target.sessionKey
            ? resolveUiConversationIdentity({ hello }, target.sessionKey, target.agentId)
            : {}
          : undefined;
      read = target
        ? beginModelCatalogRead(client, scope, undefined, scope?.agentId === undefined)
        : undefined;
      return true;
    },
    receive(event: GatewayEventFrame, host: UiSessionDefaultsHost): GatewayEventFrame | undefined {
      if (event.event !== "models.snapshot") {
        return event;
      }
      const currentRead = read;
      if (!currentRead) {
        return undefined;
      }
      // SAFETY: The negotiated authenticated snapshot carries ModelsSnapshotEvent.
      const publication = event.payload as ModelsSnapshotEvent;
      if (!target || targetKey(target) !== targetKey(publication.target)) {
        return undefined;
      }
      read = undefined;
      const scope = publication.scope.sessionKey
        ? resolveUiConversationIdentity(
            host,
            publication.scope.sessionKey,
            publication.scope.agentId,
          )
        : publication.scope;
      const accepted = publishModelCatalogResult(currentRead, scope, publication.catalog);
      currentRead.cache.reads.delete(currentRead);
      return accepted ? { ...event, payload: { ...publication, scope } } : undefined;
    },
  };
}
