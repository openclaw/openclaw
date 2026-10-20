import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveStoredSessionPermissionPolicy } from "../../agents/tool-fs-policy.js";
import { readChannelContextAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { getGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { withNativeSubagentRequest } from "../../plugins/runtime/native-subagent-context.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority-inbound.js";

type NativeSubagentDispatchState = Pick<
  PrepareDispatchOperationReadyState,
  | "cfg"
  | "ctx"
  | "sessionAgentId"
  | "sessionKey"
  | "getPreDispatchAbortSignal"
  | "assertProgressCurrent"
  | "assertCurrentBindingRoute"
  | "turnAdoption"
> & {
  params: Pick<PrepareDispatchOperationReadyState["params"], "replyOptions">;
  sessionStoreEntry: Pick<
    PrepareDispatchOperationReadyState["sessionStoreEntry"],
    "sessionKey" | "entry"
  >;
};

/** Only the dispatch owner may bind the actual admitted request, never plugin arguments. */
export async function runWithReplyNativeSubagents<T>(
  state: NativeSubagentDispatchState,
  run: () => Promise<T>,
): Promise<T> {
  let admission: PreparedAgentRunAdmission | undefined;
  try {
    return await withNativeSubagentRequest(async (guard) => {
      const { cfg, ctx, params, sessionAgentId, sessionStoreEntry } = state;
      const sessionKey = sessionStoreEntry.sessionKey ?? state.sessionKey;
      const entry = sessionStoreEntry.entry;
      const runId = params.replyOptions?.runId;
      const operatorAuthority = params.replyOptions?.operatorAuthority;
      const signals = [
        state.getPreDispatchAbortSignal(),
        params.replyOptions?.abortSignal,
        guard.signal,
      ].filter((value): value is AbortSignal => value !== undefined);
      const signal = AbortSignal.any(signals);
      if (!sessionKey || !entry?.sessionId || !runId || !operatorAuthority) {
        throw new Error(
          "Native subagents require an admitted requester session, turn, and operator authority.",
        );
      }
      const assertCurrent = () => {
        guard.assertCurrent();
        signal?.throwIfAborted();
        operatorAuthority.assertCurrent();
        state.assertProgressCurrent();
        state.turnAdoption?.assertCurrent();
      };
      assertCurrent();
      const owner = await resolveCommandAuthorizationAsync({
        ctx,
        cfg,
        commandAuthorized: ctx.CommandAuthorized,
      });
      assertCurrent();
      const workspaceDir =
        entry.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
      const overlay = resolveInboundReplyToolAuthorityOverlay({
        ctx,
        sessionEntry: entry,
        senderIsOwner: owner.senderIsOwner,
        operatorAuthority,
        toolsAllow: params.replyOptions?.toolsAllow,
        disableTools: params.replyOptions?.disableTools === true,
      });
      const model = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const options = {
        ...overlay,
        config: cfg,
        agentId: sessionAgentId,
        sessionKey,
        sessionId: entry.sessionId,
        runId,
        workspaceDir,
        cwd: entry.spawnedCwd ?? workspaceDir,
        sessionPermissionPolicy: resolveStoredSessionPermissionPolicy(entry, workspaceDir),
        runtimeToolAllowlist: overlay.disableTools ? [] : overlay.toolsAllow,
        inheritRuntimeToolAllowlist: true,
        modelProvider: model.provider,
        modelId: model.model,
        requesterModel: model,
        abortSignal: signal,
        allowGatewaySubagentBinding: true,
        messageChannel: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
        messageTo: ctx.OriginatingTo ?? ctx.To,
      };
      const { prepareConversationCapabilityProfile } =
        await import("../../agents/conversation-capability-profile.js");
      const { createRequestNativeSubagentRuntime } =
        await import("../../agents/plugin-native-subagent.js");
      assertCurrent();
      const sandbox = resolvePreparedSandboxRuntimeStatus({
        cfg,
        agentId: sessionAgentId,
        sessionKey,
        preparedSessionEntry: entry,
      });
      const conversationCapabilityProfile = await prepareConversationCapabilityProfile({
        ...options,
        sandboxToolPolicy: sandbox.sandboxed ? sandbox.toolPolicy : undefined,
        preparedSessionEntry: { sessionKey, entry },
      });
      assertCurrent();
      return createRequestNativeSubagentRuntime(
        {
          options: { ...options, conversationCapabilityProfile },
          lifecycleRevision: entry.lifecycleRevision,
          operatorAuthority,
          assertCurrent: () => {
            assertCurrent();
            owner.assertOwnerCurrent?.();
          },
          async prepareSpawn(assertSpawnCurrent) {
            await state.assertCurrentBindingRoute();
            assertSpawnCurrent();
            await state.turnAdoption?.adopt();
            assertSpawnCurrent();
            const recorder = params.replyOptions?.userTurnTranscriptRecorder;
            if (!recorder || !(await recorder.resolveMessage())) {
              throw new Error(
                "Native subagent spawn requires the current user-turn transcript recorder.",
              );
            }
            assertSpawnCurrent();
            await recorder.persistApproved({
              expectedSessionId: entry.sessionId,
              beforeFreshMessageCommit: assertSpawnCurrent,
            });
            assertSpawnCurrent();
            const receipt = recorder.getAdmissionReceipt();
            if (
              !receipt ||
              receipt.sessionId !== entry.sessionId ||
              receipt.sessionKey !== sessionKey ||
              receipt.agentId !== sessionAgentId
            ) {
              throw new Error("Native subagent spawn requires committed user-turn input.");
            }
            if (!admission) {
              const scope = getPluginRuntimeGatewayRequestScope();
              const resolveGatewayContext =
                scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
              if (!resolveGatewayContext) {
                throw new Error("Native subagent controller requires its Gateway binding.");
              }
              admission = prepareChannelRunAdmission({
                cfg,
                runId,
                agentId: sessionAgentId,
                ingressKind: "channel",
                boundary: "auto-reply.reply-dispatch",
                evidence: readChannelContextAdmissionEvidence(ctx),
                gatewayLocalUserIngress: getGatewayLocalUserIngress(ctx),
                operatorAuthority,
                // Accepted children retain the operator source, not this hook invocation.
                assertSourceCurrent: () => {
                  operatorAuthority.assertCurrent();
                  owner.assertOwnerCurrent?.();
                },
                onAdmitted: (context) => bindGatewayContextResolver(context, resolveGatewayContext),
              });
            }
            return await admission.admit("plugin-harness", guard.pluginId);
          },
        },
        guard,
      );
    }, run);
  } finally {
    admission?.close();
  }
}
