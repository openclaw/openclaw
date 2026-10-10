// Implements ACP lifecycle commands for start, stop, reset, and resume.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { resolveAcpSessionResolutionError } from "../../../acp/control-plane/manager.utils.js";
import { cleanupFailedAcpSpawn } from "../../../acp/control-plane/spawn.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
} from "../../../acp/policy.js";
import { resolveSessionStorePathForAcp } from "../../../acp/runtime/session-meta.js";
import { closeAdmittedRunDelegatedAuthority } from "../../../agents/admitted-run-context.js";
import { resolveSpawnedWorkspaceInheritance } from "../../../agents/spawned-context.js";
import { resolveAcpSpawnRuntimePolicyError } from "../../../agents/subagents/spawn/acp-spawn-policy.js";
import { resolveRuntimeCwdForAcpSpawn } from "../../../agents/subagents/spawn/acp-spawn-runtime.js";
import { readChannelContextAdmissionEvidence } from "../../../channels/message-access/admission-evidence.js";
import { updateSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getGatewayLocalUserIngress } from "../../../gateway/local-user-ingress.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { prepareChannelRunAdmission } from "../channel-run-admission.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  bindSpawnedAcpSession,
  resolveBoundReplyPayload,
  type SpawnedAcpSessionBinding,
} from "./bindings.js";
import {
  ACP_STEER_OUTPUT_LIMIT,
  acpCommandErrorReply,
  parseSpawnInput,
  parseSteerInput,
  resolveCommandRequestId,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";
async function persistSpawnedSessionLabel(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
}): Promise<void> {
  const label = normalizeOptionalString(params.label);
  if (!label) {
    return;
  }

  const now = Date.now();
  // Cross-agent ACP keys belong to the target agent's store, which can differ
  // from the requester's store during spawn.
  const { storePath, agentId } = resolveSessionStorePathForAcp({
    cfg: params.commandParams.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });

  // Only the requester store has an in-memory snapshot to keep coherent.
  params.commandParams.command.assertOwnerCurrent?.();
  if (params.commandParams.sessionStore && params.commandParams.storePath === storePath) {
    const existing = params.commandParams.sessionStore[params.sessionKey];
    if (existing) {
      params.commandParams.sessionStore[params.sessionKey] = {
        ...existing,
        label,
        updatedAt: now,
      };
    }
  }
  await updateSessionEntry(
    {
      storePath,
      agentId,
      sessionKey: params.sessionKey,
    },
    () => {
      params.commandParams.command.assertOwnerCurrent?.();
      return { label, updatedAt: now };
    },
  );
}

export async function handleAcpSpawnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return commandReply("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const parsed = parseSpawnInput(params, restTokens);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }

  const spawn = parsed.value;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg: params.cfg,
    requesterAgentId: params.agentId,
    requesterSessionKey: params.sessionKey,
  });
  if (runtimePolicyError) {
    return commandReply(`⚠️ ${runtimePolicyError}`);
  }
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, spawn.agentId);
  if (agentPolicyError) {
    return acpCommandErrorReply(
      agentPolicyError,
      "ACP target agent is not allowed by policy.",
      "ACP_SESSION_INIT_FAILED",
    );
  }

  const acpManager = getAcpSessionManager();
  const sessionKey = `agent:${spawn.agentId}:acp:${randomUUID()}`;
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: params.cfg,
    targetAgentId: spawn.agentId,
    requesterSessionKey: params.sessionKey,
    explicitWorkspaceDir: spawn.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd,
      explicitCwd: spawn.cwd,
    });
  } catch (error) {
    return acpCommandErrorReply(
      error,
      "Could not resolve ACP session workspace.",
      "ACP_SESSION_INIT_FAILED",
    );
  }

  let initialized: Awaited<ReturnType<typeof acpManager.initializeSession>>;
  try {
    initialized = await acpManager.initializeSession({
      assertActive: params.command.assertOwnerCurrent,
      cfg: params.cfg,
      sessionKey,
      agentId: spawn.agentId,
      agent: spawn.agentId,
      mode: spawn.mode,
      cwd: runtimeCwd,
    });
  } catch (err) {
    return acpCommandErrorReply(
      err,
      "Could not initialize ACP session runtime.",
      "ACP_SESSION_INIT_FAILED",
    );
  }

  const { sessionEntry, closeRuntimeOnFailure, meta: initializedMeta } = initialized;
  const initializedBackend = initialized.handle.backend || initializedMeta.backend;
  const cleanupSpawn = () =>
    cleanupFailedAcpSpawn({
      cfg: params.cfg,
      sessionKey,
      agentId: spawn.agentId,
      sessionEntry,
      deleteTranscript: false,
      closeRuntimeOnFailure,
    });

  let boundSession: SpawnedAcpSessionBinding | undefined;
  if (spawn.bind !== "off" || spawn.thread !== "off") {
    const result = await bindSpawnedAcpSession({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
      mode:
        spawn.bind !== "off"
          ? "conversation"
          : spawn.thread === "here"
            ? "thread-here"
            : "thread-auto",
      sessionMeta: initializedMeta,
    });
    if (!result.ok) {
      await cleanupSpawn();
      return commandReply(`⚠️ ${result.error}`);
    }
    boundSession = result.bound;
  }

  try {
    await persistSpawnedSessionLabel({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
    });
  } catch (err) {
    await cleanupSpawn();
    const message = formatErrorMessage(err);
    return commandReply(`⚠️ ACP spawn failed: ${message}`);
  }

  const parts = [
    `✅ Spawned ACP session ${sessionKey} (${spawn.mode}, backend ${initializedBackend}).`,
  ];
  if (boundSession) {
    const { binding, placement, labelNoun } = boundSession;
    const boundConversationId = binding.conversation.conversationId.trim();
    if (placement === "current") {
      parts.push(`Bound this ${labelNoun} to ${sessionKey}.`);
    } else {
      parts.push(`Created ${labelNoun} ${boundConversationId} and bound it to ${sessionKey}.`);
    }
    const boundReplyPayload = await resolveBoundReplyPayload({
      binding,
      placement,
    });
    if (boundReplyPayload) {
      return commandReply({ text: parts.join(" "), ...boundReplyPayload });
    }
  } else {
    parts.push(
      "Session is unbound (use /acp spawn ... --bind here to create a session bound to this conversation).",
    );
  }

  const dispatchNote = resolveAcpDispatchPolicyMessage(params.cfg);
  if (dispatchNote) {
    parts.push(`ℹ️ ${dispatchNote}`);
  }

  return commandReply(parts.join(" "));
}

