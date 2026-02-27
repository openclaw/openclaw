import { randomUUID } from "node:crypto";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../../../acp/control-plane/spawn.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
} from "../../../acp/policy.js";
import { AcpRuntimeError } from "../../../acp/runtime/errors.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import { callGateway } from "../../../gateway/call.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  resolveAcpCommandAccountId,
  resolveAcpCommandBindingContext,
  resolveAcpCommandThreadId,
} from "./context.js";
import {
  ACP_STEER_OUTPUT_LIMIT,
  collectAcpErrorText,
  parseSpawnInput,
  parseSteerInput,
  resolveCommandRequestId,
  stopWithText,
  type AcpSpawnThreadMode,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

async function bindSpawnedAcpSessionToThread(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  threadMode: AcpSpawnThreadMode;
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  const { commandParams, threadMode } = params;
  if (threadMode === "off") {
    return {
      ok: false,
      error: "internal: thread binding is disabled for this spawn",
    };
  }

  const bindingContext = resolveAcpCommandBindingContext(commandParams);
  const channel = bindingContext.channel;
  if (!channel) {
    return {
      ok: false,
      error: "ACP thread binding requires a channel context.",
    };
  }

  const accountId = resolveAcpCommandAccountId(commandParams);
  const spawnPolicy = resolveThreadBindingSpawnPolicy({
    cfg: commandParams.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!spawnPolicy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "acp",
      }),
    };
  }
  if (!spawnPolicy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "acp",
      }),
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: spawnPolicy.channel,
    accountId: spawnPolicy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${channel}.`,
    };
  }
  if (!capabilities.bindSupported) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${channel}.`,
    };
  }

  const currentThreadId = bindingContext.threadId ?? "";

  if (threadMode === "here" && !currentThreadId) {
    return {
      ok: false,
      error: `--thread here requires running /acp spawn inside an active ${channel} thread/conversation.`,
    };
  }

  const threadId = currentThreadId || undefined;
  const placement = threadId ? "current" : "child";
  if (!capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placement} placement for ${channel}.`,
    };
  }
  const channelId = placement === "child" ? bindingContext.conversationId : undefined;

  if (placement === "child" && !channelId) {
    return {
      ok: false,
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  const senderId = commandParams.command.senderId?.trim() || "";
  if (threadId) {
    const existingBinding = bindingService.resolveByConversation({
      channel: spawnPolicy.channel,
      accountId: spawnPolicy.accountId,
      conversationId: threadId,
    });
    const boundBy =
      typeof existingBinding?.metadata?.boundBy === "string"
        ? existingBinding.metadata.boundBy.trim()
        : "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      return {
        ok: false,
        error: `Only ${boundBy} can rebind this thread.`,
      };
    }
  }

  const label = params.label || params.agentId;
  const conversationId = threadId || channelId;
  if (!conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  try {
    const binding = await bindingService.bind({
      targetSessionKey: params.sessionKey,
      targetKind: "session",
      conversation: {
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        conversationId,
      },
      placement,
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: params.agentId,
          label,
        }),
        agentId: params.agentId,
        label,
        boundBy: senderId || "unknown",
        introText: resolveThreadBindingIntroText({
          agentId: params.agentId,
          label,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: commandParams.cfg,
            channel: spawnPolicy.channel,
            accountId: spawnPolicy.accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: commandParams.cfg,
            channel: spawnPolicy.channel,
            accountId: spawnPolicy.accountId,
          }),
          sessionCwd: resolveAcpSessionCwd(params.sessionMeta),
          sessionDetails: resolveAcpThreadSessionDetailLines({
            sessionKey: params.sessionKey,
            meta: params.sessionMeta,
          }),
        }),
      },
    });
    return {
      ok: true,
      binding,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message || `Failed to bind a ${channel} thread/conversation to the new ACP session.`,
    };
  }
}

async function cleanupFailedSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  shouldDeleteSession: boolean;
  initializedRuntime?: AcpSpawnRuntimeCloseHandle;
}) {
  await cleanupFailedAcpSpawn({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    shouldDeleteSession: params.shouldDeleteSession,
    deleteTranscript: false,
    runtimeCloseHandle: params.initializedRuntime,
  });
}

export async function handleAcpSpawnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return stopWithText("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const parsed = parseSpawnInput(params, restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }

  const spawn = parsed.value;
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, spawn.agentId);
  if (agentPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: agentPolicyError,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "ACP target agent is not allowed by policy.",
      }),
    );
  }

  const acpManager = getAcpSessionManager();
  const sessionKey = `agent:${spawn.agentId}:acp:${randomUUID()}`;

  let initializedBackend = "";
  let initializedMeta: SessionAcpMeta | undefined;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    const initialized = await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent: spawn.agentId,
      mode: spawn.mode,
      cwd: spawn.cwd,
    });
    initializedRuntime = {
      runtime: initialized.runtime,
      handle: initialized.handle,
    };
    initializedBackend = initialized.handle.backend || initialized.meta.backend;
    initializedMeta = initialized.meta;
  } catch (err) {
    return stopWithText(
      collectAcpErrorText({
        error: err,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      }),
    );
  }

  let binding: SessionBindingRecord | null = null;
  if (spawn.thread !== "off") {
    const bound = await bindSpawnedAcpSessionToThread({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
      threadMode: spawn.thread,
      sessionMeta: initializedMeta,
    });
    if (!bound.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        sessionKey,
        shouldDeleteSession: true,
        initializedRuntime,
      });
      return stopWithText(`⚠️ ${bound.error}`);
    }
    binding = bound.binding;
  }

  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        ...(spawn.label ? { label: spawn.label } : {}),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    await cleanupFailedSpawn({
      cfg: params.cfg,
      sessionKey,
      shouldDeleteSession: true,
      initializedRuntime,
    });
    const message = err instanceof Error ? err.message : String(err);
    return stopWithText(`⚠️ ACP spawn failed: ${message}`);
  }

  const parts = [
    `✅ Spawned ACP session ${sessionKey} (${spawn.mode}, backend ${initializedBackend}).`,
  ];
  if (binding) {
    const currentThreadId = resolveAcpCommandThreadId(params) ?? "";
    const boundConversationId = binding.conversation.conversationId.trim();
    if (currentThreadId && boundConversationId === currentThreadId) {
      parts.push(`Bound this thread to ${sessionKey}.`);
    } else {
      parts.push(`Created thread ${boundConversationId} and bound it to ${sessionKey}.`);
    }
  } else {
    parts.push("Session is unbound (use /focus <session-key> to bind this thread/conversation).");
  }

  const dispatchNote = resolveAcpDispatchPolicyMessage(params.cfg);
  if (dispatchNote) {
    parts.push(`ℹ️ ${dispatchNote}`);
  }

  return stopWithText(parts.join(" "));
}

export async function handleAcpCancelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const token = restTokens.join(" ").trim() || undefined;
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const resolved = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (resolved.kind === "none") {
    return stopWithText(
      collectAcpErrorText({
        error: new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${target.sessionKey}`,
        ),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Session is not ACP-enabled.",
      }),
    );
  }
  if (resolved.kind === "stale") {
    return stopWithText(
      collectAcpErrorText({
        error: resolved.error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: resolved.error.message,
      }),
    );
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        reason: "manual-cancel",
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
    onSuccess: () => stopWithText(`✅ Cancel requested for ACP session ${target.sessionKey}.`),
  });
}

