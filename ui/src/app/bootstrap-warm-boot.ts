import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { clearCachedBootState } from "../lib/sessions/session-roster-cache.runtime.ts";
import { sessionRosterScope } from "../lib/sessions/session-roster-cache.ts";
import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import {
  markPrewarmedChatSnapshotReady,
  prewarmChatSnapshot,
} from "../pages/chat/session-snapshot-prewarm.ts";
import {
  clearBootRecords,
  retirePendingBootRecord,
  bootRecordOwner,
  sameBootRecordOwner,
  type BootRecordOwner,
  subscribeBootRecordChanges,
  readOfflineStorageScope,
  persistBootRecord,
  resolveBootRecordAuth,
  type BootRecord,
} from "./boot-record.ts";
import type { ApplicationContext } from "./context.ts";
import type { ApplicationGateway } from "./gateway.ts";

export function prewarmBootChat(record: BootRecord, sessionKey: string): void {
  if (parseAgentSessionKey(sessionKey)) {
    prewarmChatSnapshot(
      resolveChatSnapshotKey(
        {
          agentsList: record.agents,
          hello: null,
          assistantAgentId: null,
          settings: { gatewayUrl: record.scope },
          client: { offlineRecoveryScope: record.recoveryScope },
        },
        { sessionKey },
      ),
    );
  }
}

export function clearWarmBootState(gatewayScope: string, owner: BootRecordOwner): Promise<void> {
  // The boot record gates the next warm boot, so it must be gone before any
  // await: a reload during storage cleanup must fail closed.
  clearBootRecords(gatewayScope, owner);
  const recoveryScope = owner.recoveryScope;
  const rosterCleared = clearCachedBootState(sessionRosterScope(gatewayScope, recoveryScope));
  // Legacy admission identifies its gateway-keyed roster, not an account-qualified
  // transcript. Never guess an account when retiring that unscoped cache.
  if (!recoveryScope) {
    return rosterCleared;
  }
  // Invalidate visible history and its cursor before pane subscribers resume startup.
  const snapshotsCleared = clearStoredChatSnapshots(
    `scope:${JSON.stringify([gatewayScope, recoveryScope])}\u0000`,
  );
  return Promise.all([rosterCleared, snapshotsCleared]).then(() => undefined);
}

export function subscribeWarmBootConnection(
  gateway: ApplicationGateway,
  record: BootRecord | null,
  onRejected: () => void,
): () => void {
  const bootConnectionRevision = gateway.connectionRevision;
  let pendingBootProfileId = record?.profileId;
  let retainedScope = record?.recoveryScope;
  let admittedOwner = record ? bootRecordOwner(record) : undefined;
  const stopRetirement = subscribeBootRecordChanges(
    ({ scope, external, replacement, retiredOwner }) => {
      if (scope === undefined || scope === gatewayCredentialScope(gateway.connection.gatewayUrl)) {
        const snapshot = gateway.snapshot;
        const liveScope = snapshot.hello?.auth?.recoveryScope;
        const owner =
          liveScope ?? readOfflineStorageScope({ client: snapshot.client }) ?? retainedScope;
        const capturedOwner = admittedOwner;
        const currentOwner = owner ? { recoveryScope: owner } : capturedOwner;
        if (replacement && !sameBootRecordOwner(replacement, capturedOwner)) {
          admittedOwner = undefined;
        }
        if (
          !currentOwner ||
          (retiredOwner &&
            !sameBootRecordOwner(retiredOwner, currentOwner) &&
            !sameBootRecordOwner(retiredOwner, capturedOwner)) ||
          sameBootRecordOwner(replacement, currentOwner)
        ) {
          return;
        }
        pendingBootProfileId = undefined;
        admittedOwner = undefined;
        if (
          external ||
          !liveScope ||
          (retainedScope !== undefined && liveScope === retainedScope)
        ) {
          // A live successor can still be debounced behind a peer-retired legacy
          // record. Local old-owner cleanup during a new hello must not cancel it.
          retirePendingBootRecord(
            gatewayCredentialScope(gateway.connection.gatewayUrl),
            currentOwner,
          );
          gateway.snapshot.client?.retireOfflineRecoveryScope?.();
        }
        onRejected();
        if (external) {
          gateway.stop();
        }
      }
    },
  );
  const stopConnection = gateway.subscribe((snapshot) => {
    if (snapshot.phase === "connected") {
      markPrewarmedChatSnapshotReady();
    }
    if (gateway.connectionRevision !== bootConnectionRevision) {
      pendingBootProfileId = undefined;
      admittedOwner = undefined;
    }
    if (
      pendingBootProfileId !== undefined &&
      (snapshot.lastErrorAuthReason ||
        (typeof snapshot.lastErrorCode === "string" && snapshot.lastErrorCode !== "GATEWAY_BUSY"))
    ) {
      // A later transport failure cannot erase a rejected initial admission.
      // Retire this boot record, not drafts/outboxes or another Gateway’s cache.
      onRejected();
      if (admittedOwner) {
        clearBootRecords(gatewayCredentialScope(gateway.connection.gatewayUrl), admittedOwner);
      }
      pendingBootProfileId = undefined;
    }
    if (snapshot.phase !== "connected" || pendingBootProfileId === undefined) {
      return;
    }
    const scopeMismatch =
      retainedScope !== undefined && snapshot.hello?.auth?.recoveryScope !== retainedScope;
    const profileMismatch =
      retainedScope === undefined && pendingBootProfileId !== (snapshot.selfUser?.id ?? null);
    pendingBootProfileId = undefined;
    if (profileMismatch || scopeMismatch) {
      onRejected();
      if (admittedOwner) {
        void clearWarmBootState(
          gatewayCredentialScope(gateway.connection.gatewayUrl),
          admittedOwner,
        );
      }
    }
    retainedScope = snapshot.hello?.auth?.recoveryScope;
  });
  return () => {
    stopRetirement();
    stopConnection();
  };
}

