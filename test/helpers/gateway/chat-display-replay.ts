import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatEvent } from "../../../packages/gateway-protocol/src/index.js";
import { readSessionChangedEvent } from "../../../ui/src/lib/sessions/reconcile.ts";
import { handleChatGatewayEvent } from "../../../ui/src/pages/chat/chat-gateway.ts";
import {
  activeHistory,
  createState,
} from "../../../ui/src/pages/chat/chat-history.inflight.test-support.ts";
import { applySessionMessagePayload } from "../../../ui/src/pages/chat/session-message-apply.ts";

export type ChatDisplayFrame =
  | { event: "chat"; payload: ChatEvent }
  | { event: "session.message"; payload: unknown };

/** Replay the wire order: saved messages and terminals can both retire live text. */
export function replayChatDisplay(frames: ChatDisplayFrame[], sessionKey: string, runId: string) {
  const state = createState(activeHistory(runId));
  state.sessionKey = sessionKey;
  state.chatRunId = runId;
  for (const frame of frames) {
    const { payload } = frame;
    if (frame.event === "chat") {
      if (frame.payload.sessionKey === sessionKey && frame.payload.runId === runId) {
        handleChatGatewayEvent(state, frame.payload);
      }
    } else if (isRecord(payload) && payload.sessionKey === sessionKey) {
      applySessionMessagePayload(
        state,
        payload,
        readSessionChangedEvent(payload)?.hasActiveRun ?? undefined,
        { kind: "live", activeRunId: state.chatRunId },
      );
    }
  }
  return state;
}
