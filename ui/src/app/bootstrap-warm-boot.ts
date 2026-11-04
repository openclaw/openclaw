import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
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
  type RecordInputs = Omit<BootRecord, "savedAt" | "groups" | "sectionOrder"> & {
    groups: readonly BootRecord["groups"][number][];
    sectionOrder: readonly string[];
  };
  let lastInputs: RecordInputs | undefined;
  const connectionRevision = gateway.connectionRevision;
  let routingDefaults = initialRecord
    ? {
        gatewayScope: initialRecord.scope,
        recoveryScope: initialRecord.recoveryScope,
        agents: initialRecord.agents,
      }
    : null;
  const persistLiveBootRecord = () => {
    if (gateway.snapshot.phase !== "connected" || gateway.snapshot.client?.offlineRecoveryRetired) {
      lastInputs = undefined;
      return;
    }
    const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const auth = resolveBootRecordAuth(gateway.snapshot.hello?.auth, gateway.connection.token);
    if (!auth) {
      lastInputs = undefined;
      return;
    }
    const agentsList = agents.state.agentsList;
    if (agentsList) {
      // Refresh display and routing facts independently of group persistence.
      // A later disconnect must not revive startup names or defaults.
      routingDefaults = {
        gatewayScope: scope,
        recoveryScope: gateway.snapshot.hello?.auth?.recoveryScope,
        agents: agentsList,
      };
    }
    // Unknown identity must not replace a peer's resolved sidebar cache key.
    if (
      agentsList &&
      sessions.groupsStatus() === "ready" &&
      gateway.snapshot.selfUser !== undefined
    ) {
      const inputs: RecordInputs = {
        version: 2,
        recoveryScope: gateway.snapshot.client?.recoveryScopeReady
          ? gateway.snapshot.client.recoveryScope
          : gateway.snapshot.hello?.auth?.recoveryScope,
        ...auth,
        scope,
        profileId: gateway.snapshot.selfUser?.id ?? null,
        agents: agentsList,
        groups: sessions.state.groupSettings,
        sectionOrder: sessions.state.sectionOrder,
      };
      // Only boot inputs may postpone the write, not row or unrelated Gateway publications.
      if (
        lastInputs?.scope === inputs.scope &&
        lastInputs.recoveryScope === inputs.recoveryScope &&
        lastInputs.authMethod === inputs.authMethod &&
        lastInputs.credential === inputs.credential &&
        lastInputs.profileId === inputs.profileId &&
        lastInputs.agents === inputs.agents &&
        lastInputs.groups === inputs.groups &&
        lastInputs.sectionOrder === inputs.sectionOrder
      ) {
        return;
      }
      lastInputs = inputs;
      persistBootRecord({
        ...inputs,
        savedAt: Date.now(),
        groups: [...inputs.groups],
        sectionOrder: [...inputs.sectionOrder],
      });
    } else {
      lastInputs = undefined;
    }
  };
  // Persist admitted owner snapshots independently of mounted views.
  const stops = [gateway, agents, sessions].map((capability) =>
    capability.subscribe(persistLiveBootRecord),
  );
  const readOfflineAgents = () => {
    const account = readOfflineStorageScope({ client: gateway.snapshot.client });
    return gateway.connectionRevision === connectionRevision &&
      gateway.snapshot.phase !== "connected" &&
      account &&
      routingDefaults?.recoveryScope === account &&
      routingDefaults.gatewayScope === gatewayCredentialScope(gateway.connection.gatewayUrl)
      ? routingDefaults.agents
      : null;
  };
  return {
    readSessionDefaults: () => {
      const roster = readOfflineAgents();
      return roster ? { mainKey: roster.mainKey, scope: roster.scope } : null;
    },
    readAgentIdentity: (agentId: string) => {
      const agent = readOfflineAgents()?.agents.find((entry) => entry.id === agentId);
      return agent
        ? { agentId, name: agent.identity?.name || agent.name, emoji: agent.identity?.emoji }
        : null;
    },
    dispose: () => stops.forEach((stop) => stop()),
  };
}
