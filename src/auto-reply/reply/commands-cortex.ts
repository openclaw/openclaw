import {
  getAgentCortexMemoryCaptureStatusWithHistory,
  resolveAgentCortexConfig,
  resolveAgentCortexModeStatus,
  resolveCortexChannelTarget,
} from "../../agents/cortex.js";
import { logVerbose } from "../../globals.js";
import {
  clearCortexModeOverride,
  getCortexModeOverride,
  setCortexModeOverride,
  type CortexModeScope,
} from "../../memory/cortex-mode-overrides.js";
import type { CortexMemoryResolveAction } from "../../memory/cortex.js";
import {
  type CortexMemoryConflict,
  listCortexMemoryConflicts,
  previewCortexContext,
  resolveCortexMemoryConflict,
  syncCortexCodingContext,
  type CortexPolicy,
} from "../../memory/cortex.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

function parseCortexCommandArgs(commandBodyNormalized: string): string {
  if (commandBodyNormalized === "/cortex") {
    return "";
  }
  if (commandBodyNormalized.startsWith("/cortex ")) {
    return commandBodyNormalized.slice(8).trim();
  }
  return "";
}

function parseMode(value?: string): CortexPolicy | null {
  if (
    value === "full" ||
    value === "professional" ||
    value === "technical" ||
    value === "minimal"
  ) {
    return value;
  }
  return null;
}

function parseResolveAction(value?: string): CortexMemoryResolveAction | null {
  if (value === "accept-new" || value === "keep-old" || value === "merge" || value === "ignore") {
    return value;
  }
  return null;
}

function resolveActiveSessionId(params: HandleCommandsParams): string | undefined {
  return params.sessionEntry?.sessionId ?? params.ctx.SessionId;
}

function resolveActiveChannelId(params: HandleCommandsParams): string {
  return resolveCortexChannelTarget({
    channel: params.command.channel,
    channelId: params.command.channelId,
    originatingChannel: String(params.ctx.OriginatingChannel ?? ""),
    originatingTo: params.ctx.OriginatingTo,
    nativeChannelId: params.ctx.NativeChannelId,
    to: params.command.to ?? params.ctx.To,
    from: params.command.from ?? params.ctx.From,
  });
}

function resolveScopeTarget(
  params: HandleCommandsParams,
  rawScope?: string,
): { scope: CortexModeScope; targetId: string } | { error: string } {
  const requested = rawScope?.trim().toLowerCase();
  if (!requested || requested === "here" || requested === "session") {
    const sessionId = resolveActiveSessionId(params);
    if (sessionId) {
      return { scope: "session", targetId: sessionId };
    }
    if (!requested || requested === "here") {
      return {
        scope: "channel",
        targetId: resolveActiveChannelId(params),
      };
    }
    return { error: "No active session id is available for this conversation." };
  }
  if (requested === "channel") {
    return {
      scope: "channel",
      targetId: resolveActiveChannelId(params),
    };
  }
  return { error: "Use `/cortex mode set <mode> [here|session|channel]`." };
}

async function buildCortexHelpReply(): Promise<ReplyPayload> {
  return {
    text: [
      "🧠 /cortex",
      "",
      "Manage Cortex prompt context for the active conversation.",
      "",
      "Try:",
      "- /cortex preview",
      "- /cortex why",
      "- /cortex continuity",
      "- /cortex conflicts",
      "- /cortex conflict <conflictId>",
      "- /cortex resolve <conflictId> <accept-new|keep-old|merge|ignore>",
      "- /cortex sync coding",
      "- /cortex mode show",
      "- /cortex mode set minimal",
      "- /cortex mode set professional channel",
      "- /cortex mode reset",
      "",
      "Tip: after changing mode, run /status or /cortex preview to verify what will be used.",
    ].join("\n"),
  };
}

