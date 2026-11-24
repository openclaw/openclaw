import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatLiveTools } from "./chat-live-tools.ts";
import { isChatRunStartupPhase, reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import { knownStreamCausalInterval } from "./stream-causal-boundary.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";
import { bindTextBeforeRootTool } from "./tool-stream-preamble.ts";
import { acceptsToolStreamSession } from "./tool-stream-status.ts";

/** A native call is the witness for its preceding text, even when a later reply repeats it. */
function reconcileNativeToolPreambles(
  state: ChatState,
  runId: string,
  snapshot: string,
  starts: ReadonlyMap<string, number> | undefined,
) {
  const segments = state.chatStreamSegments;
  if (!snapshot && !segments.length) {
    return;
  }
  const messages = state.chatMessages;
  const interval = knownStreamCausalInterval(messages, runId);
  // A page can start mid-turn. Only an accepted root call can identify its native text there.
  if (!interval && !starts?.size) {
    return;
  }
  const imported = new Map<string, string>();
  const preceding: string[] = [];
  let covered = 0;
  for (const message of interval ? messages.slice(interval.start, interval.end) : messages) {
    const identity = readSessionMessageIdentity(message);
    if (!interval && identity?.role === "user") {
      break;
    }
    if (
      asOptionalRecord(message)?.provider !== "claude-cli" ||
      !identity?.isImported ||
      identity.role !== "assistant" ||
      (identity.runId && identity.runId !== runId)
    ) {
      preceding.length = 0;
      continue;
    }
    const text = extractText(message)?.trim();
    if (text) {
      preceding.push(text);
    }
    const [call] = extractToolMessageRefs(message);
    if (!call) {
      continue;
    }
    const end = starts?.get(call.id);
    if (preceding.length && (!starts || end !== undefined)) {
      const preamble = preceding.join("\n\n");
      imported.set(call.id, preamble);
      if (
        end &&
        end > covered &&
        end <= snapshot.length &&
        snapshot.slice(covered, end).trim() === preamble
      ) {
        covered = end;
      }
    }
    preceding.length = 0;
  }
  if (!imported.size) {
    return;
  }
  const prefix = snapshot.slice(0, covered);
  const durable = state.chatStream?.startsWith(prefix) ? prefix : "";
  const retained = segments.filter(({ runId: owner, toolCallId, itemId, text }) => {
    const native = toolCallId && imported.get(toolCallId);
    if (owner !== runId || !native) {
      return true;
    }
    // One native occurrence can replace only one matching independent commentary item.
    return itemId
      ? native !== text.trim() || !imported.delete(toolCallId)
      : !durable || !durable.startsWith(text);
  });
  if (
    durable &&
    !retained.some((part) => part.persisted && part.runId === runId && part.text === durable)
  ) {
    retained.push({
      runId,
      text: durable,
      ts: state.chatStreamStartedAt ?? Date.now(),
      persisted: true,
    });
  } else if (retained.length === segments.length) {
    return;
  }
  state.chatStreamSegments = retained;
}

/** Restore ordered progress only after the caller has accepted the history read and its run. */
export async function prepareCheckpointReplay(run: NonNullable<ChatHistoryResult["inFlightRun"]>) {
  const events = run.events?.filter((event) => event.runId === run.runId);
  const tools = events?.length ? await loadChatLiveTools() : undefined;
  return (
    state: ChatHistoryHost,
    runId: string,
    text: string,
    markObservedActivity: (hasStartup: boolean) => boolean,
    usesSnapshotText: boolean,
  ) => {
    const startup = run.events?.findLast(
      (event) => event.runId === runId && event.stream === "run_status",
    );
    const phase = startup?.data.phase;
    if (phase === "waiting_for_model" || !markObservedActivity(Boolean(startup))) {
      if (startup && isChatRunStartupPhase(phase)) {
        reconcileChatRunStartup(state, {
          state: "status",
          runId,
          phase,
          ...(phase === "waiting_for_model"
            ? {
                waitReason:
                  startup.data.reason === "slot" ? ("slot" as const) : ("response" as const),
              }
            : {}),
          seq: startup.seq,
        });
      }
    }
    if (state.chatRunId !== run.runId) {
      return;
    }
    // Live owners enforce event ordering. Only native start receipts can match imported prose.
    let starts: Map<string, number> | undefined;
    for (const event of events ?? []) {
      tools?.handleAgentEvent(state, event, "history");
      const { stream, data } = event;
      if (
        stream === "tool" &&
        data.phase === "start" &&
        !data.parentToolCallId &&
        typeof data.toolCallId === "string" &&
        acceptsToolStreamSession(state, event)
      ) {
        (starts ??= new Map()).set(
          data.toolCallId,
          typeof data.bufferEnd === "number" ? data.bufferEnd : 0,
        );
        // A previously admitted start can still own a span in the newly adopted snapshot.
        if (usesSnapshotText && typeof data.bufferEnd === "number") {
          const entry = state.toolStreamById.get(buildToolStreamIdentity(runId, data.toolCallId));
          if (entry && !entry.parentToolCallId) {
            bindTextBeforeRootTool(state, entry, data.bufferEnd);
          }
        }
      }
    }
    // Older gateways can omit the event list; an explicitly empty or status-only list proves no start.
    if (starts || !events) {
      // A saved span applies to the snapshot buffer, never to a newer live occurrence.
      reconcileNativeToolPreambles(state, run.runId, usesSnapshotText ? text : "", starts);
    }
  };
}
