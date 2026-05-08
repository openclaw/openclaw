import { randomUUID } from "node:crypto";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  executeCrestodianOperation,
  formatCrestodianPersistentPlan,
  isPersistentCrestodianOperation,
  parseCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import {
  createCrestodianRescuePendingStore,
  isRescuePendingOperation,
  resolveCrestodianRescuePendingKey,
  type RescuePendingOperation,
} from "./rescue-pending-state.js";
import { resolveCrestodianRescuePolicy } from "./rescue-policy.js";

export type CrestodianRescueMessageInput = {
  cfg: OpenClawConfig;
  command: CommandContext;
  commandBody: string;
  agentId?: string;
  isGroup: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: CrestodianCommandDeps;
};

const CRESTODIAN_COMMAND = "/crestodian";
const APPROVAL_RE = /^(yes|y|apply|approve|approved|do it)$/i;
const pendingStore = createCrestodianRescuePendingStore();

function createCaptureRuntime(): { runtime: RuntimeEnv; read: () => string } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  return {
    runtime: {
      log: push,
      error: push,
      exit: (code) => {
        throw new Error(`Crestodian operation exited with code ${code}`);
      },
    },
    read: () => lines.join("\n").trim(),
  };
}

export function extractCrestodianRescueMessage(commandBody: string): string | null {
  const normalized = commandBody.trim();
  const lower = normalized.toLowerCase();
  if (lower !== CRESTODIAN_COMMAND && !lower.startsWith(`${CRESTODIAN_COMMAND} `)) {
    return null;
  }
  return normalized.slice(CRESTODIAN_COMMAND.length).trim();
}

function resolvePendingKey(input: CrestodianRescueMessageInput): string {
  return resolveCrestodianRescuePendingKey({
    channel: input.command.channelId ?? input.command.channel,
    from: input.command.from,
    senderId: input.command.senderId,
  });
}

async function readPending(key: string, now = new Date()): Promise<RescuePendingOperation | null> {
  const parsed = await pendingStore.lookup(key);
  if (!isRescuePendingOperation(parsed)) {
    return null;
  }
  if (Date.parse(parsed.expiresAt) <= now.getTime()) {
    await pendingStore.delete(key);
    return null;
  }
  return parsed;
}

function buildAuditDetails(input: CrestodianRescueMessageInput): Record<string, unknown> {
  return {
    rescue: true,
    channel: input.command.channelId ?? input.command.channel,
    accountId: input.command.to,
    senderId: input.command.senderId,
    from: input.command.from,
  };
}

function formatPersistentPlan(operation: CrestodianOperation): string {
  return formatCrestodianPersistentPlan(operation).replace(
    "Say yes to apply.",
    "Reply /crestodian yes to apply.",
  );
}

function formatUnsupportedRemoteOperation(operation: CrestodianOperation): string | null {
  if (operation.kind === "open-tui") {
    return [
      "Crestodian rescue cannot open the local TUI from a message channel.",
      "Use local `openclaw` for agent handoff, or ask for status, doctor, config, gateway, agents, or models.",
    ].join(" ");
  }
  if (operation.kind === "plugin-install") {
    return [
      "Crestodian rescue cannot install plugins from a message channel by default because plugin install downloads executable code.",
      "Use local `openclaw crestodian` or `openclaw plugins install` instead.",
    ].join(" ");
  }
  return null;
}

export async function runCrestodianRescueMessage(
  input: CrestodianRescueMessageInput,
): Promise<string | null> {
  const rescueMessage = extractCrestodianRescueMessage(input.commandBody);
  if (rescueMessage === null) {
    return null;
  }
  const policy = resolveCrestodianRescuePolicy({
    cfg: input.cfg,
    agentId: input.agentId,
    senderIsOwner: input.command.senderIsOwner,
    isDirectMessage: !input.isGroup,
  });
  if (!policy.allowed) {
    return policy.message;
  }

  const pendingKey = resolvePendingKey(input);
  if (APPROVAL_RE.test(rescueMessage)) {
    const pending = await readPending(pendingKey);
    if (!pending) {
      return "No pending Crestodian rescue change is waiting for approval.";
    }
    const unsupported = formatUnsupportedRemoteOperation(pending.operation);
    if (unsupported) {
      await pendingStore.delete(pendingKey);
      return unsupported;
    }
    const capture = createCaptureRuntime();
    await executeCrestodianOperation(pending.operation, capture.runtime, {
      approved: true,
      auditDetails: pending.auditDetails,
      deps: input.deps,
    });
    await pendingStore.delete(pendingKey);
    return capture.read() || "Crestodian rescue change applied.";
  }

  const operation = parseCrestodianOperation(rescueMessage);
  const unsupported = formatUnsupportedRemoteOperation(operation);
  if (unsupported) {
    return unsupported;
  }
  if (isPersistentCrestodianOperation(operation)) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + policy.pendingTtlMinutes * 60_000);
    const pending = {
      id: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      operation,
      auditDetails: buildAuditDetails(input),
    } satisfies RescuePendingOperation;
    await pendingStore.register(pendingKey, pending, {
      ttlMs: Math.max(1, expiresAt.getTime() - now.getTime()),
    });
    return formatPersistentPlan(operation);
  }

  const capture = createCaptureRuntime();
  await executeCrestodianOperation(operation, capture.runtime, {
    approved: true,
    auditDetails: buildAuditDetails(input),
    deps: input.deps,
  });
  return capture.read() || "Crestodian listened, clicked a claw, and found nothing to change.";
}
