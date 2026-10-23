import { readChannelContextAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { getGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import { withNativeSubagentRequest } from "../../plugins/runtime/native-subagent-context.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import {
  type CommandUserTurn,
  prepareChannelCommandUserTurn,
} from "./channel-command-user-turn.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority-inbound.js";
import { withRequesterNativeSubagents } from "./request-native-subagent.js";

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

function requesterState(state: NativeSubagentDispatchState, turn?: CommandUserTurn) {
  const replyOptions = state.params.replyOptions;
  const entry = state.sessionStoreEntry.entry;
  const sessionKey = state.sessionStoreEntry.sessionKey ?? state.sessionKey;
  return {
    cfg: state.cfg,
    sessionAgentId: state.sessionAgentId,
    sessionKey,
    entry,
    runId: turn?.runId ?? replyOptions?.runId,
    operatorAuthority: replyOptions?.operatorAuthority,
    authorizeRequester: () =>
      resolveCommandAuthorizationAsync({
        ctx: state.ctx,
        cfg: state.cfg,
        commandAuthorized: state.ctx.CommandAuthorized,
      }),
    resolveToolAuthority: (owner: { senderIsOwner: boolean }) =>
      resolveInboundReplyToolAuthorityOverlay({
        ctx: state.ctx,
        sessionEntry: entry,
        senderIsOwner: owner.senderIsOwner,
        operatorAuthority: replyOptions?.operatorAuthority,
        toolsAllow: replyOptions?.toolsAllow,
        disableTools: replyOptions?.disableTools === true,
      }),
    messageChannel: state.ctx.OriginatingChannel ?? state.ctx.Provider ?? state.ctx.Surface,
    messageTo: state.ctx.OriginatingTo ?? state.ctx.To,
    getAbortSignal: () => {
      const signals = [state.getPreDispatchAbortSignal(), replyOptions?.abortSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      return signals.length ? AbortSignal.any(signals) : undefined;
    },
    assertCurrent: () => {
      state.assertProgressCurrent();
      state.turnAdoption?.assertCurrent();
    },
    commitTurn: async (assertCurrent: () => void) => {
      await state.assertCurrentBindingRoute();
      assertCurrent();
      await state.turnAdoption?.adopt();
      assertCurrent();
      const recorder = turn?.userTurnTranscriptRecorder ?? replyOptions?.userTurnTranscriptRecorder;
      if (!entry?.sessionId || !recorder || !(await recorder.resolveMessage())) {
        return false;
      }
      assertCurrent();
      await recorder.persistApproved({
        expectedSessionId: entry.sessionId,
        beforeFreshMessageCommit: assertCurrent,
      });
      assertCurrent();
      const receipt = recorder.getAdmissionReceipt();
      return Boolean(
        receipt &&
        receipt.sessionId === entry.sessionId &&
        receipt.sessionKey === sessionKey &&
        receipt.agentId === state.sessionAgentId,
      );
    },
    ingress: {
      ingressKind: "channel" as const,
      boundary: "auto-reply.reply-dispatch",
      evidence: readChannelContextAdmissionEvidence(state.ctx),
      gatewayLocalUserIngress: getGatewayLocalUserIngress(state.ctx),
    },
  };
}

/** Legacy hook and command invocations share the same requester/admission producer. */
export async function runWithReplyNativeSubagents<T>(
  state: NativeSubagentDispatchState,
  run: () => Promise<T>,
): Promise<T> {
  return await withRequesterNativeSubagents(requesterState(state), (create) =>
    withNativeSubagentRequest(async (guard) => {
      const runtime = await create(guard);
      if (!runtime) {
        throw new Error("Native subagents are unavailable for this requester.");
      }
      return runtime;
    }, run),
  );
}

export const runWithCommandNativeSubagents = async <T>(
  state: NativeSubagentDispatchState & { getDispatchAbortSignal: () => AbortSignal | undefined },
  binding: {
    agentId: string;
    sessionKey: string;
    entry: import("../../config/sessions/types.js").SessionEntry;
    storePath?: string;
    commandBody?: string;
  },
  run: (
    create:
      | import("../../plugins/runtime/native-subagent-context.js").NativeSubagentCommandFactory
      | undefined,
  ) => Promise<T>,
): Promise<T> => {
  // Internal/suggested text is not a fresh external command, even if it resembles one.
  const provenance = state.ctx.InputProvenance;
  const replyOptions = state.params.replyOptions;
  if (
    (provenance && provenance.kind !== "external_user") ||
    !replyOptions?.operatorAuthority ||
    binding.agentId !== state.sessionAgentId ||
    binding.sessionKey !== state.sessionKey
  ) {
    return await run(undefined);
  }
  // Gateway chat supplies its run and recorder; channel ingress gets a host-minted pair
  // bound to the same operator authority. Either way, the gate below is unchanged.
  const turn: CommandUserTurn | undefined =
    replyOptions.runId && replyOptions.userTurnTranscriptRecorder
      ? {
          runId: replyOptions.runId,
          userTurnTranscriptRecorder: replyOptions.userTurnTranscriptRecorder,
        }
      : await prepareChannelCommandUserTurn({
          dispatch: state,
          cfg: state.cfg,
          ctx: state.ctx,
          replyOptions,
          binding,
        });
  if (!turn) {
    return await run(undefined);
  }
  const requester = requesterState(
    {
      ...state,
      sessionAgentId: binding.agentId,
      sessionKey: binding.sessionKey,
      sessionStoreEntry: { sessionKey: binding.sessionKey, entry: binding.entry },
    },
    turn,
  );
  return await withRequesterNativeSubagents(
    {
      ...requester,
      sessionAgentId: binding.agentId,
      sessionKey: binding.sessionKey,
      entry: binding.entry,
      getAbortSignal: () => {
        const signals = [
          state.getDispatchAbortSignal(),
          state.params.replyOptions?.abortSignal,
        ].filter((signal): signal is AbortSignal => signal !== undefined);
        return signals.length ? AbortSignal.any(signals) : undefined;
      },
      ingress: { ...requester.ingress, boundary: "auto-reply.plugin-command" },
      commandIngressEligible: true,
      enableScheduledTurns: true,
    },
    run,
  );
};
