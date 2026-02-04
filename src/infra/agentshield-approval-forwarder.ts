import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import type {
  AgentShieldApprovalDecision,
  AgentShieldApprovalRecord,
} from "../gateway/agentshield-approval-manager.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";

const log = createSubsystemLogger("gateway/agentshield-approvals");

export type AgentShieldApprovalRequest = Pick<
  AgentShieldApprovalRecord,
  "id" | "toolName" | "argsFingerprint" | "agentId" | "sessionKey" | "createdAtMs" | "expiresAtMs"
>;

export type AgentShieldApprovalResolved = {
  id: string;
  decision: AgentShieldApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
};

type PendingApproval = {
  request: AgentShieldApprovalRequest;
  targets: Array<ExecApprovalForwardTarget & { source: string }>;
  timeoutId: NodeJS.Timeout | null;
};

export type AgentShieldApprovalForwarder = {
  handleRequested: (request: AgentShieldApprovalRequest) => Promise<void>;
  handleResolved: (resolved: AgentShieldApprovalResolved) => Promise<void>;
  stop: () => void;
};

export type AgentShieldApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: typeof deliverOutboundPayloads;
  nowMs?: () => number;
};

function buildRequestMessage(request: AgentShieldApprovalRequest, nowMs: number): string {
  const lines: string[] = [
    "🛡️ AgentShield approval required",
    `ID: ${request.id}`,
    `Tool: ${request.toolName}`,
    `Fingerprint: ${request.argsFingerprint.slice(0, 16)}…`,
  ];
  if (request.agentId) {
    lines.push(`Agent: ${request.agentId}`);
  }
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push("Reply with: /agentshield-approve <id> allow-once|allow-always|deny");
  return lines.join("\n");
}

function decisionLabel(decision: AgentShieldApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

function buildResolvedMessage(resolved: AgentShieldApprovalResolved): string {
  const base = `✅ AgentShield approval ${decisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

function buildExpiredMessage(request: AgentShieldApprovalRequest): string {
  return `⏱️ AgentShield approval expired. Tool: ${request.toolName} ID: ${request.id}`;
}

export function createAgentShieldApprovalForwarder(
  deps: AgentShieldApprovalForwarderDeps = {},
): AgentShieldApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver = deps.deliver ?? deliverOutboundPayloads;
  const nowMs = deps.nowMs ?? Date.now;
  const pending = new Map<string, PendingApproval>();

  const handleRequested = async (request: AgentShieldApprovalRequest) => {
    const cfg = getConfig();
    const config = cfg.approvals?.agentshield;
    if (!config?.enabled) {
      return;
    }
    const targets: Array<ExecApprovalForwardTarget & { source: string }> = [];
    for (const target of config.targets ?? []) {
      targets.push({ ...target, source: "target" });
    }
    if (targets.length === 0) {
      return;
    }

    const expiresInMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(request.id);
        if (!entry) {
          return;
        }
        pending.delete(request.id);
        const text = buildExpiredMessage(request);
        await deliverToTargets({ cfg, targets: entry.targets, text, deliver });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = { request, targets, timeoutId };
    pending.set(request.id, pendingEntry);

    const text = buildRequestMessage(request, nowMs());
    await deliverToTargets({ cfg, targets, text, deliver });
  };

  const handleResolved = async (resolved: AgentShieldApprovalResolved) => {
    const entry = pending.get(resolved.id);
    if (!entry) {
      return;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    pending.delete(resolved.id);
    const cfg = getConfig();
    const text = buildResolvedMessage(resolved);
    await deliverToTargets({ cfg, targets: entry.targets, text, deliver });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    }
    pending.clear();
  };

  return { handleRequested, handleResolved, stop };
}

async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: Array<ExecApprovalForwardTarget & { source: string }>;
  text: string;
  deliver: typeof deliverOutboundPayloads;
}) {
  const deliveries = params.targets.map(async (target) => {
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text: params.text }],
      });
    } catch (err) {
      log.error(`agentshield approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
}
