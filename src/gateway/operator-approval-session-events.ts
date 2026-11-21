import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PendingApprovalSnapshot,
  SessionApprovalEvent,
  SessionApprovalReplay,
} from "../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../config/io.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { resolveApprovalSourceStreamKey } from "./approval-session-audience.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  canSubscribeOperatorApprovals,
  participationExecApprovalRecipient,
} from "./exec-approval-delivery.js";
import type {
  ExecApprovalManager,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import {
  canObserveParticipationExecApproval,
  canResolveParticipationExecApproval,
  participationApprovalTurnActor,
} from "./exec-approval-participation.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  canAccessOperatorApproval,
  canReviewOperatorApproval,
} from "./operator-approval-authorization.js";
import { matchesOperatorApprovalReviewerBinding } from "./operator-approval-reviewer-binding.js";
import { projectOperatorApprovalSnapshot } from "./operator-approval-snapshot.js";
import {
  listPendingOperatorApprovals,
  prepareOperatorApprovalReplay,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import {
  canAccessInvitedApprovalSession,
  prepareProjectedApprovalSessionAccess,
  readOperatorApprovalRequestSource,
} from "./server-methods/approval-record-lookup.js";
import type { GatewayClient, PreparedSessionApprovalReplay } from "./server-methods/types.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const MAX_SESSION_APPROVAL_REPLAY = 1_000;
const MAX_IDLE_REPLAY_SCOPES = 64;
type ApprovalReplaySnapshot = Omit<PreparedSessionApprovalReplay, "release"> & {
  records: OperatorApprovalRecord[];
  reusable: boolean;
};
type ApprovalReplayScope = {
  sessionKey: string;
  reviewerDeviceId: string | undefined;
  execApprovalIds?: readonly string[];
  kind?: "exec";
  references: number;
  revision: number;
  preparation?: Promise<ApprovalReplaySnapshot>;
  completed?: ApprovalReplaySnapshot;
};

type OperatorApprovalSessionEventRuntime = {
  publish: (event: OperatorApprovalLifecycleEvent) => void;
  replay: (
    sessionKey: string,
    client: GatewayClient | null,
  ) => Promise<PreparedSessionApprovalReplay>;
};

function resolveApprovalSourceStreamKeyForRecord(record: OperatorApprovalRecord): string | null {
  return (
    record.audienceSessionKeys[0] ??
    (record.source.sessionKey
      ? resolveApprovalSourceStreamKey(record.source.sessionKey, record.source.agentId)
      : null)
  );
}

/** Project durable approval truth to exact, explicitly opted-in session audiences. */
export function createOperatorApprovalSessionEventRuntime(params: {
  clients: Iterable<GatewayClient>;
  sessionMessageSubscribers: Pick<SessionMessageSubscriberRegistry, "getApprovals">;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  controlUiBasePath?: string;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
  reconcileTerminal?: (record: OperatorApprovalRecord) => boolean | Promise<boolean>;
  getLiveManager?: (
    kind: OperatorApprovalRecord["kind"],
  ) =>
    | Pick<
        ExecApprovalManager<unknown>,
        "runtimeEpoch" | "getLiveSnapshot" | "listLocalPendingRecords"
      >
    | undefined;
  isCurrent?: () => boolean;
}): OperatorApprovalSessionEventRuntime {
  const controlUiBasePath = normalizeControlUiBasePath(params.controlUiBasePath);
  const replayScopes = new Map<string, ApprovalReplayScope>();
  const idleScopes = new Map<string, ApprovalReplayScope>();

  const approvalRecipient = (record: OperatorApprovalRecord) => {
    const manager = params.getLiveManager?.(record.kind);
    const live = manager?.getLiveSnapshot(record.id);
    const participation =
      record.kind === "exec" ? participationExecApprovalRecipient(manager, record.id) : undefined;
    return (client: GatewayClient | null) =>
      Boolean(
        params.isCurrent?.() !== false &&
        !client?.invalidated &&
        // No durable projection can reconstruct a lost host-only exec binding.
        (record.kind !== "exec" ||
          !params.getLiveManager ||
          (live &&
            manager?.runtimeEpoch === record.runtimeEpoch &&
            params.getLiveManager(record.kind) === manager &&
            manager.getLiveSnapshot(record.id) === live)) &&
        (participation
          ? client && participation(client)
          : canAccessInvitedApprovalSession({
              cfg: getRuntimeConfig(),
              client,
              ...readOperatorApprovalRequestSource(record),
              prepared: prepareProjectedApprovalSessionAccess({
                cfg: getRuntimeConfig(),
                client,
                projection: params.getSessionRowProjection?.(),
              }),
            }) && canAccessOperatorApproval({ client, binding: record })),
      );
  };

  const participantProjection = (record: OperatorApprovalRecord, sessionKey: string) => {
    const manager = params.getLiveManager?.("exec");
    const live = record.kind === "exec" ? manager?.getLiveSnapshot(record.id) : undefined;
    if (
      !live?.participation ||
      resolveApprovalSourceStreamKey(live.participation.sessionKey, record.source.agentId) !==
        sessionKey ||
      !record.source.runId ||
      manager?.runtimeEpoch !== record.runtimeEpoch
    ) {
      return undefined;
    }
    const canReceive = (client: GatewayClient | null) =>
      params.isCurrent?.() !== false &&
      params.getLiveManager?.("exec") === manager &&
      manager.getLiveSnapshot(record.id) === live &&
      canObserveParticipationExecApproval(live, client);
    const event: Extract<SessionApprovalEvent, { phase: "participant" }> = {
      phase: "participant",
      sessionKey,
      updatedAtMs: record.updatedAtMs,
      approvalId: record.id,
      runId: record.source.runId,
      participantId: live.participation.participantProfileId,
      status: record.status === "pending" ? "pending" : "terminal",
      expiresAtMs: record.expiresAtMs,
    };
    return { event, canReceive };
  };

  const authorizedRecipients = (
    sessionKey: string,
    canReceive: (client: GatewayClient) => boolean,
  ): ReadonlySet<string> => {
    const subscribed = params.sessionMessageSubscribers.getApprovals(sessionKey);
    if (subscribed.size === 0) {
      return subscribed;
    }
    const recipients = new Set<string>();
    for (const client of params.clients) {
      const connId = client.connId;
      if (!client.invalidated && connId && subscribed.has(connId) && canReceive(client)) {
        recipients.add(connId);
      }
    }
    return recipients;
  };

  const publish = (event: OperatorApprovalLifecycleEvent): void => {
    for (const [key, scope] of replayScopes) {
      if (
        event.record.audienceSessionKeys.includes(scope.sessionKey) &&
        (scope.execApprovalIds?.includes(event.record.id) ||
          scope.reviewerDeviceId === undefined ||
          matchesOperatorApprovalReviewerBinding(event.record, scope.reviewerDeviceId))
      ) {
        scope.revision += 1;
        scope.preparation = undefined;
        scope.completed = undefined;
        if (scope.references === 0) {
          idleScopes.delete(key);
          replayScopes.delete(key);
        }
      }
    }
    const source = event.record.source;
    const pending = event.phase === "pending" && event.record.status === "pending";
    const manager = params.getLiveManager?.(event.record.kind);
    const live = pending ? manager?.getLiveSnapshot(event.record.id) : undefined;
    const request = asOptionalObjectRecord(live?.request);
    const livePending = Boolean(
      manager?.runtimeEpoch === event.record.runtimeEpoch &&
      live &&
      live.resolvedAtMs === undefined &&
      live.expiresAtMs > Date.now() &&
      request?.runId === source.runId &&
      request?.sessionId === source.sessionId &&
      request?.sessionKey === source.sessionKey,
    );
    if (
      params.getLiveManager &&
      params.isCurrent?.() !== false &&
      source.runId &&
      source.sessionId &&
      (pending ? livePending : event.record.status !== "pending")
    ) {
      // Only the approval owner emits these transitions. Tool-result approval
      // text can arrive after resolution and cannot re-open an attention request.
      emitAgentEvent({
        runId: source.runId,
        sessionId: source.sessionId,
        ...(source.sessionKey ? { sessionKey: source.sessionKey } : {}),
        stream: "execution",
        data: { approval: { id: event.record.id, state: pending ? "pending" : "resolved" } },
      });
    }
    const snapshot = projectOperatorApprovalSnapshot(event.record, controlUiBasePath);
    const boundRecord = manager?.getLiveSnapshot(event.record.id);
    const turnActor = participationApprovalTurnActor(boundRecord);
    const approval = snapshot && {
      ...snapshot,
      ...(turnActor ? { turnActor } : {}),
      // Full participation snapshots go only to the exact creator/admin recipient below.
      ...(snapshot.status === "pending" && boundRecord?.participation ? { canDecide: true } : {}),
    };
    if (!approval || event.record.audienceSessionKeys.length === 0) {
      return;
    }
    // The audience walk seeds the fully canonicalized source stream key as its
    // first entry; publish that exact form so parents can correlate the event
    // with a stream key they subscribed to. Raw source aliases (bare "global",
    // "main", unscoped child keys) never reach subscribers.
    const sourceStreamKey = resolveApprovalSourceStreamKeyForRecord(event.record);
    const canReceive = approvalRecipient(event.record);
    const participationApprovalRecipient =
      event.record.kind === "exec"
        ? participationExecApprovalRecipient(manager, event.record.id)
        : undefined;
    for (const sessionKey of event.record.audienceSessionKeys) {
      const participant = participantProjection(event.record, sessionKey);
      if (participant) {
        const recipients = authorizedRecipients(sessionKey, participant.canReceive);
        if (recipients.size > 0) {
          params.broadcastToConnIds("session.approval", participant.event, recipients, {
            participationApprovalRecipient: participant.canReceive,
          });
        }
      }
      const recipients = authorizedRecipients(sessionKey, canReceive);
      if (recipients.size === 0) {
        continue;
      }
      const common = {
        sessionKey,
        ...(sourceStreamKey ? { sourceSessionKey: sourceStreamKey } : {}),
        updatedAtMs: event.record.updatedAtMs,
      };
      let payload: SessionApprovalEvent;
      if (event.phase === "pending") {
        if (approval.status !== "pending") {
          continue;
        }
        payload = { ...common, phase: "pending", approval };
      } else {
        if (approval.status === "pending") {
          continue;
        }
        payload = { ...common, phase: "terminal", approval };
      }
      if (participationApprovalRecipient) {
        params.broadcastToConnIds("session.approval", payload, recipients, {
          participationApprovalRecipient: canReceive,
        });
      } else {
        params.broadcastToConnIds("session.approval", payload, recipients);
      }
    }
  };

  const prepareReplay = async (scope: ApprovalReplayScope): Promise<ApprovalReplaySnapshot> => {
    const { sessionKey, reviewerDeviceId } = scope;
    const snapshotAtMs = Date.now();
    const input = {
      audienceSessionKey: sessionKey,
      reviewerDeviceId,
      kind: scope.kind,
      execApprovalIds: scope.execApprovalIds,
      limit: MAX_SESSION_APPROVAL_REPLAY + 1,
      nowMs: snapshotAtMs,
    };
    const readRevision = scope.revision;
    const prepared = await prepareOperatorApprovalReplay(input);
    // A replay read can be the first observer after a suspended timer. Emit
    // the durable timeout tombstone before returning the authoritative set.
    if (prepared.outcome === "expired") {
      for (const record of prepared.records) {
        const reconciled = await params.reconcileTerminal?.(record);
        if (reconciled !== true) {
          publish({ phase: "terminal", record });
        }
      }
    }
    if (params.isCurrent?.() === false) {
      throw new Error("Operator approval replay authority is no longer current");
    }
    const revision = prepared.outcome === "expired" ? scope.revision : readRevision;
    const records =
      prepared.outcome === "expired" ? await listPendingOperatorApprovals(input) : prepared.records;
    const storeIsCurrent = prepared.outcome === "pending" ? prepared.isCurrent : undefined;
    const isCurrent = () => revision === scope.revision && storeIsCurrent?.() !== false;
    const approvals: PendingApprovalSnapshot[] = [];
    const truncated = records.length > MAX_SESSION_APPROVAL_REPLAY;
    for (const record of records) {
      if (approvals.length === MAX_SESSION_APPROVAL_REPLAY) {
        break;
      }
      const approval = projectOperatorApprovalSnapshot(record, controlUiBasePath);
      if (approval?.status === "pending") {
        const sourceSessionKey = resolveApprovalSourceStreamKeyForRecord(record);
        approvals.push({
          ...approval,
          ...(sourceSessionKey ? { sourceSessionKey } : {}),
        });
      }
    }
    const replay: SessionApprovalReplay = {
      sessionKey,
      updatedAtMs: snapshotAtMs,
      approvals,
      truncated,
    };
    return { replay, records, isCurrent, reusable: storeIsCurrent !== undefined };
  };

  return {
    publish,
    replay: async (sessionKey, client) => {
      if (!canSubscribeOperatorApprovals(client)) {
        return {
          replay: {
            sessionKey,
            updatedAtMs: Date.now(),
            approvals: [],
            truncated: false,
          },
          isCurrent: () => !canSubscribeOperatorApprovals(client),
          release: () => {},
        };
      }
      const scopes = [...(client?.connect.scopes ?? [])];
      const deviceId = client?.connect.device?.id;
      const profileId = client?.authenticatedUserProfile?.profileId;
      const reviewerDeviceId = scopes.includes(ADMIN_SCOPE) ? undefined : deviceId?.trim();
      const ordinaryReviewer = canReviewOperatorApproval(client);
      // Select live-authorized exec IDs before the store applies its bounded replay limit.
      const execApprovalIds = params.getLiveManager
        ? (params.getLiveManager("exec")?.listLocalPendingRecords() ?? [])
            .filter(
              (record) =>
                canObserveParticipationExecApproval(record, client) ||
                (canResolveParticipationExecApproval(record, client) ??
                  canAccessOperatorApproval({
                    client,
                    binding: { reviewerDeviceIds: record.approvalReviewerDeviceIds },
                  })),
            )
            .map((record) => record.id)
            .toSorted()
        : ordinaryReviewer
          ? undefined
          : [];
      const kind = ordinaryReviewer ? undefined : "exec";
      const assertCurrent = () => {
        if (
          params.isCurrent?.() === false ||
          client?.invalidated ||
          !canSubscribeOperatorApprovals(client) ||
          profileId !== client?.authenticatedUserProfile?.profileId ||
          scopes.join("\0") !== client?.connect.scopes?.join("\0") ||
          (!scopes.includes(ADMIN_SCOPE) && deviceId !== client?.connect.device?.id)
        ) {
          throw new Error("Operator approval replay authority is no longer current");
        }
      };
      assertCurrent();
      // Completed replay is reusable only while the durable owner confirms its
      // selection and deadline, independently of runtime lifecycle publications.
      const key = JSON.stringify([sessionKey, reviewerDeviceId, kind, execApprovalIds]);
      let scope = replayScopes.get(key);
      if (!scope) {
        scope = {
          sessionKey,
          reviewerDeviceId,
          kind,
          execApprovalIds,
          references: 0,
          revision: 0,
        };
        replayScopes.set(key, scope);
      }
      const retained = scope;
      idleScopes.delete(key);
      retained.references += 1;
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        retained.references -= 1;
        if (retained.references === 0) {
          if (retained.completed?.isCurrent()) {
            idleScopes.set(key, retained);
            if (idleScopes.size > MAX_IDLE_REPLAY_SCOPES) {
              const oldest = idleScopes.keys().next().value!;
              idleScopes.delete(oldest);
              replayScopes.delete(oldest);
            }
          } else {
            replayScopes.delete(key);
          }
        }
      };
      try {
        let prepared = retained.completed;
        if (!prepared?.isCurrent()) {
          retained.completed = undefined;
          let preparation = retained.preparation;
          if (!preparation) {
            preparation = prepareReplay(retained)
              .then((snapshot) => {
                if (
                  retained.preparation === preparation &&
                  snapshot.reusable &&
                  snapshot.isCurrent()
                ) {
                  retained.completed = snapshot;
                }
                return snapshot;
              })
              .finally(() => {
                if (retained.preparation === preparation) {
                  retained.preparation = undefined;
                }
              });
            retained.preparation = preparation;
          }
          prepared = await preparation;
        }
        assertCurrent();
        // Cached store selections are shared; authorization and live bindings never are.
        const recipients = new Map(
          prepared.records.map((record) => [record.id, approvalRecipient(record)]),
        );
        const approvals = prepared.replay.approvals
          .filter((approval) => recipients.get(approval.id)?.(client))
          .map((approval) => {
            const record =
              approval.presentation.kind === "exec"
                ? params.getLiveManager?.("exec")?.getLiveSnapshot(approval.id)
                : undefined;
            const turnActor = participationApprovalTurnActor(record);
            return Object.assign(
              {},
              approval,
              turnActor ? { turnActor } : {},
              record?.participation
                ? { canDecide: canResolveParticipationExecApproval(record, client) === true }
                : {},
            );
          });
        const participants = prepared.records.flatMap((record) => {
          const projection = participantProjection(record, sessionKey);
          return projection?.event.status === "pending" && projection.canReceive(client)
            ? [projection]
            : [];
        });
        return {
          replay: {
            ...prepared.replay,
            approvals,
            ...(participants.length
              ? { participantApprovals: participants.map(({ event }) => event) }
              : {}),
          },
          isCurrent: () => {
            assertCurrent();
            return (
              !released &&
              prepared.isCurrent() &&
              approvals.every((approval) => recipients.get(approval.id)?.(client)) &&
              participants.every(({ canReceive }) => canReceive(client))
            );
          },
          release,
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
