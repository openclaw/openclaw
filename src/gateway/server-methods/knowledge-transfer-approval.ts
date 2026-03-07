import type {
  KnowledgeTransferApprovalKind,
  KnowledgeTransferApprovalDecision,
  KnowledgeTransferApprovalManager,
} from "../knowledge-transfer-approval-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MIN_APPROVAL_TIMEOUT_MS = 1_000;
const MAX_APPROVAL_TIMEOUT_MS = 3_600_000;

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalNonEmptyString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return parseNonEmptyString(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const values = value
    .map((entry) => parseNonEmptyString(entry))
    .filter((entry): entry is string => typeof entry === "string");
  return values;
}

function clampTimeoutMs(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (!numeric) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  return Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.min(MAX_APPROVAL_TIMEOUT_MS, numeric));
}

function hasApprovalClients(
  context: { hasExecApprovalClients?: (opts?: { excludeConnId?: string | null }) => boolean },
  requesterConnId?: string | null,
): boolean {
  if (typeof context.hasExecApprovalClients === "function") {
    return context.hasExecApprovalClients({ excludeConnId: requesterConnId ?? undefined });
  }
  return false;
}

function parseDecision(value: unknown): KnowledgeTransferApprovalDecision | null {
  const parsed = parseNonEmptyString(value)?.toLowerCase();
  if (parsed === "allow" || parsed === "deny") {
    return parsed;
  }
  return null;
}

function parseApprovalKind(value: unknown): KnowledgeTransferApprovalKind | null {
  const parsed = parseNonEmptyString(value)?.toLowerCase();
  if (parsed === "export" || parsed === "import") {
    return parsed;
  }
  return null;
}

export function createKnowledgeTransferApprovalHandlers(
  manager: KnowledgeTransferApprovalManager,
): GatewayRequestHandlers {
  return {
    "knowledge.transfer.approval.request": async ({ params, respond, context, client }) => {
      const record = params;
      const requesterAgentId = parseNonEmptyString(record.requesterAgentId);
      const targetAgentId = parseNonEmptyString(record.targetAgentId);
      const approvalKind = parseApprovalKind(record.approvalKind);
      const requesterSessionKey = parseNonEmptyString(record.requesterSessionKey);
      const targetSessionKey = parseNonEmptyString(record.targetSessionKey);
      const mode = parseNonEmptyString(record.mode);
      const itemCountRaw =
        typeof record.itemCount === "number" && Number.isFinite(record.itemCount)
          ? Math.max(0, Math.floor(record.itemCount))
          : null;
      const itemFingerprints = parseStringArray(record.itemFingerprints);
      const summary = parseStringArray(record.summary);
      const explicitId = parseOptionalNonEmptyString(record.id);
      const timeoutMs = clampTimeoutMs(record.timeoutMs);
      const twoPhase = record.twoPhase === true;

      if (
        !requesterAgentId ||
        !targetAgentId ||
        !approvalKind ||
        !requesterSessionKey ||
        !targetSessionKey ||
        mode !== "ask" ||
        itemCountRaw == null ||
        !itemFingerprints ||
        !summary
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid knowledge.transfer.approval.request params",
          ),
        );
        return;
      }

      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }

      const request = {
        approvalKind,
        requesterAgentId,
        targetAgentId,
        requesterSessionKey,
        targetSessionKey,
        requestedBySessionKey: parseOptionalNonEmptyString(record.requestedBySessionKey),
        requestedByChannel: parseOptionalNonEmptyString(record.requestedByChannel),
        mode: "ask" as const,
        itemCount: itemCountRaw,
        itemFingerprints,
        summary,
      };

      const approvalRecord = manager.create(request, timeoutMs, explicitId);
      approvalRecord.requestedByConnId = client?.connId ?? null;
      approvalRecord.requestedByDeviceId = client?.connect?.device?.id ?? null;
      approvalRecord.requestedByClientId = client?.connect?.client?.id ?? null;

      let decisionPromise: Promise<KnowledgeTransferApprovalDecision | null>;
      try {
        decisionPromise = manager.register(approvalRecord, timeoutMs);
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`),
        );
        return;
      }

      context.broadcast(
        "knowledge.transfer.approval.pending",
        {
          id: approvalRecord.id,
          request: approvalRecord.request,
          createdAtMs: approvalRecord.createdAtMs,
          expiresAtMs: approvalRecord.expiresAtMs,
        },
        { dropIfSlow: true },
      );

      if (!hasApprovalClients(context, client?.connId ?? null)) {
        manager.expire(approvalRecord.id, "auto-expire:no-approver-clients");
      }

      if (twoPhase) {
        respond(
          true,
          {
            status: "accepted",
            id: approvalRecord.id,
            createdAtMs: approvalRecord.createdAtMs,
            expiresAtMs: approvalRecord.expiresAtMs,
          },
          undefined,
        );
        return;
      }

      const decision = await decisionPromise;
      respond(
        true,
        {
          id: approvalRecord.id,
          decision,
          createdAtMs: approvalRecord.createdAtMs,
          expiresAtMs: approvalRecord.expiresAtMs,
        },
        undefined,
      );
    },

    "knowledge.transfer.approval.wait": async ({ params, respond }) => {
      const record = params;
      const id = parseNonEmptyString(record.id);
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }

      const decisionPromise = manager.awaitDecision(id);
      if (!decisionPromise) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
        );
        return;
      }

      const snapshot = manager.getSnapshot(id);
      const decision = await decisionPromise;
      respond(
        true,
        {
          id,
          decision,
          createdAtMs: snapshot?.createdAtMs,
          expiresAtMs: snapshot?.expiresAtMs,
        },
        undefined,
      );
    },

    "knowledge.transfer.approval.resolve": async ({ params, respond, client, context }) => {
      const record = params;
      const id = parseNonEmptyString(record.id);
      const decision = parseDecision(record.decision);
      if (!id || !decision) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid knowledge.transfer.approval.resolve params",
          ),
        );
        return;
      }

      const snapshot = manager.getSnapshot(id);
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(id, decision, resolvedBy ?? null);
      if (!ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }

      context.broadcast(
        "knowledge.transfer.approval.resolved",
        {
          id,
          decision,
          resolvedBy,
          ts: Date.now(),
          request: snapshot?.request,
        },
        { dropIfSlow: true },
      );

      respond(true, { ok: true }, undefined);
    },
  };
}