async function runAcpSteer(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  instruction: string;
  requestId: string;
}): Promise<string> {
  const acpManager = getAcpSessionManager();
  let output = "";

  await acpManager.runTurn({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    text: params.instruction,
    mode: "steer",
    requestId: params.requestId,
    onEvent: (event) => {
      if (event.type !== "text_delta") {
        return;
      }
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (event.text) {
        output += event.text;
        if (output.length > ACP_STEER_OUTPUT_LIMIT) {
          output = `${output.slice(0, ACP_STEER_OUTPUT_LIMIT)}…`;
        }
      }
    },
  });
  return output.trim();
}

export async function handleAcpSteerAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: dispatchPolicyError,
        fallbackCode: "ACP_DISPATCH_DISABLED",
        fallbackMessage: dispatchPolicyError.message,
      }),
    );
  }

  const parsed = parseSteerInput(restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const acpManager = getAcpSessionManager();

  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const resolved = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (resolved.kind === "none") {
    return stopWithText(
      collectAcpErrorText({
        error: new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${target.sessionKey}`,
        ),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Session is not ACP-enabled.",
      }),
    );
  }
  if (resolved.kind === "stale") {
    return stopWithText(
      collectAcpErrorText({
        error: resolved.error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: resolved.error.message,
      }),
    );
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await runAcpSteer({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        instruction: parsed.value.instruction,
        requestId: `${resolveCommandRequestId(params)}:steer`,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP steer failed before completion.",
    onSuccess: (steerOutput) => {
      if (!steerOutput) {
        return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.`);
      }
      return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.\n${steerOutput}`);
    },
  });
}

export async function handleAcpCloseAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const token = restTokens.join(" ").trim() || undefined;
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const resolved = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (resolved.kind === "none") {
    return stopWithText(
      collectAcpErrorText({
        error: new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${target.sessionKey}`,
        ),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Session is not ACP-enabled.",
      }),
    );
  }
  if (resolved.kind === "stale") {
    return stopWithText(
      collectAcpErrorText({
        error: resolved.error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: resolved.error.message,
      }),
    );
  }

  let runtimeNotice = "";
  try {
    const closed = await acpManager.closeSession({
      cfg: params.cfg,
      sessionKey: target.sessionKey,
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });
    runtimeNotice = closed.runtimeNotice ? ` (${closed.runtimeNotice})` : "";
  } catch (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      }),
    );
  }

  const removedBindings = await getSessionBindingService().unbind({
    targetSessionKey: target.sessionKey,
    reason: "manual",
  });

  return stopWithText(
    `✅ Closed ACP session ${target.sessionKey}${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
  );
}
