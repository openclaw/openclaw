/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it.each(["visible", "hidden document", "reconnect history"])(
  "acknowledges activity newer than a successful read receipt when %s is presented",
  async (presentation) => {
    const key = "agent:main:read-admission";
    const sessionId = "read-admission";
    const rows: [GatewaySessionRow] = [
      { key, agentId: "main", sessionId, kind: "direct", updatedAt: 10, unread: false },
    ];
    const firstAck = createDeferred<SessionsPatchResult>();
    const laterAck = createDeferred<SessionsPatchResult>();
    const reconnectHistory = createDeferred<unknown>();
    const historyStarted = createDeferred();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let holdHistory = false;
    let acknowledgements = 0;
    const history = () => {
      if (holdHistory) {
        historyStarted.resolve();
        return reconnectHistory.promise;
      }
      return { messages: [], sessionId, sessionInfo: rows[0] };
    };
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
      "chat.startup": history,
      "chat.history": history,
      "sessions.patch": () => (++acknowledgements === 1 ? firstAck.promise : laterAck.promise),
    });
    const patch = vi.spyOn(sessions, "patch");
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(key);
    const receipt: SessionsPatchResult = {
      ok: true,
      key,
      path: "",
      entry: { sessionId, updatedAt: 30, lastReadAt: 30, lastActivityAt: 20 },
    };
    try {
      await refreshPane(pane);
      await pane.updateComplete;
      await vi.advanceTimersByTimeAsync(32);
      expect(getChatHistoryLoadState(pane.state).phase).toBe("committed");
      const publish = (updatedAt: number) => {
        rows[0] = { ...rows[0], updatedAt, lastActivityAt: updatedAt, unread: true };
        emitGatewayEvent("sessions.changed", {
          sessionKey: key,
          agentId: "main",
          reason: "send",
          session: rows[0],
        });
      };
      publish(20);
      expect(acknowledgements).toBe(1);
      const firstPatch = patch.mock.results[0];
      if (firstPatch?.type !== "return") {
        throw new Error("Expected the automatic acknowledgement promise");
      }
      publish(40);
      if (presentation === "hidden document") {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (presentation === "reconnect history") {
        holdHistory = true;
        const snapshot = { ...pane.context.gateway.snapshot };
        pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
        await historyStarted.promise;
        expect(getChatHistoryLoadState(pane.state).phase).toBe("in-flight");
      }
      firstAck.resolve(receipt);
      await expect(firstPatch.value).resolves.toMatchObject({ ok: true });
      if (presentation !== "visible") {
        expect(acknowledgements).toBe(1);
        expect(sessions.state.result?.sessions[0]?.unread).toBe(true);
        if (presentation === "hidden document") {
          visibility.mockReturnValue("visible");
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          const load = getChatHistoryLoadState(pane.state);
          if (load.phase !== "in-flight") {
            throw new Error("Expected reconnect history to remain pending");
          }
          reconnectHistory.resolve({ messages: [], sessionId, sessionInfo: rows[0] });
          await load.promise;
        }
      }
      await pane.updateComplete;
      await vi.advanceTimersByTimeAsync(32);
      expect(acknowledgements).toBe(2);
      expect(sessions.state.result?.sessions[0]?.unread).toBe(false);
      laterAck.resolve({ ...receipt, entry: { sessionId, updatedAt: 50, lastReadAt: 50 } });
      await Promise.all(
        patch.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
      await pane.updateComplete;
      expect(acknowledgements).toBe(2);
    } finally {
      pane.disconnectedCallback();
      firstAck.resolve(receipt);
      laterAck.resolve(receipt);
      reconnectHistory.resolve({ messages: [], sessionId, sessionInfo: rows[0] });
      await Promise.allSettled(
        patch.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
    }
  },
);
