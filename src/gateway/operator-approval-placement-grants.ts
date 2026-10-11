// Process-local grants retain their durable parent and exact placement authority.
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readPlacementGrantRows,
  type PlacementGrantReadInput,
  type PlacementGrantRows,
} from "./operator-approval-placement-grants.read.js";
import { readPlacementStandingGrant } from "./operator-approval-store.js";
import { fromRow } from "./worker-environments/placement-row-codec.js";

const PLACEMENT_GRANT_TTL_MS = 30 * 24 * 60 * 60_000;
export type PlacementStandingGrantMintSpec = NonNullable<
  PluginApprovalRequestPayload["placementGrant"]
>;
type PlacementStandingGrantRecord = PlacementStandingGrantMintSpec & {
  mintedByApprovalId: string;
  expiresAtMs: number;
};
type ConsumePlacementStandingGrantResult =
  | { outcome: "consumed"; grant: PlacementStandingGrantRecord }
  | {
      outcome:
        | "no-grant"
        | "expired"
        | "approval-missing"
        | "approval-not-allow-always"
        | "placement-missing"
        | "placement-changed"
        | "node-changed"
        | "pairing-changed";
    };
type PlacementGrantResolutionInput = Pick<
  PlacementStandingGrantMintSpec,
  | "pluginId"
  | "command"
  | "approvalScope"
  | "agentId"
  | "sessionKey"
  | "nodeId"
  | "pairingGeneration"
>;
type RetainPlacementGrantInput = PlacementStandingGrantMintSpec & {
  approvalId: string;
  nowMs: number;
  expiresAtMs: number | null;
};
export type PlacementStandingGrantRuntime = {
  /** @deprecated Released SDK compatibility; use resolveBindingAsync. */
  resolveBinding: (input: PlacementGrantResolutionInput) => PlacementStandingGrantMintSpec | null;
  /** @deprecated Released SDK compatibility; use retainAsync. */
  retain: (grant: RetainPlacementGrantInput) => boolean;
  /** @deprecated Released SDK compatibility; use validateAsync. */
  validate: (binding: PlacementStandingGrantMintSpec) => ConsumePlacementStandingGrantResult;
  /** Synchronous final transport guard; also retained for released SDK callers. */
  consume: (binding: PlacementStandingGrantMintSpec) => ConsumePlacementStandingGrantResult;
  resolveBindingAsync?: (
    input: PlacementGrantResolutionInput,
  ) => Promise<PlacementStandingGrantMintSpec | null>;
  resolveAsync?: (input: PlacementGrantResolutionInput) => Promise<{
    binding: PlacementStandingGrantMintSpec | null;
    approvalId?: string;
  }>;
  retainAsync?: (grant: RetainPlacementGrantInput) => Promise<boolean>;
  validateAsync?: (
    binding: PlacementStandingGrantMintSpec,
  ) => Promise<ConsumePlacementStandingGrantResult>;
};

function validResolutionInput(input: PlacementGrantResolutionInput): boolean {
  return [
    input.pluginId,
    input.command,
    input.approvalScope,
    input.agentId,
    input.sessionKey,
    input.nodeId,
    input.pairingGeneration,
  ].every((value) => value.trim());
}

function resolveBinding(
  input: PlacementGrantResolutionInput,
  rows: PlacementGrantRows,
): PlacementStandingGrantMintSpec | null {
  if (rows.length !== 1) {
    return null;
  }
  const row = rows[0]!;
  fromRow(row);
  const attached = safeParseJson(row.attached_session_ids_json ?? "null");
  if (
    row.agent_id !== input.agentId ||
    row.session_key !== input.sessionKey ||
    row.state !== "active" ||
    row.execution_mode !== "remote-exec" ||
    !row.environment_id ||
    !row.active_owner_epoch ||
    !row.remote_workspace_dir ||
    row.environment_state !== "attached" ||
    row.node_device_id !== input.nodeId ||
    row.owner_epoch !== row.active_owner_epoch ||
    !Array.isArray(attached) ||
    attached.length !== 1 ||
    attached[0] !== row.session_id
  ) {
    return null;
  }
  return {
    pluginId: input.pluginId,
    command: input.command,
    approvalScope: input.approvalScope,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    nodeId: input.nodeId,
    pairingGeneration: input.pairingGeneration,
    sessionId: row.session_id,
    environmentId: row.environment_id,
    ownerEpoch: row.active_owner_epoch,
    placementGeneration: row.transition_generation,
    cwd: row.remote_workspace_dir,
  };
}

function placementGrantKey(binding: PlacementStandingGrantMintSpec): string {
  return JSON.stringify([
    binding.pluginId,
    binding.command,
    binding.approvalScope,
    binding.agentId,
    binding.sessionId,
  ]);
}

function matchesGrantOperation(
  candidate: PlacementStandingGrantMintSpec,
  input: PlacementGrantResolutionInput,
): boolean {
  return (
    candidate.pluginId === input.pluginId &&
    candidate.command === input.command &&
    candidate.approvalScope === input.approvalScope &&
    candidate.agentId === input.agentId &&
    candidate.sessionKey === input.sessionKey
  );
}

function samePlacement(
  left: PlacementStandingGrantMintSpec,
  right: PlacementStandingGrantMintSpec,
): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.sessionId === right.sessionId &&
    left.environmentId === right.environmentId &&
    left.ownerEpoch === right.ownerEpoch &&
    left.placementGeneration === right.placementGeneration &&
    left.cwd === right.cwd
  );
}

function prepareRetainedGrant(
  input: RetainPlacementGrantInput,
): PlacementStandingGrantRecord | null {
  const expiresAtMs = Math.min(input.expiresAtMs ?? Infinity, input.nowMs + PLACEMENT_GRANT_TTL_MS);
  if (expiresAtMs <= input.nowMs) {
    return null;
  }
  const { approvalId, nowMs: _nowMs, expiresAtMs: _expiresAtMs, ...binding } = input;
  return { ...binding, mintedByApprovalId: approvalId, expiresAtMs };
}

