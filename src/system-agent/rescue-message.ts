// OpenClaw rescue messages expose approved setup-helper commands over message channels.
import { createHash } from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { hasNonEmptyString as isNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { listAgentRoles } from "../agents/agent-roles.js";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  executeSystemAgentOperation,
  formatSystemAgentPersistentPlan,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
} from "./operations.js";
import { classifySystemAgentApprovalText } from "./operator-approval.js";
import { resolveSystemAgentRescuePolicy } from "./rescue-policy.js";

/**
 * Message-channel rescue command handling for OpenClaw.
 *
 * Rescue mode accepts `/openclaw` commands from approved message contexts,
 * stores pending persistent operations for explicit confirmation, and captures
 * command output without exposing local TUI or plugin-install flows remotely.
 */
type RescuePendingOperation = {
  version: 1;
  operation: SystemAgentOperation;
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
const RESCUE_PENDING_NAMESPACE = "rescue-pending";
const RESCUE_PENDING_MAX_ENTRIES = 1_024;
const RESCUE_PENDING_TTL_MS = 15 * 60_000;
const RESCUE_OPERATION_FIELDS = new Map<
  string,
  { required?: readonly string[]; optional?: readonly string[] }
>([
  ["set-default-model", { required: ["model"], optional: ["agentId"] }],
  ["config-set", { required: ["path", "value"] }],
  ["config-set-ref", { required: ["path", "source", "id"], optional: ["provider"] }],
  ["setup", { optional: ["workspace", "model"] }],
  ["plugin-install", { required: ["spec"] }],
  [
    "create-agent",
    { required: ["agentId"], optional: ["name", "purpose", "workspace", "model", "role"] },
  ],
  ["create-team", { optional: ["coordinatorId", "prefix", "workspaceRoot"] }],
  ["gateway-start", {}],
  ["gateway-stop", {}],
  ["gateway-restart", {}],
]);

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

function resolvePendingKey(input: SystemAgentRescueMessageInput): string {
  // Pending approval is scoped by account, channel, and sender identity so one
  // owner route cannot approve a capability proposed through another route.
  const key = JSON.stringify({
    accountId: resolveAccountDiscriminator(input.command),
    channel: input.command.channelId ?? input.command.channel,
    from: input.command.from,
    senderId: input.command.senderId,
  });
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function resolveAccountDiscriminator(command: CommandContext): string {
  return command.accountId?.trim() || command.to?.trim() || "default";
}

function openPendingStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateSyncKeyedStore<unknown>({
    ownerId: "core:system-agent",
    namespace: RESCUE_PENDING_NAMESPACE,
    maxEntries: RESCUE_PENDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOperationFields(
  value: Record<string, unknown>,
  required: readonly string[] = [],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set(["kind", ...required, ...optional]);
  return (
    Object.hasOwn(value, "kind") &&
    required.every((key) => Object.hasOwn(value, key) && isNonEmptyString(value[key])) &&
    optional.every((key) =>
      key === "role"
        ? value.role === undefined || listAgentRoles().some((role) => role === value.role)
        : !Object.hasOwn(value, key) || isNonEmptyString(value[key]),
    ) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parsePendingOperation(value: unknown): SystemAgentOperation | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.operation)) {
    return null;
  }
  const operation = value.operation;
  if (typeof operation.kind !== "string") {
    return null;
  }
  const fields = RESCUE_OPERATION_FIELDS.get(operation.kind);
  if (!fields || !hasOperationFields(operation, fields.required, fields.optional)) {
    return null;
  }
  if (
    operation.kind === "config-set-ref" &&
    operation.source !== "env" &&
    operation.source !== "file" &&
    operation.source !== "exec" &&
    operation.source !== "store"
  ) {
    return null;
  }
  return isPersistentSystemAgentOperation(operation as SystemAgentOperation)
    ? (operation as SystemAgentOperation)
    : null;
}

function buildAuditDetails(input: SystemAgentRescueMessageInput): Record<string, unknown> {
  return {
    rescue: true,
    channel: input.command.channelId ?? input.command.channel,
    accountId: resolveAccountDiscriminator(input.command),
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
  if (operation.kind === "config-unset") {
    return [
      "OpenClaw rescue cannot remove configuration settings.",
      "Ask your regular agent to remove the setting, or run `openclaw config unset <path>` locally.",
    ].join(" ");
  }
  if (operation.kind === "doctor-fix") {
    return [
      "OpenClaw rescue cannot run doctor repairs from a message channel because they can change the inference route powering this session.",
      "On the machine running OpenClaw, with OpenClaw stopped, run `openclaw doctor --fix`.",
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

  const pendingStore = openPendingStore(input.env);
  const pendingKey = resolvePendingKey(input);
  const approvalIntent = classifySystemAgentApprovalText(rescueMessage);
  // Remote rescue never consults a model (a broken/compromised agent path must
  // not become a config editor); approval stays on the closed deterministic list.
  if (approvalIntent === "approve") {
    // Consume before any async execution. Concurrent approvals get at most one
    // capability, and a failed execution cannot leave a replayable write.
    const operation = parsePendingOperation(pendingStore.consume(pendingKey));
    if (!operation) {
      return "No pending OpenClaw rescue change is waiting for approval.";
    }
    const unsupported = formatUnsupportedRemoteOperation(operation);
    if (unsupported) {
      return unsupported;
    }
    const capture = createCaptureRuntime();
    await executeSystemAgentOperation(operation, capture.runtime, {
      approved: true,
      auditDetails: buildAuditDetails(input),
      deps: input.deps,
    });
    return capture.read() || "OpenClaw rescue change applied.";
  }

  if (approvalIntent === "decline") {
    const pending = parsePendingOperation(pendingStore.consume(pendingKey));
    return pending
      ? "Dropped the pending OpenClaw rescue change."
      : "No pending OpenClaw rescue change is waiting for approval.";
  }

  // Any fresh command revokes the previous capability for this exact route.
  // Persistent commands below replace it with their newly rendered plan.
  // Keep parse and registration below synchronous: invocation order must stay
  // publication order. Async validation begins only after approval consumes the row.
  pendingStore.delete(pendingKey);
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
        : resolveExpiresAtMsFromDurationMs(RESCUE_PENDING_TTL_MS, { nowMs });
    if (nowMs === undefined || expiresAtMs === undefined) {
      return "OpenClaw rescue could not create a pending approval because the expiry clock is invalid.";
    }
    const ttlMs = expiresAtMs - nowMs;
    pendingStore.register(
      pendingKey,
      {
        version: 1,
        operation,
      } satisfies RescuePendingOperation,
      { ttlMs },
    );
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