function formatCortexConflictLines(conflict: CortexMemoryConflict, index?: number): string[] {
  const prefix = typeof index === "number" ? `${index + 1}. ` : "";
  return [
    `${prefix}${conflict.id} · ${conflict.type} · severity ${conflict.severity.toFixed(2)}`,
    conflict.summary,
    conflict.nodeLabel ? `Node: ${conflict.nodeLabel}` : null,
    conflict.oldValue ? `Old: ${conflict.oldValue}` : null,
    conflict.newValue ? `New: ${conflict.newValue}` : null,
    `Inspect: /cortex conflict ${conflict.id}`,
    `Resolve newer: /cortex resolve ${conflict.id} accept-new`,
    `Keep older: /cortex resolve ${conflict.id} keep-old`,
    `Ignore: /cortex resolve ${conflict.id} ignore`,
  ].filter(Boolean) as string[];
}

async function resolveCortexConversationState(params: HandleCommandsParams) {
  const agentId = params.agentId ?? "main";
  const cortex = resolveAgentCortexConfig(params.cfg, agentId);
  if (!cortex) {
    return null;
  }
  const sessionId = resolveActiveSessionId(params);
  const channelId = resolveActiveChannelId(params);
  const modeStatus = await resolveAgentCortexModeStatus({
    agentId,
    cfg: params.cfg,
    sessionId,
    channelId,
  });
  const source =
    modeStatus?.source === "session-override"
      ? "session override"
      : modeStatus?.source === "channel-override"
        ? "channel override"
        : "agent config";
  return {
    agentId,
    cortex,
    sessionId,
    channelId,
    mode: modeStatus?.mode ?? cortex.mode,
    source,
  };
}

async function buildCortexPreviewReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  const preview = await previewCortexContext({
    workspaceDir: params.workspaceDir,
    graphPath: state.cortex.graphPath,
    policy: state.mode,
    maxChars: state.cortex.maxChars,
  });
  if (!preview.context) {
    return {
      text: `No Cortex context available for mode ${state.mode}.`,
    };
  }
  return {
    text: [`Cortex preview (${state.mode}, ${state.source})`, "", preview.context].join("\n"),
  };
}

