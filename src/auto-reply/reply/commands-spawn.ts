import crypto from "node:crypto";
import type { CommandHandler } from "./commands-types.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { buildSubagentSystemPrompt } from "../../agents/subagent-announce.js";
import { registerSubagentRun } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";

const SPAWN_COMMAND = "/spawn";
const SUBAGENT_ALIAS = "/subagent";

type SpawnOptions = {
  task: string;
  model?: string;
  label?: string;
  deliver?: boolean;
};

function parseSpawnArgs(argsRaw: string): SpawnOptions | { error: string } {
  const tokens: string[] = [];
  let remaining = argsRaw.trim();

  const options: Partial<SpawnOptions> = {};

  // Parse flags before the task
  while (remaining.length > 0) {
    // Check for --model flag
    const modelMatch = remaining.match(/^--model\s+(\S+)\s*/);
    if (modelMatch) {
      options.model = modelMatch[1];
      remaining = remaining.slice(modelMatch[0].length);
      continue;
    }

    // Check for --label flag
    const labelMatch = remaining.match(/^--label\s+(\S+)\s*/);
    if (labelMatch) {
      options.label = labelMatch[1];
      remaining = remaining.slice(labelMatch[0].length);
      continue;
    }

    // Check for --deliver flag
    if (remaining.startsWith("--deliver")) {
      options.deliver = true;
      remaining = remaining.slice("--deliver".length).trimStart();
      continue;
    }

    // If no more flags, the rest is the task
    break;
  }

  const task = remaining.trim();
  if (!task) {
    return { error: "Missing task. Usage: /spawn <task>" };
  }

  return { task, ...options };
}

function buildSpawnHelp(): string {
  return [
    "🚀 Spawn a subagent",
    "",
    "Usage:",
    "  /spawn <task>",
    "  /spawn --model <model> <task>",
    "  /spawn --label <label> <task>",
    "  /spawn --deliver <task>",
    "",
    "Options:",
    "  --model    Model override (e.g., anthropic/claude-sonnet-4-20250514)",
    "  --label    Label for the subagent",
    "  --deliver  Enable delivery of subagent responses",
    "",
    "Alias: /subagent",
  ].join("\n");
}

export const handleSpawnCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized.toLowerCase();
  if (!normalized.startsWith(SPAWN_COMMAND) && !normalized.startsWith(SUBAGENT_ALIAS)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /spawn from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Extract the command part and args
  const commandBody = params.command.commandBodyNormalized;
  const commandEnd = commandBody.indexOf(" ");
  const argsRaw = commandEnd === -1 ? "" : commandBody.slice(commandEnd + 1).trim();

  // Show help if no args or --help
  if (!argsRaw || argsRaw === "--help" || argsRaw === "-h" || argsRaw === "help") {
    return { shouldContinue: false, reply: { text: buildSpawnHelp() } };
  }

  const parsed = parseSpawnArgs(argsRaw);
  if ("error" in parsed) {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.error}` } };
  }

  const { task, model, label, deliver } = parsed;

  // Resolve session context
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = params.sessionKey;

  // Don't allow spawning from subagent sessions
  if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Cannot spawn subagents from subagent sessions." },
    };
  }

  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;

  const requesterAgentId = normalizeAgentId(parseAgentSessionKey(requesterInternalKey)?.agentId);

  // Create child session key
  const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
  const spawnedByKey = requesterInternalKey;

  // Resolve delivery context from the originating message
  const requesterOrigin = normalizeDeliveryContext({
    channel: params.ctx.OriginatingChannel ?? params.command.channel,
    accountId: params.ctx.AccountId,
    to: params.ctx.OriginatingTo ?? params.command.from,
    threadId: params.ctx.MessageThreadId,
  });

  // Build subagent system prompt
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
  });

  // Apply model override if specified
  if (model) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model },
        timeoutMs: 10_000,
      });
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      // Only fail on non-recoverable errors
      const recoverable =
        messageText.includes("invalid model") || messageText.includes("model not allowed");
      if (!recoverable) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ Failed to apply model: ${messageText}` },
        };
      }
      // Log warning but continue
      logVerbose(`/spawn model warning: ${messageText}`);
    }
  }

  // Spawn the subagent via gateway
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;

  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: task,
        sessionKey: childSessionKey,
        channel: requesterOrigin?.channel,
        idempotencyKey: childIdem,
        deliver: deliver ?? false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        label: label || undefined,
        spawnedBy: spawnedByKey,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Failed to spawn subagent: ${messageText}` },
    };
  }

  // Register the subagent run for tracking
  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    requesterDisplayKey: requesterInternalKey === mainKey ? alias : requesterInternalKey,
    task,
    cleanup: "keep",
    label: label || undefined,
    runTimeoutSeconds: 0,
  });

  // Fire-and-forget: return with no reply (subagent will announce when done)
  // This is the key difference from asking the model to spawn - no confirmation message
  return { shouldContinue: false };
};
