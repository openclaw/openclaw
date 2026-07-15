import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import type { SessionEntry } from "./types.js";

const MAX_TERMINAL_RUN_IDS = 64;

export type RestartRecoveryChannelAuthority = {
  deliveryContext: DeliveryContext & { channel: string; to: string };
  sourceTurnId: string;
};

function normalizeRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolves only a complete durable channel claim; session-route fallbacks carry no authority. */
export function resolveRestartRecoveryChannelAuthority(
  entry: SessionEntry,
): RestartRecoveryChannelAuthority | undefined {
  const sourceTurnId = normalizeRunId(entry.restartRecoveryDeliverySourceRunId);
  const deliveryContext = normalizeDeliveryContext(entry.restartRecoveryDeliveryContext);
  const channel = normalizeRunId(deliveryContext?.channel);
  const to = normalizeRunId(deliveryContext?.to);
  if (
    entry.restartRecoverySourceIngress !== "channel" ||
    !sourceTurnId ||
    !channel ||
    !to ||
    !isDeliverableMessageChannel(channel)
  ) {
    return undefined;
  }
  return {
    sourceTurnId,
    deliveryContext: { ...deliveryContext, channel, to },
  };
}

/** Keeps a bounded durable set of client runs that must never execute again. */
function normalizeRestartRecoveryTerminalRunIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const runIds: string[] = [];
  for (const item of value) {
    const runId = normalizeRunId(item);
    if (!runId) {
      continue;
    }
    const previousIndex = runIds.indexOf(runId);
    if (previousIndex >= 0) {
      runIds.splice(previousIndex, 1);
    }
    runIds.push(runId);
  }
  const bounded = runIds.slice(-MAX_TERMINAL_RUN_IDS);
  return bounded.length > 0 ? bounded : undefined;
}

type RestartRecoveryNormalizedField =
  | "restartRecoveryBeforeAgentReplyState"
  | "restartRecoveryDeliveryReceiptState"
  | "restartRecoveryDeliveryRequestFingerprint"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryRequesterAccountId"
  | "restartRecoveryRequesterSenderId"
  | "restartRecoverySameChannelThreadRequired"
  | "restartRecoverySourceIngress"
  | "restartRecoverySourceReplyDeliveryMode"
  | "restartRecoveryTerminalRunIds";

function sameOptionalStringArray(left: unknown, right: string[] | undefined): boolean {
  if (!Array.isArray(left) || !right) {
    return left === undefined && right === undefined;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Normalizes restart-claim fields while preserving an already-canonical array identity. */
export function normalizeRestartRecoveryEntryFields(
  entry: SessionEntry,
  assign: <K extends RestartRecoveryNormalizedField>(
    key: K,
    value: SessionEntry[K] | undefined,
  ) => void,
): void {
  assign(
    "restartRecoveryBeforeAgentReplyState",
    entry.restartRecoveryBeforeAgentReplyState === "pending" ||
      entry.restartRecoveryBeforeAgentReplyState === "continue" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-silent" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable"
      ? entry.restartRecoveryBeforeAgentReplyState
      : undefined,
  );
  assign(
    "restartRecoveryDeliveryReceiptState",
    entry.restartRecoveryDeliveryReceiptState === "unrecorded-terminal"
      ? "unrecorded-terminal"
      : undefined,
  );
  assign(
    "restartRecoveryDeliveryRequestFingerprint",
    normalizeRunId(entry.restartRecoveryDeliveryRequestFingerprint),
  );
  assign("restartRecoveryDeliveryRunId", normalizeRunId(entry.restartRecoveryDeliveryRunId));
  assign(
    "restartRecoveryDeliverySourceRunId",
    normalizeRunId(entry.restartRecoveryDeliverySourceRunId),
  );
  assign(
    "restartRecoveryRequesterAccountId",
    normalizeRunId(entry.restartRecoveryRequesterAccountId),
  );
  assign(
    "restartRecoveryRequesterSenderId",
    normalizeRunId(entry.restartRecoveryRequesterSenderId),
  );
  assign(
    "restartRecoverySameChannelThreadRequired",
    entry.restartRecoverySameChannelThreadRequired === true ? true : undefined,
  );
  assign(
    "restartRecoverySourceIngress",
    entry.restartRecoverySourceIngress === "channel" ? "channel" : undefined,
  );
  assign(
    "restartRecoverySourceReplyDeliveryMode",
    entry.restartRecoverySourceReplyDeliveryMode === "automatic" ||
      entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only"
      ? entry.restartRecoverySourceReplyDeliveryMode
      : undefined,
  );
  const terminalRunIds = normalizeRestartRecoveryTerminalRunIds(
    entry.restartRecoveryTerminalRunIds,
  );
  assign(
    "restartRecoveryTerminalRunIds",
    sameOptionalStringArray(entry.restartRecoveryTerminalRunIds, terminalRunIds)
      ? entry.restartRecoveryTerminalRunIds
      : terminalRunIds,
  );
}

/** Appends new terminal ids without refreshing or evicting existing members. */
export function mergeRestartRecoveryTerminalRunIds(
  current: unknown,
  appended: unknown,
): string[] | undefined {
  const currentRunIds = normalizeRestartRecoveryTerminalRunIds(current) ?? [];
  const currentSet = new Set(currentRunIds);
  const appendedRunIds = (normalizeRestartRecoveryTerminalRunIds(appended) ?? []).filter(
    (runId) => !currentSet.has(runId),
  );
  return normalizeRestartRecoveryTerminalRunIds([...currentRunIds, ...appendedRunIds]);
}

export function hasRestartRecoveryTerminalRun(
  entry: SessionEntry | undefined,
  runId: string,
): boolean {
  return (
    normalizeRestartRecoveryTerminalRunIds(entry?.restartRecoveryTerminalRunIds)?.includes(
      runId,
    ) === true
  );
}

/** Clears exact active ownership and optionally records its client source as terminal. */
export function buildRestartRecoveryClaimCleanupPatch(params: {
  entry: SessionEntry;
  recordTerminalSource: boolean;
  terminalSourceRunId?: string;
}): Partial<SessionEntry> {
  const sourceRunId =
    normalizeRunId(params.terminalSourceRunId) ??
    normalizeRunId(params.entry.restartRecoveryDeliverySourceRunId);
  const terminalRunIds =
    params.recordTerminalSource && sourceRunId
      ? mergeRestartRecoveryTerminalRunIds(params.entry.restartRecoveryTerminalRunIds, [
          sourceRunId,
        ])
      : undefined;
  return {
    restartRecoveryBeforeAgentReplyState: undefined,
    restartRecoveryDeliveryReceiptState: undefined,
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    restartRecoveryRequesterAccountId: undefined,
    restartRecoveryRequesterSenderId: undefined,
    restartRecoverySameChannelThreadRequired: undefined,
    restartRecoverySourceIngress: undefined,
    restartRecoverySourceReplyDeliveryMode: undefined,
    ...(terminalRunIds ? { restartRecoveryTerminalRunIds: terminalRunIds } : {}),
  };
}