export function createPlacementStandingGrantRuntime(params: {
  runtimeEpoch: string;
  databaseOptions?: OpenClawStateDatabaseOptions;
  now?: () => number;
}): Required<PlacementStandingGrantRuntime> {
  const grants = new Map<string, PlacementStandingGrantRecord>();
  const now = params.now ?? Date.now;
  const read = (input: PlacementGrantReadInput) =>
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      (database) => readPlacementGrantRows(database.db, input),
      { ...params.databaseOptions, allowNativeRead: true },
    ) ?? [];
  const readAsync = (input: PlacementGrantReadInput) =>
    readPlacementStandingGrant(input, {
      databaseOptions: params.databaseOptions,
    });
  const checkLocal = (
    binding: PlacementStandingGrantMintSpec,
  ): ConsumePlacementStandingGrantResult => {
    const key = placementGrantKey(binding);
    const grant = grants.get(key);
    if (!grant) {
      return { outcome: "no-grant" };
    }
    const outcome =
      grant.expiresAtMs <= now()
        ? "expired"
        : grant.nodeId !== binding.nodeId
          ? "node-changed"
          : grant.pairingGeneration !== binding.pairingGeneration
            ? "pairing-changed"
            : undefined;
    if (outcome) {
      grants.delete(key);
      return { outcome };
    }
    return { outcome: "consumed", grant };
  };
  const checkRows = (
    binding: PlacementStandingGrantMintSpec,
    grant: PlacementStandingGrantRecord,
    rows: PlacementGrantRows,
    invalidate = true,
  ): ConsumePlacementStandingGrantResult => {
    const current = resolveBinding(binding, rows);
    const row = rows[0];
    const outcome =
      !current || !samePlacement(current, binding) || !samePlacement(grant, binding)
        ? row
          ? "placement-changed"
          : "placement-missing"
        : !row?.approval_id
          ? "approval-missing"
          : row.runtime_epoch !== params.runtimeEpoch ||
              row.approval_status !== "allowed" ||
              row.decision !== "allow-always"
            ? "approval-not-allow-always"
            : undefined;
    if (outcome) {
      if (invalidate) {
        grants.delete(placementGrantKey(binding));
      }
      return { outcome };
    }
    return { outcome: "consumed", grant };
  };
  const resolve = (binding: PlacementStandingGrantMintSpec) => {
    const result = checkLocal(binding);
    return result.outcome === "consumed"
      ? checkRows(
          binding,
          result.grant,
          read({
            ...binding,
            approvalId: result.grant.mintedByApprovalId,
          }),
        )
      : result;
  };
  const validateAsync = async (input: PlacementStandingGrantMintSpec) => {
    const binding = { ...input };
    const before = checkLocal(binding);
    if (before.outcome !== "consumed") {
      return before;
    }
    const rows = await readAsync({ ...binding, approvalId: before.grant.mintedByApprovalId });
    const current = checkLocal(binding);
    if (current.outcome !== "consumed") {
      return current;
    }
    if (current.grant !== before.grant) {
      return { outcome: "no-grant" } as const;
    }
    return checkRows(binding, current.grant, rows);
  };
  const retain = (grant: PlacementStandingGrantRecord, rows: PlacementGrantRows): boolean => {
    if (checkRows(grant, grant, rows, false).outcome !== "consumed") {
      return false;
    }
    grants.set(placementGrantKey(grant), grant);
    return true;
  };
  return {
    resolveBinding: (input) =>
      validResolutionInput(input) ? resolveBinding(input, read(input)) : null,
    resolveBindingAsync: async (input) => {
      const captured = { ...input };
      return validResolutionInput(captured)
        ? resolveBinding(captured, await readAsync(captured))
        : null;
    },
    resolveAsync: async (value) => {
      const input = { ...value };
      if (!validResolutionInput(input)) {
        return { binding: null };
      }
      // Capture every session's retained parent; the current placement selects one in the snapshot.
      const candidates = new Map(
        [...grants.values()]
          .filter((candidate) => matchesGrantOperation(candidate, input))
          .map((grant) => [grant.sessionId, grant]),
      );
      const rows = await readAsync({
        ...input,
        approvalIdsBySessionId: Object.fromEntries(
          [...candidates].map(([sessionId, grant]) => [sessionId, grant.mintedByApprovalId]),
        ),
      });
      const binding = resolveBinding(input, rows);
      const grant = binding ? candidates.get(binding.sessionId) : undefined;
      if (!binding || !grant) {
        return { binding };
      }
      const local = checkLocal(binding);
      const valid =
        local.outcome === "consumed" &&
        local.grant === grant &&
        checkRows(binding, grant, rows).outcome === "consumed";
      return { binding, ...(valid ? { approvalId: grant.mintedByApprovalId } : {}) };
    },
    retain: (input) => {
      const grant = prepareRetainedGrant(input);
      if (!grant) {
        return false;
      }
      try {
        return retain(grant, read({ ...grant, approvalId: grant.mintedByApprovalId }));
      } catch {
        return false;
      }
    },
    retainAsync: async (input) => {
      const grant = prepareRetainedGrant(input);
      if (!grant) {
        return false;
      }
      try {
        return retain(grant, await readAsync({ ...grant, approvalId: grant.mintedByApprovalId }));
      } catch {
        return false;
      }
    },
    validate: resolve,
    validateAsync,
    // SDK/native writers can revoke the parent or placement outside owner publications.
    // The synchronous transport callback must reread those rows immediately before send.
    consume: resolve,
  };
}
