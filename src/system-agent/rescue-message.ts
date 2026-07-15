// OpenClaw rescue messages expose approved setup-helper commands over message channels.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJson, writeJson } from "../infra/json-files.js";
import type { RuntimeEnv } from "../runtime.js";
import { classifySystemAgentApprovalText } from "./approval-intent.js";
import {
  executeSystemAgentOperation,
  formatSystemAgentPersistentPlan,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
} from "./operations.js";
import { resolveSystemAgentRescuePolicy } from "./rescue-policy.js";

/**
 * Message-channel rescue command handling for OpenClaw.
 *
 * Rescue mode accepts `/openclaw` commands from approved message contexts,
 * stores pending persistent operations for explicit confirmation, and captures
 * command output without exposing local TUI or plugin-install flows remotely.
 */
type RescuePendingOperation = {
  id: string;
  createdAt: string;
  expiresAt: string;
  operation: SystemAgentOperation;
  auditDetails: Record<string, unknown>;
};

/** Input required to process one possible `/openclaw` rescue message. */
type SystemAgentRescueMessageInput = {
  cfg: OpenClawConfig;
  command: CommandContext;
  commandBody: string;
  agentId?: string;
  isGroup: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: SystemAgentCommandDeps;
};

const SYSTEM_AGENT_COMMAND = "/openclaw";

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
        throw new Error(`OpenClaw operation exited with code ${code}`);
      },
    },
    read: () => lines.join("\n").trim(),
  };
}

/** Extract the command body after `/openclaw`, or null when the message is not for rescue. */
export function extractSystemAgentRescueMessage(commandBody: string): string | null {
  const normalized = commandBody.trim();
  const lower = normalized.toLowerCase();
  if (lower !== SYSTEM_AGENT_COMMAND && !lower.startsWith(`${SYSTEM_AGENT_COMMAND} `)) {
    return null;
  }
  return normalized.slice(SYSTEM_AGENT_COMMAND.length).trim();
}

function resolvePendingDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "openclaw", "rescue-pending");
}

function resolvePendingPath(input: SystemAgentRescueMessageInput): string {
  // Pending approval is scoped by sender/channel identity so unrelated chats cannot approve it.
  const key = JSON.stringify({
    channel: input.command.channelId ?? input.command.channel,
    from: input.command.from,
    senderId: input.command.senderId,
  });
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(resolvePendingDir(input.env), `${digest}.json`);
}

