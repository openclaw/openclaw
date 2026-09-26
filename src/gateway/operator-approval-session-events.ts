import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PendingApprovalSnapshot,
  SessionApprovalEvent,
} from "../../packages/gateway-protocol/src/index.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveApprovalSourceStreamKey } from "./approval-session-audience.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type {
  ExecApprovalManager,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  canAccessOperatorApproval,
  canReviewOperatorApproval,
} from "./operator-approval-authorization.js";
import { projectOperatorApprovalSnapshot } from "./operator-approval-snapshot.js";
import {
  expireDueOperatorApprovals,
  listPendingOperatorApprovals,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayClient, PreparedSessionApprovalReplay } from "./server-methods/types.js";

const MAX_SESSION_APPROVAL_REPLAY = 1_000;
type ApprovalSessionClient = GatewayClient & { invalidated?: boolean };

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
  clients: Iterable<ApprovalSessionClient>;
  sessionMessageSubscribers: Pick<SessionMessageSubscriberRegistry, "getApprovals">;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  controlUiBasePath?: string;
  databaseOptions?: OpenClawStateDatabaseOptions;
  now?: () => number;
  reconcileTerminal?: (record: OperatorApprovalRecord) => boolean | Promise<boolean>;
  getLiveManager?: (
    kind: OperatorApprovalRecord["kind"],
  ) => Pick<ExecApprovalManager<unknown>, "runtimeEpoch" | "getLiveSnapshot"> | undefined;
  isCurrent?: () => boolean;
}): OperatorApprovalSessionEventRuntime {
  const controlUiBasePath = normalizeControlUiBasePath(params.controlUiBasePath);
  const now = params.now ?? Date.now;
  let publicationRevision = 0;
  const preparations = new Map<string, Promise<PreparedSessionApprovalReplay>>();

  const canAccessRecord = (client: GatewayClient | null, record: OperatorApprovalRecord): boolean =>
    canAccessOperatorApproval({
      client,
      binding: { reviewerDeviceIds: record.reviewerDeviceIds },
    });

  const authorizedRecipients = (
    sessionKey: string,
    record: OperatorApprovalRecord,
  ): ReadonlySet<string> => {
    const subscribed = params.sessionMessageSubscribers.getApprovals(sessionKey);
    if (subscribed.size === 0) {
      return subscribed;
    }
    const recipients = new Set<string>();
    for (const client of params.clients) {
      const connId = client.connId;
      if (
        !client.invalidated &&
        connId &&
        subscribed.has(connId) &&
        canAccessRecord(client, record)
      ) {
        recipients.add(connId);
      }
    }
    return recipients;
  };

  const publish = (event: OperatorApprovalLifecycleEvent): void => {
    publicationRevision += 1;
    preparations.clear();
    const source = event.record.source;
    const pending = event.phase === "pending" && event.record.status === "pending";
    const manager = params.getLiveManager?.(event.record.kind);
    const live = pending ? manager?.getLiveSnapshot(event.record.id) : undefined;
    const request = asOptionalObjectRecord(live?.request);
    const livePending = Boolean(
      manager?.runtimeEpoch === event.record.runtimeEpoch &&
      live &&
      live.resolvedAtMs === undefined &&
      live.expiresAtMs > now() &&
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
    const approval = projectOperatorApprovalSnapshot(event.record, controlUiBasePath);
    if (!approval || event.record.audienceSessionKeys.length === 0) {
      return;
    }
    // The audience walk seeds the fully canonicalized source stream key as its
    // first entry; publish that exact form so parents can correlate the event
    // with a stream key they subscribed to. Raw source aliases (bare "global",
    // "main", unscoped child keys) never reach subscribers.
    const sourceStreamKey = resolveApprovalSourceStreamKeyForRecord(event.record);
    for (const sessionKey of event.record.audienceSessionKeys) {
      const recipients = authorizedRecipients(sessionKey, event.record);
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
      params.broadcastToConnIds("session.approval", payload, recipients);
    }
  };

  const prepareReplay = async (
    sessionKey: string,
    reviewerDeviceId: string | undefined,
  ): Promise<PreparedSessionApprovalReplay> => {
    const snapshotAtMs = now();
    const expired = await expireDueOperatorApprovals({
      nowMs: snapshotAtMs,
      databaseOptions: params.databaseOptions,
    });
    // A replay read can be the first observer after a suspended timer. Emit
    // the durable timeout tombstone before returning the authoritative set.
    for (const record of expired.records) {
      const reconciled = await params.reconcileTerminal?.(record);
      if (reconciled !== true) {
        publish({ phase: "terminal", record });
      }
    }
    if (params.isCurrent?.() === false) {
      throw new Error("Operator approval replay authority is no longer current");
    }
    const revision = publicationRevision;
    const records = await listPendingOperatorApprovals({
      audienceSessionKey: sessionKey,
      reviewerDeviceId,
      limit: MAX_SESSION_APPROVAL_REPLAY + 1,
      nowMs: snapshotAtMs,
      databaseOptions: params.databaseOptions,
    });
    const isCurrent = () => revision === publicationRevision;
    const approvals: PendingApprovalSnapshot[] = [];
    const truncated = records.length > MAX_SESSION_APPROVAL_REPLAY;
    for (const record of records) {
      if (approvals.length === MAX_SESSION_APPROVAL_REPLAY) {
        return {
          replay: { sessionKey, updatedAtMs: snapshotAtMs, approvals, truncated: true },
          isCurrent,
        };
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
    return { replay: { sessionKey, updatedAtMs: snapshotAtMs, approvals, truncated }, isCurrent };
  };

  return {
    publish,
    replay: async (sessionKey, client) => {
      if (!canReviewOperatorApproval(client)) {
        return {
          replay: { sessionKey, updatedAtMs: now(), approvals: [], truncated: false },
          isCurrent: () => !canReviewOperatorApproval(client),
        };
      }
      const scopes = [...(client?.connect.scopes ?? [])];
      const deviceId = client?.connect.device?.id;
      const reviewerDeviceId = scopes.includes(ADMIN_SCOPE) ? undefined : deviceId?.trim();
      const assertCurrent = () => {
        if (
          params.isCurrent?.() === false ||
          client?.invalidated ||
          !canReviewOperatorApproval(client) ||
          scopes.join("\0") !== client?.connect.scopes?.join("\0") ||
          (!scopes.includes(ADMIN_SCOPE) && deviceId !== client?.connect.device?.id)
        ) {
          throw new Error("Operator approval replay authority is no longer current");
        }
      };
      assertCurrent();
      // Only share unsettled work. Lifecycle publications fence replies but are
      // not a durable store revision suitable for retaining completed snapshots.
      const key = JSON.stringify([sessionKey, reviewerDeviceId]);
      let preparation = preparations.get(key);
      if (!preparation) {
        preparation = prepareReplay(sessionKey, reviewerDeviceId).finally(() => {
          if (preparations.get(key) === preparation) {
            preparations.delete(key);
          }
        });
        preparations.set(key, preparation);
      }
      const prepared = await preparation;
      assertCurrent();
      return {
        replay: prepared.replay,
        isCurrent: () => {
          assertCurrent();
          return prepared.isCurrent();
        },
      };
    },
  };
}
