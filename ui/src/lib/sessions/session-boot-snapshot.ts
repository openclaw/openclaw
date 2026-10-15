import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { readOfflineStorageScope, type BootRecord } from "../../app/boot-record.ts";
import {
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
} from "../../pages/chat/session-snapshot-invalidation-events.ts";
import {
  admitSidebarBootScope,
  readSidebarBootSnapshot,
  sidebarSnapshotScopeKey,
  subscribeSidebarBootRetirement,
} from "../../pages/chat/session-snapshot-prewarm.ts";
import type { SessionGateway, SessionState } from "./session-capability.ts";

export function createSessionBootSnapshot(
  gateway: SessionGateway,
  agentSelection: { readonly state: { readonly selectedId: string | null } },
  { bootRecord }: { bootRecord?: BootRecord | null },
  host: { readState: () => SessionState; publish: (state: SessionState) => void },
) {
  const stopAdmission = bootRecord ? admitSidebarBootScope(gateway, bootRecord) : undefined;
  const scope = bootRecord?.recoveryScope
    ? {
        gatewayScope: bootRecord.scope,
        recoveryScope: bootRecord.recoveryScope,
        profileId: bootRecord.profileId,
      }
    : null;
  const currentScope = () =>
    JSON.stringify([
      gateway.connection
        ? gatewayCredentialScope(gateway.connection.gatewayUrl)
        : bootRecord?.scope,
      readOfflineStorageScope({ client: gateway.snapshot.client }) ?? bootRecord?.recoveryScope,
    ]);
  const initialScope = currentScope();
  const initialRevision = gateway.connectionRevision;
  const initialAgentId = agentSelection.state.selectedId;
  let cachedScope = initialScope;
  let cachedRevision = initialRevision;
  let cachedProfileId = bootRecord?.profileId;
  const retirement = new AbortController();
  const current = () =>
    currentScope() === initialScope && gateway.connectionRevision === initialRevision;
  const clear = () =>
    host.publish({
      ...host.readState(),
      result: null,
      resultCached: false,
      agentId: null,
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    });
  const retire = () => {
    retirement.abort();
    if (host.readState().resultCached) {
      clear();
    }
  };
  const stopRetirement = subscribeSidebarBootRetirement(() => scope, retire);
  const stopInvalidation = subscribeSnapshotInvalidation((event) => {
    if (scope && sidebarSnapshotInvalidationMatches(sidebarSnapshotScopeKey(scope), event)) {
      retire();
    }
  });
  let routingDefaults = bootRecord
    ? { mainKey: bootRecord.agents.mainKey, scope: bootRecord.agents.scope }
    : undefined;
  // Hello releases routing even if the shared IndexedDB read never finishes.
  const settled = new Promise<void>((resolve) => {
    if (!bootRecord || gateway.snapshot.phase === "connected") {
      resolve();
      return;
    }
    retirement.signal.addEventListener("abort", () => resolve(), { once: true });
    void readSidebarBootSnapshot(gateway)
      .then((snapshot) => {
        if (!snapshot || retirement.signal.aborted || !current()) {
          return;
        }
        routingDefaults = snapshot.routingDefaults;
        const roster = snapshot.roster;
        if (
          roster &&
          gateway.snapshot.phase !== "connected" &&
          agentSelection.state.selectedId === initialAgentId &&
          roster.agentId === initialAgentId &&
          host.readState().result === null
        ) {
          host.publish({ ...host.readState(), ...roster, resultCached: true });
        }
      })
      .then(resolve, resolve);
  });
  return {
    settled,
    get routingDefaults() {
      return !retirement.signal.aborted && gateway.snapshot.phase !== "connected" && current()
        ? routingDefaults
        : undefined;
    },
    synchronize(snapshot: SessionGateway["snapshot"]): void {
      const nextScope = currentScope();
      if (
        nextScope !== cachedScope ||
        gateway.connectionRevision !== cachedRevision ||
        (snapshot.phase === "connected" &&
          cachedProfileId !== undefined &&
          cachedProfileId !== (snapshot.selfUser?.id ?? null))
      ) {
        cachedScope = nextScope;
        cachedRevision = gateway.connectionRevision;
        cachedProfileId = undefined;
        retirement.abort();
        clear();
      } else if (snapshot.phase === "connected") {
        retirement.abort();
      }
    },
    dispose() {
      stopRetirement();
      stopInvalidation();
      stopAdmission?.();
      retirement.abort();
    },
  };
}
