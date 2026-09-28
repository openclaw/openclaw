import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { ExecApprovalDurableLookup } from "../exec-approval-manager.types.js";
import {
  canAccessOperatorApproval,
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import {
  getOperatorApprovalDetailed,
  isOperatorApprovalStoreRefusal,
  isOperatorApprovalStoreOutcomeUnknown,
} from "../operator-approval-store.js";
import type {
  OperatorApprovalRecord,
  OperatorApprovalStoreGuard,
} from "../operator-approval-store.types.js";
import { canAccessApprovalSession } from "./approval-record-lookup.js";
import type { ApprovalRequestAuthority } from "./approval-request-authority.js";
import type { GatewayClient } from "./types.js";

type PreparedVisibleApproval = {
  readCurrent: () => OperatorApprovalRecord | null;
  guard: OperatorApprovalStoreGuard;
};

export async function loadVisibleApproval(params: {
  id: string;
  authority: ApprovalRequestAuthority;
  client: GatewayClient | null;
  getCfg: () => OpenClawConfig;
  allowApprovalRuntime?: boolean;
  allowTransportRef?: boolean;
  execApprovalManager: ExecApprovalManager;
  pluginApprovalManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  systemAgentApprovalManager?: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): Promise<PreparedVisibleApproval | null> {
  // Reconciliation can settle a live waiter, so authorization must precede
  // every durable read and no unauthorized lookup may reach the bridge.
  const authorized = params.allowApprovalRuntime
    ? canResolveOperatorApproval(params.client)
    : canReviewOperatorApproval(params.client);
  if (!params.authority.isCurrent() || !authorized || params.client?.invalidated) {
    return null;
  }
  const liveRecord =
    params.execApprovalManager.getLiveSnapshot(params.id) ??
    params.pluginApprovalManager.getLiveSnapshot(params.id) ??
    params.systemAgentApprovalManager?.getLiveSnapshot(params.id);
  if (
    liveRecord &&
    !canAccessApprovalSession({
      cfg: params.getCfg(),
      client: params.client,
      sessionKey: liveRecord.request.sessionKey,
      agentId: liveRecord.request.agentId,
    })
  ) {
    return null;
  }
  if (
    liveRecord &&
    !canAccessOperatorApproval({
      client: params.client,
      allowApprovalRuntime: params.allowApprovalRuntime,
      binding: { reviewerDeviceIds: liveRecord.approvalReviewerDeviceIds },
    })
  ) {
    return null;
  }
  let bindingId = params.id;
  let admittedRecord = liveRecord?.resolvedAtMs === undefined ? liveRecord : undefined;
  let admittedManager = admittedRecord
    ? [
        params.execApprovalManager,
        params.pluginApprovalManager,
        params.systemAgentApprovalManager,
      ].find((manager) => manager?.getLocalSnapshot(params.id) === admittedRecord)
    : undefined;
  let sourceSessionKey = admittedRecord?.request.sessionKey;
  let sourceAgentId = admittedRecord?.request.agentId;
  const assertBindingCurrent = () => {
    if (
      admittedRecord &&
      (admittedManager?.getLocalSnapshot(bindingId) !== admittedRecord ||
        admittedRecord.request.sessionKey !== sourceSessionKey ||
        admittedRecord.request.agentId !== sourceAgentId ||
        !canAccessOperatorApproval({
          client: params.client,
          allowApprovalRuntime: params.allowApprovalRuntime,
          binding: { reviewerDeviceIds: admittedRecord.approvalReviewerDeviceIds },
        }))
    ) {
      throw new Error("Approval lookup authority is no longer active");
    }
  };
  const lookupAuthority = {
    assertCurrent: () => {
      params.authority.assertCurrent();
      assertBindingCurrent();
    },
    guard: {
      family: params.authority.guard.family,
      assertCurrent: () => {
        params.authority.assertCommitCurrent();
        assertBindingCurrent();
      },
    },
  };
  const isLookupCurrent = () => {
    try {
      lookupAuthority.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const reconcile = async (
    manager:
      | typeof params.execApprovalManager
      | typeof params.pluginApprovalManager
      | typeof params.systemAgentApprovalManager,
    value: ExecApprovalDurableLookup,
  ) => {
    try {
      return await manager?.reconcileDurableLookup(value, null, lookupAuthority);
    } catch (error) {
      if (!isLookupCurrent()) {
        return null;
      }
      throw error;
    }
  };
  let lookup: Awaited<ReturnType<typeof getOperatorApprovalDetailed>>;
  try {
    lookup = await getOperatorApprovalDetailed({
      id: params.id,
      allowTransportRef: params.allowTransportRef,
      databaseOptions: params.databaseOptions,
      guard: lookupAuthority.guard,
    });
  } catch (error) {
    if (!isLookupCurrent()) {
      return null;
    }
    if (isOperatorApprovalStoreRefusal(error) || isOperatorApprovalStoreOutcomeUnknown(error)) {
      throw error;
    }
    const corrupt = { outcome: "corrupt", id: params.id } as const;
    await reconcile(params.execApprovalManager, corrupt);
    await reconcile(params.pluginApprovalManager, corrupt);
    await reconcile(params.systemAgentApprovalManager, corrupt);
    throw error;
  }
  if (
    !isLookupCurrent() ||
    params.client?.invalidated ||
    !(params.allowApprovalRuntime
      ? canResolveOperatorApproval(params.client)
      : canReviewOperatorApproval(params.client))
  ) {
    return null;
  }
  if (lookup.outcome === "found") {
    if (
      !canAccessApprovalSession({
        cfg: params.getCfg(),
        client: params.client,
        sessionKey: lookup.record.source.sessionKey,
        agentId: lookup.record.source.agentId,
      })
    ) {
      return null;
    }
    if (
      !canAccessOperatorApproval({
        client: params.client,
        allowApprovalRuntime: params.allowApprovalRuntime,
        binding: { reviewerDeviceIds: lookup.record.reviewerDeviceIds },
      })
    ) {
      return null;
    }
    const manager =
      lookup.record.kind === "exec"
        ? params.execApprovalManager
        : lookup.record.kind === "plugin"
          ? params.pluginApprovalManager
          : params.systemAgentApprovalManager;
    // Durable truth can advance outside this manager. Settle only an existing
    // same-kind waiter; reconcileDurableLookup never recreates executable state.
    if (lookup.record.status === "pending") {
      const current = manager?.getLocalSnapshot(lookup.record.id);
      if (current) {
        if (
          (normalizeOptionalString(current.request.sessionKey) ?? null) !==
            lookup.record.source.sessionKey ||
          (normalizeOptionalString(current.request.agentId) ?? null) !==
            lookup.record.source.agentId ||
          !canAccessOperatorApproval({
            client: params.client,
            allowApprovalRuntime: params.allowApprovalRuntime,
            binding: { reviewerDeviceIds: current.approvalReviewerDeviceIds },
          })
        ) {
          return null;
        }
        // Transport refs become a canonical live binding only after the store resolves them.
        if (!admittedRecord) {
          bindingId = lookup.record.id;
          admittedRecord = current;
          admittedManager = manager;
          sourceSessionKey = current.request.sessionKey;
          sourceAgentId = current.request.agentId;
        }
      }
    }
    const reconciled = await reconcile(manager, lookup);
    if (!reconciled) {
      return null;
    }
    return {
      guard: lookupAuthority.guard,
      readCurrent: () =>
        params.authority.isCurrent() &&
        (reconciled.status !== "pending" || isLookupCurrent()) &&
        !params.client?.invalidated &&
        canAccessApprovalSession({
          cfg: params.getCfg(),
          client: params.client,
          sessionKey: reconciled.source.sessionKey,
          agentId: reconciled.source.agentId,
        }) &&
        canAccessOperatorApproval({
          client: params.client,
          allowApprovalRuntime: params.allowApprovalRuntime,
          binding: { reviewerDeviceIds: reconciled.reviewerDeviceIds },
        })
          ? reconciled
          : null,
    };
  }
  const missing = {
    outcome: lookup.outcome === "corrupt" ? "corrupt" : "missing",
    id: lookup.outcome === "corrupt" ? (lookup.id ?? params.id) : params.id,
  } as const;
  await reconcile(params.execApprovalManager, missing);
  await reconcile(params.pluginApprovalManager, missing);
  await reconcile(params.systemAgentApprovalManager, missing);
  return null;
}