export function subscribeBootRecordPersistence(
  { gateway, agents, sessions }: Pick<ApplicationContext, "gateway" | "agents" | "sessions">,
  initialRecord: BootRecord | null,
) {
  let routingDefaults = initialRecord
    ? {
        gatewayScope: initialRecord.scope,
        recoveryScope: initialRecord.recoveryScope,
        mainKey: initialRecord.agents.mainKey,
        scope: initialRecord.agents.scope,
      }
    : null;
  const persistLiveBootRecord = () => {
    if (gateway.snapshot.phase !== "connected" || gateway.snapshot.client?.offlineRecoveryRetired) {
      return;
    }
    const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const auth = resolveBootRecordAuth(gateway.snapshot.hello?.auth, gateway.connection.token);
    if (!auth) {
      return;
    }
    const agentsList = agents.state.agentsList;
    if (agentsList) {
      // Refresh this narrow projection as soon as discovery lands, independently
      // of group persistence. A later disconnect must not revive startup defaults.
      routingDefaults = {
        gatewayScope: scope,
        recoveryScope: gateway.snapshot.hello?.auth?.recoveryScope,
        mainKey: agentsList.mainKey,
        scope: agentsList.scope,
      };
    }
    if (agentsList && sessions.groupsStatus() === "ready") {
      persistBootRecord({
        version: 2,
        recoveryScope: gateway.snapshot.client?.recoveryScopeReady
          ? gateway.snapshot.client.recoveryScope
          : gateway.snapshot.hello?.auth?.recoveryScope,
        ...auth,
        savedAt: Date.now(),
        scope,
        profileId: gateway.snapshot.selfUser?.id ?? null,
        agents: agentsList,
        groups: [...sessions.state.groupSettings],
        sectionOrder: [...sessions.state.sectionOrder],
      });
    }
  };
  const stops = [gateway, agents, sessions].map((capability) =>
    capability.subscribe(persistLiveBootRecord),
  );
  return {
    readSessionDefaults: () => {
      const account = readOfflineStorageScope({ client: gateway.snapshot.client });
      return gateway.snapshot.phase !== "connected" &&
        account &&
        routingDefaults?.recoveryScope === account &&
        routingDefaults.gatewayScope === gatewayCredentialScope(gateway.connection.gatewayUrl)
        ? { mainKey: routingDefaults.mainKey, scope: routingDefaults.scope }
        : null;
    },
    dispose: () => stops.forEach((stop) => stop()),
  };
}
