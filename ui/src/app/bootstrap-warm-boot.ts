import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { RouteLocation } from "@openclaw/uirouter";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import {
  buildAgentMainSessionKey,
  isDashboardSessionKey,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import { prewarmChatSnapshot } from "../pages/chat/session-snapshot-prewarm.ts";
import {
  clearBootRecords,
  retirePendingBootRecord,
  bootRecordOwner,
  sameBootRecordOwner,
  subscribeBootRecordChanges,
  readOfflineStorageScope,
  persistBootRecord,
  resolveBootRecordAuth,
  type BootRecord,
} from "./boot-record.ts";
import type { ApplicationContext } from "./context.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { clearWarmBootState } from "./warm-boot-retirement.ts";

export function prewarmBootChat(
  record: BootRecord,
  lastSessionKey: string,
  location: RouteLocation,
  basePath: string,
): void {
  const target = sessionRefFromPath(location.pathname, basePath, record.agents.mainKey);
  const path = location.pathname.slice(basePath.length).replace(/\/$/u, "");
  if (!target && path !== "" && path !== "/chat") {
    return;
  }
  // Dashboard names are ambiguous until the roster resolves them. Warm one
  // same-agent last-viewed candidate; only the route's exact key can consume it.
  const savedDashboardCandidate =
    target?.namespace === "dashboard" &&
    target.kind === "literal" &&
    target.slugCandidate &&
    isDashboardSessionKey(lastSessionKey) &&
    parseAgentSessionKey(lastSessionKey)?.agentId === target.agentId;
  const sessionKey = savedDashboardCandidate
    ? lastSessionKey
    : target?.kind === "main"
      ? buildAgentMainSessionKey({ agentId: target.agentId, mainKey: record.agents.mainKey })
      : target?.kind === "literal"
        ? target.sessionKey
        : lastSessionKey;
  if (target?.kind === "short" && parseAgentSessionKey(sessionKey)?.agentId !== target.agentId) {
    return;
  }
  if (parseAgentSessionKey(sessionKey)) {
    void prewarmChatSnapshot(
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
  // Rejected connection receipts retire warm-boot ownership before recovery consumers run.
  const stopConnection = gateway.subscribe((snapshot) => {
    if (gateway.connectionRevision !== bootConnectionRevision) {
      pendingBootProfileId = undefined;
      admittedOwner = undefined;
    }
    if (
      pendingBootProfileId !== undefined &&
      (snapshot.lastErrorAuthReason ||
        (snapshot.lastErrorCode !== null && snapshot.lastErrorCode !== "GATEWAY_BUSY"))
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
    // Unknown identity must not replace a peer's resolved sidebar cache key.
    if (
      agentsList &&
      sessions.groupsStatus() === "ready" &&
      gateway.snapshot.selfUser !== undefined
    ) {
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
  // Persist admitted owner snapshots independently of mounted views.
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
