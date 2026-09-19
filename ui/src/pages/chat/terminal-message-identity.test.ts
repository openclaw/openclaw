import { describe, expect, it } from "vitest";
import {
  armPendingAuthoritativeTerminalForHistory,
  reconcileAuthoritativeTerminalHistory,
  rememberAuthoritativeTerminal,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

function persistedFinal() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Final answer" }],
    __openclaw: { id: "final-message" },
  };
}

describe("deferred authoritative terminals", () => {
  it("retires the live copy once the run clears after an active-run persist", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );

    // The persisted final lands while the run still reads active: without a
    // deferred record the live copy has no dedup owner yet (#149153).
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([liveTerminal]);

    // The history reload that carries the persisted terminal arms the deferred
    // record, so that same reconcile retires the live copy instead of stacking
    // two renders — this is the path chat.final already reaches.
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [persistedFinal()],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });

  it("keeps the deferred terminal pending until its own history arrives", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });

    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Other reply" }],
          __openclaw: { id: "other-message" },
        },
      ],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([liveTerminal]);

    // The owning terminal's own history still retires it.
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [persistedFinal()],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });

  it("ignores a commentary row while an active run persists", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );
    // Mid-turn commentary must never claim the run's final reply: a run-wide
    // suppression flag set from commentary would hide the real final (#149153).
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "thinking out loud",
              textSignature: JSON.stringify({
                v: 1,
                id: "commentary-0",
                phase: "commentary",
              }),
            },
          ],
          __openclaw: { id: "commentary-message" },
        },
        messageId: "commentary-message",
      },
      runIdBeforeApply: "run-1",
    });

    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "thinking out loud" }],
          __openclaw: { id: "commentary-message" },
        },
      ],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "thinking out loud" }],
            __openclaw: { id: "commentary-message" },
          },
        ],
      }),
    ).toEqual([liveTerminal]);
  });

  it("retires each run's live copy when two active runs persist in sequence", () => {
    const host = {};
    const firstLive = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      "run-1",
    );
    const secondLive = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
      "run-2",
    );
    const persist = (runId: string, messageId: string, text: string) =>
      rememberAuthoritativeTerminal({
        event: { key: "main", runId, hasActiveRun: true },
        host,
        matchesChat: true,
        payload: {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            __openclaw: { id: messageId },
          },
          messageId,
        },
        runIdBeforeApply: runId,
      });
    persist("run-1", "first-message", "First answer");
    persist("run-2", "second-message", "Second answer");

    const first = {
      role: "assistant",
      content: [{ type: "text", text: "First answer" }],
      __openclaw: { id: "first-message" },
    };
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [first],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [firstLive, secondLive],
        sessionKey: "main",
        visibleMessages: [first],
      }),
    ).toEqual([secondLive]);

    // The second run's pending survived the first promotion.
    const second = {
      role: "assistant",
      content: [{ type: "text", text: "Second answer" }],
      __openclaw: { id: "second-message" },
    };
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [second],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [secondLive],
        sessionKey: "main",
        visibleMessages: [second],
      }),
    ).toEqual([]);
  });

  it("still arms immediately when the run is already clear", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });

    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });
});
