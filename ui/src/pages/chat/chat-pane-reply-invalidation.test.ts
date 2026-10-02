/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";
beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);
describe("background reply transcript invalidation", () => {
  it.each([
    { eventName: "session.message", active: false, eventActive: false },
    { eventName: "sessions.changed", active: false, eventActive: false },
    { eventName: "session.message", active: true, eventActive: true },
    { eventName: "session.message", active: true, eventActive: false },
  ] as const)(
    "retains a background reply across $eventName during a history read (active: $active → $eventActive)",
    async ({ eventName, active, eventActive }) => {
      const runId =
        "announce:requester-settle:main:agent:main:dashboard:source-reply:child:yield-1";
      const row: GatewaySessionRow = {
        key: "agent:main:dashboard:source-reply",
        agentId: "main",
        sessionId: "source-reply-session",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: active,
        status: active ? "running" : "done",
        activeRunIds: active ? [runId] : [],
        lastRunId: runId,
        activeLeafEntryId: "leaf-a",
      };
      const committedRow: GatewaySessionRow = {
        ...row,
        updatedAt: 2,
        activeLeafEntryId: "source-reply",
        hasActiveRun: eventActive,
        status: eventActive ? "running" : "done",
        activeRunIds: eventActive ? [runId] : [],
      };
      const reply = {
        role: "assistant",
        api: "openclaw-transcript",
        provider: "openclaw",
        model: "delivery-mirror",
        stopReason: "stop",
        content: [{ type: "text", text: "Synthetic audit complete: three checks passed." }],
        __openclaw: { id: "source-reply", seq: 2, runId },
      };
      const stale = createDeferred<ChatHistoryResult>();
      const readStarted = createDeferred();
      let phase: "initial" | "reading" | "committed" = "initial";
      const history = vi.fn<GatewayRequestHandler>(() => {
        if (phase === "reading") {
          readStarted.resolve();
          return stale.promise;
        }
        return {
          messages: phase === "committed" ? [reply] : [],
          sessionId: row.sessionId,
          sessionInfo: phase === "committed" ? committedRow : row,
        };
      });
      const { sessions, mount, emitGatewayEvent } = createMountedPanes([row], "main", undefined, {
        "chat.history": history,
        "chat.startup": history,
      });
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(row.key);
      await refreshPane(pane);
      if (active) {
        adoptStartedChatRun(pane.state, runId, 1);
      }
      expect(pane.state.chatRunId).toBe(active ? runId : null);
      const readsBeforeCommit = history.mock.calls.length;
      phase = "reading";
      const oldRead = loadChatHistory(pane.state, { deferBranches: true });
      await readStarted.promise;
      phase = "committed";
      emitGatewayEvent(eventName, {
        sessionKey: row.key,
        agentId: "main",
        sessionId: row.sessionId,
        phase: "message",
        hasActiveRun: eventActive,
        session: committedRow,
        ...(eventName === "session.message"
          ? { runId, message: reply, messageId: "source-reply", messageSeq: 2 }
          : {}),
      });
      if (active) {
        expect(pane.state.chatMessages).toContainEqual(reply);
      }
      const pending = getChatHistoryLoadState(pane.state);
      stale.resolve({
        messages: [],
        sessionId: row.sessionId,
        sessionInfo: { ...row, activeLeafEntryId: "leaf-b" },
      });
      await oldRead;
      if (pending.phase === "in-flight") {
        await (pending.refresh?.promise ?? pending.promise);
      }
      expect(pane.state.chatMessages).toEqual([reply]);
      expect(history).toHaveBeenCalledTimes(readsBeforeCommit + 2);
      await refreshPane(pane);
      expect(pane.state.chatMessages).toEqual([reply]);
    },
  );
});