async function readPending(
  pendingPath: string,
  now = new Date(),
): Promise<RescuePendingOperation | null> {
  try {
    const parsed = await tryReadJson<RescuePendingOperation>(pendingPath);
    if (!parsed) {
      return null;
    }
    const expiresAtMs = asDateTimestampMs(Date.parse(parsed.expiresAt));
    const nowMs = asDateTimestampMs(now.getTime());
    if (expiresAtMs === undefined || nowMs === undefined || expiresAtMs <= nowMs) {
      // Expired rescue approvals are deleted before returning so stale writes cannot linger.
      await fs.rm(pendingPath, { force: true });
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writePending(pendingPath: string, pending: RescuePendingOperation): Promise<void> {
  await writeJson(pendingPath, pending, {
    dirMode: 0o700,
    mode: 0o600,
    trailingNewline: true,
  });
}

function buildAuditDetails(input: SystemAgentRescueMessageInput): Record<string, unknown> {
  return {
    rescue: true,
    channel: input.command.channelId ?? input.command.channel,
    accountId: input.command.to,
    senderId: input.command.senderId,
    from: input.command.from,
  };
}

function formatPersistentPlan(operation: SystemAgentOperation): string {
  return formatSystemAgentPersistentPlan(operation).replace(
    "Say yes to apply.",
    "Reply /openclaw yes to apply.",
  );
}

function formatUnsupportedRemoteOperation(operation: SystemAgentOperation): string | null {
  if (operation.kind === "open-tui") {
    return [
      "OpenClaw rescue cannot open the local TUI from a message channel.",
      "Use local `openclaw` for agent handoff, or ask for status, doctor, config, gateway, agents, or models.",
    ].join(" ");
  }
  if (operation.kind === "channel-setup") {
    return [
      "OpenClaw rescue cannot host the interactive channel setup from a message channel.",
      "Run `openclaw setup` locally and say `connect " + operation.channel + "` instead.",
    ].join(" ");
  }
  if (operation.kind === "model-setup") {
    return [
      "OpenClaw rescue cannot host model-provider credential setup from a message channel.",
      "Run `openclaw onboard` locally; it live-tests the candidate route before saving it.",
    ].join(" ");
  }
  if (operation.kind === "plugin-install") {
    return [
      "OpenClaw rescue cannot install plugins from a message channel by default because plugin install downloads executable code.",
      "Use local `openclaw setup` or `openclaw plugins install` instead.",
    ].join(" ");
  }
  return null;
}

/** Process one rescue message and return a reply, or null when not a rescue command. */
export async function runSystemAgentRescueMessage(
  input: SystemAgentRescueMessageInput,
): Promise<string | null> {
  const rescueMessage = extractSystemAgentRescueMessage(input.commandBody);
  if (rescueMessage === null) {
    return null;
  }
  const policy = resolveSystemAgentRescuePolicy({
    cfg: input.cfg,
    agentId: input.agentId,
    senderIsOwner: input.command.senderIsOwner,
    isDirectMessage: !input.isGroup,
  });
  if (!policy.allowed) {
    return policy.message;
  }

  const pendingPath = resolvePendingPath(input);
  // Remote rescue never consults a model (a broken/compromised agent path must
  // not become a config editor); approval stays on the closed deterministic list.
  if (classifySystemAgentApprovalText(rescueMessage) === "approve") {
    const pending = await readPending(pendingPath);
    if (!pending) {
      return "No pending OpenClaw rescue change is waiting for approval.";
    }
    const unsupported = formatUnsupportedRemoteOperation(pending.operation);
    if (unsupported) {
      await fs.rm(pendingPath, { force: true });
      return unsupported;
    }
    const capture = createCaptureRuntime();
    await executeSystemAgentOperation(pending.operation, capture.runtime, {
      approved: true,
      auditDetails: pending.auditDetails,
      deps: input.deps,
    });
    await fs.rm(pendingPath, { force: true });
    return capture.read() || "OpenClaw rescue change applied.";
  }

  if (classifySystemAgentApprovalText(rescueMessage) === "decline") {
    const pending = await readPending(pendingPath);
    await fs.rm(pendingPath, { force: true });
    return pending
      ? "Dropped the pending OpenClaw rescue change."
      : "No pending OpenClaw rescue change is waiting for approval.";
  }

  const operation = parseSystemAgentOperation(rescueMessage);
  const unsupported = formatUnsupportedRemoteOperation(operation);
  if (unsupported) {
    return unsupported;
  }
  if (isPersistentSystemAgentOperation(operation)) {
    // Persistent remote operations are two-step: store the parsed operation, then require approval.
    const now = new Date();
    const nowMs = asDateTimestampMs(now.getTime());
    const expiresAtMs =
      nowMs === undefined
        ? undefined
        : resolveExpiresAtMsFromDurationMs(policy.pendingTtlMinutes * 60_000, { nowMs });
    if (expiresAtMs === undefined) {
      return "OpenClaw rescue could not create a pending approval because the expiry clock is invalid.";
    }
    await writePending(pendingPath, {
      id: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      operation,
      auditDetails: buildAuditDetails(input),
    });
    return formatPersistentPlan(operation);
  }

  const capture = createCaptureRuntime();
  await executeSystemAgentOperation(operation, capture.runtime, {
    approved: true,
    auditDetails: buildAuditDetails(input),
    deps: input.deps,
  });
  return capture.read() || "OpenClaw listened, clicked a claw, and found nothing to change.";
}
