import { expectDefined } from "@openclaw/normalization-core";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { MsgContext } from "../templating.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { runWithCommandNativeSubagents } from "./dispatch-native-subagent.js";
import { finalizeInboundContext } from "./inbound-context.js";

export function createPluginCommandDispatchState(
  params: HandleCommandsParams,
  toolsAllow: string[],
): Parameters<typeof runWithCommandNativeSubagents>[0] {
  const entry = expectDefined(params.sessionEntry, "command session");
  return {
    cfg: params.cfg,
    ctx: finalizeInboundContext(params.ctx),
    sessionAgentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionStoreEntry: { sessionKey: params.sessionKey, entry },
    params: {
      replyOptions: {
        runId: "command-turn",
        operatorAuthority: getCommandOwnerAuthority(params.ctx)?.operatorAuthority,
        toolsAllow,
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
          input: { text: params.command.commandBodyNormalized },
          target: {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            sessionEntry: entry,
            storePath: params.storePath,
            config: params.cfg,
          },
        }),
      },
    },
    turnAdoption: undefined,
    getPreDispatchAbortSignal: () => undefined,
    getDispatchAbortSignal: () => params.opts?.abortSignal,
    assertProgressCurrent: () => {},
    assertCurrentBindingRoute: async () => {},
  };
}

export function createPluginCommandInvocation(params: HandleCommandsParams, toolsAllow: string[]) {
  const state = createPluginCommandDispatchState(params, toolsAllow);
  const recorder = expectDefined(state.params.replyOptions?.userTurnTranscriptRecorder, "recorder");
  params.opts = {
    withCommandNativeSubagents: (binding, run) =>
      runWithCommandNativeSubagents(state, binding, run),
  };
  return { params, state, recorder, run: () => handlePluginCommand(params, true) };
}

export function createPersistedPluginCommandParams(
  cfg: OpenClawConfig,
  inbound: MsgContext,
  { workspaceDir }: { workspaceDir: string },
  sessionKey: string,
  storePath: string,
) {
  return (body = "/review-panel") => {
    const value = buildCommandTestParams(
      body,
      cfg,
      {
        ...inbound,
        Body: body,
        CommandBody: body,
        RawBody: body,
        // The fixture ingress was created with plain text; project this as the
        // authenticated command turn, as real command dispatch does.
        CommandAuthorized: true,
        CommandTurn: undefined,
      },
      { workspaceDir },
    );
    value.sessionKey = sessionKey;
    value.storePath = storePath;
    value.sessionEntry = expectDefined(
      loadSessionEntry({ agentId: "main", sessionKey, storePath }),
      "persisted command requester",
    );
    return value;
  };
}
