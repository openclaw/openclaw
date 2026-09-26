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

it.each(["hidden document", "reconnect history"])(
  "defers successful read settlement until %s is presented",
  async (deferredBy) => {
    const key = "agent:main:read-admission";
    const sessionId = "read-admission";
    const rows: [GatewaySessionRow] = [
      { key, agentId: "main", sessionId, kind: "direct", updatedAt: 10, unread: false },
    ];
    const firstAck = createDeferred<SessionsPatchResult>();
    const laterAck = createDeferred<SessionsPatchResult>();
    const laterAckStarted = createDeferred();
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
      "sessions.patch": () => {
        acknowledgements += 1;
        if (acknowledgements === 1) {
          return firstAck.promise;
        }
        laterAckStarted.resolve();
        return laterAck.promise;
      },
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
        rows[0] = { ...rows[0], updatedAt, unread: true };
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
      if (deferredBy === "hidden document") {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        holdHistory = true;
        const snapshot = { ...pane.context.gateway.snapshot };
        pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
        await historyStarted.promise;
        expect(getChatHistoryLoadState(pane.state).phase).toBe("in-flight");
      }
      expect(acknowledgements).toBe(1);
      firstAck.resolve(receipt);
      await expect(firstPatch.value).resolves.toMatchObject({ ok: true });
      expect(acknowledgements).toBe(1);
      expect(sessions.state.result?.sessions[0]?.unread).toBe(true);

      if (deferredBy === "hidden document") {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        const load = getChatHistoryLoadState(pane.state);
        expect(load.phase).toBe("in-flight");
        if (load.phase !== "in-flight") {
          throw new Error("Expected reconnect history to remain pending");
        }
        reconnectHistory.resolve({ messages: [], sessionId, sessionInfo: rows[0] });
        await load.promise;
      }
      await pane.updateComplete;
      await vi.advanceTimersByTimeAsync(32);
      await laterAckStarted.promise;
      expect(acknowledgements).toBe(2);
      expect(sessions.state.result?.sessions[0]?.unread).toBe(false);
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
