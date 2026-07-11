import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Gateway RPC handlers for the operator killswitch: pause/resume agent runs
// gateway-wide without stopping the process itself. Used by `openclaw
// killswitch` (CLI, direct/SSH operator access) and the Signal fast-path
// (src/auto-reply/reply/killswitch-command.ts) reads/writes the same
// persisted state directly since it runs in-process ahead of the LLM.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  engageKillswitchSync,
  getKillswitchStatusSync,
  releaseKillswitchSync,
} from "../../infra/killswitch.js";
import { abortTrackedChatRunById } from "../chat-abort.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeKillswitchReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? truncateUtf16Safe(value.trim(), 200)
    : undefined;
}

function requireAdminScope(
  client: Parameters<GatewayRequestHandlers[string]>[0]["client"],
): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

/** Aborts every active RPC-tracked chat run. Channel-triggered (embedded) runs
 * are aborted separately by the killswitch fast-path itself. */
function abortAllActiveChatRuns(
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
): number {
  let aborted = 0;
  for (const [runId, entry] of context.chatAbortControllers) {
    if (entry.controller.signal.aborted) {
      continue;
    }
    const result = abortTrackedChatRunById(
      {
        chatAbortControllers: context.chatAbortControllers,
        chatRunBuffers: context.chatRunBuffers,
        chatRunState: {
          abortedRuns: context.chatAbortedRuns,
          clearRun: context.clearChatRunState,
        },
        removeChatRun: context.removeChatRun,
        agentRunSeq: context.agentRunSeq,
        broadcast: context.broadcast,
        nodeSendToSession: context.nodeSendToSession,
      },
      { runId, sessionKey: entry.sessionKey, stopReason: "killswitch" },
    );
    if (result.aborted) {
      aborted += 1;
    }
  }
  return aborted;
}

/** Gateway request handlers for the operator killswitch. */
export const killswitchHandlers: GatewayRequestHandlers = {
  "killswitch.status": async ({ respond }) => {
    respond(true, getKillswitchStatusSync());
  },
  "killswitch.enable": async ({ respond, params, client, context }) => {
    if (!requireAdminScope(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `killswitch.enable requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const reason = normalizeKillswitchReason(
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>).reason
        : undefined,
    );
    engageKillswitchSync({ reason, source: "cli" });
    const aborted = abortAllActiveChatRuns(context);
    respond(true, { ...getKillswitchStatusSync(), abortedRunCount: aborted });
  },
  "killswitch.disable": async ({ respond, client }) => {
    if (!requireAdminScope(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `killswitch.disable requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    releaseKillswitchSync({ source: "cli" });
    respond(true, getKillswitchStatusSync());
  },
};