async function buildCortexWhyReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  let previewBody = "No Cortex context is currently being injected.";
  let previewGraphPath = state.cortex.graphPath ?? ".cortex/context.json";
  let previewError: string | null = null;
  try {
    const preview = await previewCortexContext({
      workspaceDir: params.workspaceDir,
      graphPath: state.cortex.graphPath,
      policy: state.mode,
      maxChars: state.cortex.maxChars,
    });
    previewGraphPath = preview.graphPath;
    previewBody = preview.context || previewBody;
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error);
  }
  const captureStatus = await getAgentCortexMemoryCaptureStatusWithHistory({
    agentId: state.agentId,
    sessionId: state.sessionId,
    channelId: state.channelId,
  });
  return {
    text: [
      "Why I answered this way",
      "",
      `Mode: ${state.mode}`,
      `Source: ${state.source}`,
      `Graph: ${previewGraphPath}`,
      state.sessionId ? `Session: ${state.sessionId}` : null,
      state.channelId ? `Channel: ${state.channelId}` : null,
      captureStatus
        ? `Last memory capture: ${captureStatus.captured ? "stored" : "skipped"} (${captureStatus.reason}, score ${captureStatus.score.toFixed(2)})`
        : "Last memory capture: not evaluated yet",
      captureStatus?.error ? `Capture error: ${captureStatus.error}` : null,
      captureStatus?.syncedCodingContext
        ? `Coding sync: updated (${(captureStatus.syncPlatforms ?? []).join(", ")})`
        : null,
      previewError ? `Preview error: ${previewError}` : null,
      "",
      "Injected Cortex context:",
      previewBody,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function buildCortexContinuityReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  return {
    text: [
      "Cortex continuity",
      "",
      "This conversation is using the shared Cortex graph for the active agent.",
      `Agent: ${state.agentId}`,
      `Mode: ${state.mode} (${state.source})`,
      `Graph: ${state.cortex.graphPath ?? ".cortex/context.json"}`,
      state.sessionId ? `Session: ${state.sessionId}` : null,
      state.channelId ? `Channel: ${state.channelId}` : null,
      "",
      "Messages from other channels on this agent reuse the same graph unless you override the graph path or mode there.",
      "Try /cortex preview from another channel to verify continuity.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function buildCortexConflictsReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  const conflicts = await listCortexMemoryConflicts({
    workspaceDir: params.workspaceDir,
    graphPath: state.cortex.graphPath,
  });
  if (conflicts.length === 0) {
    return {
      text: "No Cortex memory conflicts.",
    };
  }
  return {
    text: [
      `Cortex conflicts (${conflicts.length})`,
      "",
      ...conflicts
        .slice(0, 3)
        .flatMap((conflict, index) => [...formatCortexConflictLines(conflict, index), ""]),
      conflicts.length > 3 ? `…and ${conflicts.length - 3} more.` : null,
      "",
      "Use /cortex conflict <conflictId> for the full structured view.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function buildCortexConflictDetailReply(
  params: HandleCommandsParams,
  args: string,
): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  const tokens = args.split(/\s+/).filter(Boolean);
  const conflictId = tokens[1];
  if (!conflictId) {
    return {
      text: "Usage: /cortex conflict <conflictId>",
    };
  }
  const conflicts = await listCortexMemoryConflicts({
    workspaceDir: params.workspaceDir,
    graphPath: state.cortex.graphPath,
  });
  const conflict = conflicts.find((entry) => entry.id === conflictId);
  if (!conflict) {
    return {
      text: `Cortex conflict not found: ${conflictId}`,
    };
  }
  return {
    text: ["Cortex conflict detail", "", ...formatCortexConflictLines(conflict)].join("\n"),
  };
}

async function buildCortexResolveReply(
  params: HandleCommandsParams,
  args: string,
): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  const tokens = args.split(/\s+/).filter(Boolean);
  const conflictId = tokens[1];
  const action = parseResolveAction(tokens[2]);
  if (!conflictId || !action) {
    return {
      text: "Usage: /cortex resolve <conflictId> <accept-new|keep-old|merge|ignore>",
    };
  }
  const result = await resolveCortexMemoryConflict({
    workspaceDir: params.workspaceDir,
    graphPath: state.cortex.graphPath,
    conflictId,
    action,
    commitMessage: `openclaw cortex resolve ${conflictId} ${action}`,
  });
  return {
    text: [
      `Resolved Cortex conflict ${result.conflictId}.`,
      `Action: ${result.action}`,
      `Status: ${result.status}`,
      typeof result.nodesUpdated === "number" ? `Nodes updated: ${result.nodesUpdated}` : null,
      typeof result.nodesRemoved === "number" ? `Nodes removed: ${result.nodesRemoved}` : null,
      result.commitId ? `Commit: ${result.commitId}` : null,
      result.message ?? null,
      "Use /cortex conflicts or /cortex preview to inspect the updated memory state.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function buildCortexSyncReply(
  params: HandleCommandsParams,
  args: string,
): Promise<ReplyPayload> {
  const state = await resolveCortexConversationState(params);
  if (!state) {
    return {
      text: "Cortex prompt bridge is disabled for this agent. Enable it in config or with `openclaw memory cortex enable`.",
    };
  }
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens[1]?.toLowerCase() !== "coding") {
    return {
      text: "Usage: /cortex sync coding [full|professional|technical|minimal] [platform ...]",
    };
  }
  const requestedMode = parseMode(tokens[2]);
  const policy = requestedMode ?? "technical";
  const platformStartIndex = requestedMode ? 3 : 2;
  const platforms = tokens.slice(platformStartIndex).filter(Boolean);
  const result = await syncCortexCodingContext({
    workspaceDir: params.workspaceDir,
    graphPath: state.cortex.graphPath,
    policy,
    platforms,
  });
  return {
    text: [
      "Synced Cortex coding context.",
      `Mode: ${result.policy}`,
      `Platforms: ${result.platforms.join(", ")}`,
      `Graph: ${result.graphPath}`,
    ].join("\n"),
  };
}

async function buildCortexModeReply(
  params: HandleCommandsParams,
  args: string,
): Promise<ReplyPayload> {
  const tokens = args.split(/\s+/).filter(Boolean);
  const action = tokens[1]?.toLowerCase();
  const agentId = params.agentId ?? "main";

  if (!action || action === "help") {
    return {
      text: [
        "Usage:",
        "- /cortex mode show",
        "- /cortex mode set <full|professional|technical|minimal> [here|session|channel]",
        "- /cortex mode reset [here|session|channel]",
      ].join("\n"),
    };
  }

  if (action === "show") {
    const target = resolveScopeTarget(params, tokens[2]);
    if ("error" in target) {
      return { text: target.error };
    }
    const override = await getCortexModeOverride({
      agentId,
      sessionId: target.scope === "session" ? target.targetId : undefined,
      channelId: target.scope === "channel" ? target.targetId : undefined,
    });
    if (!override) {
      return {
        text: `No Cortex mode override for this ${target.scope}.`,
      };
    }
    return {
      text: `Cortex mode for this ${target.scope}: ${override.mode}`,
    };
  }

  if (action === "set") {
    const mode = parseMode(tokens[2]);
    if (!mode) {
      return {
        text: "Usage: /cortex mode set <full|professional|technical|minimal> [here|session|channel]",
      };
    }
    const target = resolveScopeTarget(params, tokens[3]);
    if ("error" in target) {
      return { text: target.error };
    }
    await setCortexModeOverride({
      agentId,
      scope: target.scope,
      targetId: target.targetId,
      mode,
    });
    return {
      text: [
        `Set Cortex mode for this ${target.scope} to ${mode}.`,
        "Use /status or /cortex preview to verify.",
      ].join("\n"),
    };
  }

  if (action === "reset") {
    const target = resolveScopeTarget(params, tokens[2]);
    if ("error" in target) {
      return { text: target.error };
    }
    const removed = await clearCortexModeOverride({
      agentId,
      scope: target.scope,
      targetId: target.targetId,
    });
    return {
      text: removed
        ? [
            `Cleared Cortex mode override for this ${target.scope}.`,
            "Use /status or /cortex preview to verify.",
          ].join("\n")
        : `No Cortex mode override for this ${target.scope}.`,
    };
  }

  return {
    text: "Usage: /cortex preview | /cortex mode <show|set|reset> ...",
  };
}

export const handleCortexCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/cortex" && !normalized.startsWith("/cortex ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /cortex from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  try {
    const args = parseCortexCommandArgs(normalized);
    const subcommand = args.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
    const reply =
      !subcommand || subcommand === "help"
        ? await buildCortexHelpReply()
        : subcommand === "preview"
          ? await buildCortexPreviewReply(params)
          : subcommand === "why"
            ? await buildCortexWhyReply(params)
            : subcommand === "continuity"
              ? await buildCortexContinuityReply(params)
              : subcommand === "conflicts"
                ? await buildCortexConflictsReply(params)
                : subcommand === "conflict"
                  ? await buildCortexConflictDetailReply(params, args)
                  : subcommand === "resolve"
                    ? await buildCortexResolveReply(params, args)
                    : subcommand === "sync"
                      ? await buildCortexSyncReply(params, args)
                      : subcommand === "mode"
                        ? await buildCortexModeReply(params, args)
                        : {
                            text: "Usage: /cortex preview | /cortex why | /cortex continuity | /cortex conflicts | /cortex conflict <id> | /cortex resolve ... | /cortex sync coding ... | /cortex mode <show|set|reset> ...",
                          };
    return {
      shouldContinue: false,
      reply,
    };
  } catch (error) {
    return {
      shouldContinue: false,
      reply: {
        text: error instanceof Error ? error.message : String(error),
      },
    };
  }
};
