/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("mounted pane run settlement", () => {
  it.each(["session.message", "sessions.changed"] as const)(
    "reconciles a missed earlier terminal from %s without navigating",
    async (event) => {
      const running: GatewaySessionRow = {
        key: "agent:main:resumed",
        agentId: "main",
        sessionId: "resumed-session",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["earlier-run"],
        status: "running",
      };
      const idle: GatewaySessionRow = {
        ...running,
        updatedAt: 2,
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "resumed-run",
        status: "done",
      };
      const finalMessage = {
        role: "assistant",
        content: "Workspace cleanup is complete.",
        __openclaw: { id: "cleanup-final", seq: 1, runId: "resumed-run", runTerminal: true },
      };
      const completed: ChatHistoryResult = {
        messages: [finalMessage],
        sessionInfo: idle,
        sessionId: idle.sessionId,
      };
      const reply = createDeferred<ChatHistoryResult>();
      const historyStarted = createDeferred();
      let recovering = false;
      const history: GatewayRequestHandler = () => {
        if (recovering) {
          historyStarted.resolve();
          return reply.promise;
        }
        return {
          messages: [],
          sessionInfo: running,
          sessionId: running.sessionId,
          inFlightRun: { runId: "earlier-run", text: "Working on cleanup.", startedAt: 1 },
        };
      };
      const rows = [running];
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
        "chat.history": history,
        "chat.startup": history,
      });
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(running.key);
      await refreshPane(pane);
      const state = pane.state;
      state.chatMessage = "Keep my unsent draft.";
      expect(state.chatRunId).toBe("earlier-run");
      expect(state.chatStream).toBe("Working on cleanup.");
      expect(hasAbortableSessionRun(state)).toBe(true);
      try {
        recovering = true;
        rows.splice(0, 1, idle);
        emitGatewayEvent(event, {
          sessionKey: idle.key,
          agentId: idle.agentId,
          sessionId: idle.sessionId,
          session: idle,
          clientRunId: "resumed-run",
          hasActiveRun: false,
          activeRunIds: [],
          ...(event === "session.message"
            ? { message: finalMessage, messageId: "cleanup-final", messageSeq: 1 }
            : { reason: "lifecycle" }),
        });
        const pending = getChatHistoryLoadState(state);
        expect(pending.phase).toBe("in-flight");
        if (pending.phase !== "in-flight") {
          throw new Error("Completion must automatically refresh the mounted chat");
        }
        await historyStarted.promise;
        expect(state.chatRunId).toBe("earlier-run");
        reply.resolve(completed);
        await pending.promise;
        expect(state.chatRunId).toBeNull();
        expect(state.chatStream).toBeNull();
        expect(state.chatStreamStartedAt).toBeNull();
        expect(hasAbortableSessionRun(state)).toBe(false);
        expect(state.chatMessage).toBe("Keep my unsent draft.");
        expect(state.chatMessages).toEqual([finalMessage]);
        expect(state.sessionKey).toBe(running.key);
      } finally {
        const pending = getChatHistoryLoadState(state);
        reply.resolve(completed);
        if (pending.phase === "in-flight") {
          await pending.promise;
          await pending.refresh?.promise;
        }
      }
    },
  );
});