async function resolveAcpSessionForCommandOrStop(params: {
  acpManager: ReturnType<typeof getAcpSessionManager>;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => void;
}): Promise<CommandHandlerResult | null> {
  const resolved = await params.acpManager.resolveSessionAsync({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  const error = resolveAcpSessionResolutionError(resolved);
  if (error) {
    return acpCommandErrorReply(error, error.message, "ACP_SESSION_INIT_FAILED");
  }
  return null;
}

async function withResolvedAcpSessionTarget(params: {
  commandParams: HandleCommandsParams;
  token?: string;
  run: (ctx: {
    acpManager: ReturnType<typeof getAcpSessionManager>;
    sessionKey: string;
    agentId: string;
  }) => Promise<CommandHandlerResult>;
}): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const target = await resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token: params.token,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }
  const guardFailure = await resolveAcpSessionForCommandOrStop({
    acpManager,
    cfg: params.commandParams.cfg,
    ...target,
    assertCurrent: params.commandParams.command.assertOwnerCurrent,
  });
  params.commandParams.command.assertOwnerCurrent?.();
  if (guardFailure) {
    return guardFailure;
  }
  return await params.run({
    acpManager,
    ...target,
  });
}

export async function handleAcpCancelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    token: normalizeOptionalString(restTokens.join(" ")),
    run: async ({ acpManager, sessionKey, agentId }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          await acpManager.cancelSession({
            assertActive: params.command.assertOwnerCurrent,
            cfg: params.cfg,
            sessionKey,
            agentId,
            reason: "manual-cancel",
          });
          return commandReply(`✅ Cancel requested for ACP session ${sessionKey}.`);
        },
        fallbackMessage: "ACP cancel failed before completion.",
      }),
  });
}

export async function handleAcpSteerAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return acpCommandErrorReply(
      dispatchPolicyError,
      dispatchPolicyError.message,
      "ACP_DISPATCH_DISABLED",
    );
  }

  const parsed = parseSteerInput(restTokens);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    token: parsed.value.sessionToken,
    run: async ({ sessionKey, agentId }) =>
      withAcpCommandErrorBoundary({
        run: async () => {
          const requestId = `${resolveCommandRequestId(params)}:steer`;
          const steeringManager = getAcpSessionManager();
          let output = "";
          const admittedRunContext = await prepareChannelRunAdmission({
            assertSourceCurrent: params.command.assertOwnerCurrent,
            cfg: params.cfg,
            runId: requestId,
            agentId,
            ingressKind: "acp",
            boundary: "acp.command.steer",
            evidence: readChannelContextAdmissionEvidence(params.rootCtx ?? params.ctx),
            gatewayLocalUserIngress: getGatewayLocalUserIngress(params.rootCtx ?? params.ctx),
          }).admit("acp");
          try {
            await steeringManager.runTurn({
              admittedRunContext,
              cfg: params.cfg,
              sessionKey,
              agentId,
              provenance: "agent",
              text: parsed.value.instruction,
              mode: "steer",
              requestId,
              onEvent: (event) => {
                if (event.type !== "text_delta" || (event.stream && event.stream !== "output")) {
                  return;
                }
                if (event.text) {
                  output += event.text;
                  if (output.length > ACP_STEER_OUTPUT_LIMIT) {
                    output = `${truncateUtf16Safe(output, ACP_STEER_OUTPUT_LIMIT)}…`;
                  }
                }
              },
            });
          } finally {
            closeAdmittedRunDelegatedAuthority(admittedRunContext);
          }
          const steerOutput = output.trim();
          return commandReply(
            `✅ ACP steer sent to ${sessionKey}.${steerOutput ? `\n${steerOutput}` : ""}`,
          );
        },
        fallbackMessage: "ACP steer failed before completion.",
      }),
  });
}

export async function handleAcpCloseAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    token: normalizeOptionalString(restTokens.join(" ")),
    run: async ({ acpManager, sessionKey, agentId }) => {
      let runtimeNotice;
      try {
        const closed = await acpManager.closeSession({
          assertActive: params.command.assertOwnerCurrent,
          cfg: params.cfg,
          sessionKey,
          agentId,
          reason: "manual-close",
          allowBackendUnavailable: true,
          clearMeta: true,
        });
        runtimeNotice = closed.runtimeNotice ? ` (${closed.runtimeNotice})` : "";
      } catch (error) {
        return acpCommandErrorReply(error, "ACP close failed before completion.");
      }

      const removedBindings = await getSessionBindingService().unbind({
        targetSessionKey: sessionKey,
        reason: "manual",
      });

      return commandReply(
        `✅ Closed ACP session ${sessionKey}${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
      );
    },
  });
}
