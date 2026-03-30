import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

type ApprovalRequestWithSessionTarget = {
  request: {
    sessionKey?: string | null;
    agentId?: string | null;
  };
};

export type ExecApprovalSessionTarget = {
  channel?: string;
  to: string;
  accountId?: string;
  threadId?: number;
};

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalThreadId(value?: string | number | null): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = Number.parseInt(value, 10);
  return Number.isFinite(normalized) ? normalized : undefined;
}

export function resolveExecApprovalSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestWithSessionTarget;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}): ExecApprovalSessionTarget | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }

  const target = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: "last",
    turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
    turnSourceTo: normalizeOptionalString(params.turnSourceTo),
    turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
    turnSourceThreadId: normalizeOptionalThreadId(params.turnSourceThreadId),
  });
  if (!target.to) {
    return null;
  }

  return {
    channel: normalizeOptionalString(target.channel),
    to: target.to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: normalizeOptionalThreadId(target.threadId),
  };
}
