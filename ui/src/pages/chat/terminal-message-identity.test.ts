// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAgentMainSessionKey, DEFAULT_MAIN_KEY } from "../../lib/sessions/session-key.ts";
import {
  armPendingAuthoritativeTerminalForHistory,
  authoritativeHistoryAppliedForRun,
  authoritativeTerminalFencedBySteer,
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

    // An unrelated history page must not promote the pending record: only the
    // page that actually carries the terminal owns its retirement (#149153).
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

    // The first page promotes run-1 only; run-2's pending must survive it.
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

    // The second page then retires the surviving run.
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

  it("never lets a tool continuation claim the run's final", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Real answer" }] },
      "run-1",
    );
    // A persisted continuation row: text plus a tool invocation. Owning it would
    // suppress the run's real final when chat.final replays (#149153).
    const continuation = {
      role: "assistant",
      content: [
        { type: "text", text: "checking the file" },
        { type: "toolCall", id: "call-1", name: "read_file", input: {} },
      ],
      __openclaw: { id: "continuation-message" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: continuation, messageId: "continuation-message" },
      runIdBeforeApply: "run-1",
    });
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [continuation],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [continuation],
      }),
    ).toEqual([liveTerminal]);

    // The run's real text-only final still owns retirement when it lands,
    // even when its stop reason is a tool turn boundary.
    const final = {
      role: "assistant",
      content: [{ type: "text", text: "Real answer" }],
      stopReason: "toolUse",
      __openclaw: { id: "final-message" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: final, messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [continuation, final],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [continuation, final],
      }),
    ).toEqual([]);
  });

  it("keeps another session's live copy when the host reused a run id", () => {
    const host = {};
    // Session A retires run-1 through its own history.
    const aFinal = {
      role: "assistant",
      content: [{ type: "text", text: "A answer" }],
      __openclaw: { id: "a-final" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "agent:a:1", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: aFinal, messageId: "a-final" },
      runIdBeforeApply: "run-1",
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [],
        sessionKey: "agent:a:1",
        visibleMessages: [aFinal],
      }),
    ).toEqual([]);
    // The same host on session B, reusing the run id, must keep its live copy:
    // applied records are scoped by session, not just by host (#149153).
    const liveB = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "B answer" }] },
      "run-1",
    );
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveB],
        sessionKey: "agent:b:2",
        visibleMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "B answer" }],
            __openclaw: { id: "b-final" },
          },
        ],
      }),
    ).toEqual([liveB]);
  });

  it("scopes the applied flag to its own session for chat.final replays", () => {
    const host = {};
    const aFinal = {
      role: "assistant",
      content: [{ type: "text", text: "A answer" }],
      __openclaw: { id: "a-final" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "agent:a:1", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: aFinal, messageId: "a-final" },
      runIdBeforeApply: "run-1",
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [],
        sessionKey: "agent:a:1",
        visibleMessages: [aFinal],
      }),
    ).toEqual([]);
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "agent:a:1")).toBe(true);
    // The same host on session B reusing the run id must not borrow A's flag:
    // B's real final would be discarded as a replay at the gateway (#149153).
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "agent:b:2")).toBe(false);
  });

  it("keeps both sessions' applied flags when they reuse a run id", () => {
    const host = {};
    const armApplied = (sessionKey: string, finalId: string) => {
      const final = {
        role: "assistant",
        content: [{ type: "text", text: `Answer ${finalId}` }],
        __openclaw: { id: finalId },
      };
      rememberAuthoritativeTerminal({
        event: { key: sessionKey, runId: "run-1", hasActiveRun: false },
        host,
        matchesChat: true,
        payload: { message: final, messageId: finalId },
        runIdBeforeApply: "run-1",
      });
      expect(
        reconcileAuthoritativeTerminalHistory({
          host,
          previousMessages: [],
          sessionKey,
          visibleMessages: [final],
        }),
      ).toEqual([]);
    };
    armApplied("agent:a:1", "a-final");
    armApplied("agent:b:2", "b-final");
    // Session B's arm must not overwrite A's record: both flags stay valid (#149153).
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "agent:a:1")).toBe(true);
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "agent:b:2")).toBe(true);
  });

  it("still promotes another session's deferred terminal after this session applied the run id", () => {
    const host = {};
    const aFinal = {
      role: "assistant",
      content: [{ type: "text", text: "A answer" }],
      __openclaw: { id: "a-final" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "agent:a:1", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: aFinal, messageId: "a-final" },
      runIdBeforeApply: "run-1",
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [],
        sessionKey: "agent:a:1",
        visibleMessages: [aFinal],
      }),
    ).toEqual([]);
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "agent:a:1")).toBe(true);
    // Session B's deferred terminal for the same run id must still promote —
    // A's applied record must not consume B's pending or block its retirement (#149153).
    const liveB = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "B answer" }] },
      "run-1",
    );
    const bFinal = {
      role: "assistant",
      content: [{ type: "text", text: "B answer" }],
      __openclaw: { id: "b-final" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "agent:b:2", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: bFinal, messageId: "b-final" },
      runIdBeforeApply: "run-1",
    });
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "agent:b:2",
      visibleMessages: [bFinal],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveB],
        sessionKey: "agent:b:2",
        visibleMessages: [bFinal],
      }),
    ).toEqual([]);
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "agent:b:2")).toBe(true);
  });

  it("normalizes equivalent session aliases to one record identity", () => {
    const host = {};
    const canonical = buildAgentMainSessionKey({ agentId: "main", mainKey: DEFAULT_MAIN_KEY });
    const final = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      __openclaw: { id: "final-message" },
    };
    // Arm under the bare main alias; apply and query under the canonical agent key.
    rememberAuthoritativeTerminal({
      event: { key: DEFAULT_MAIN_KEY, runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: final, messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [],
        sessionKey: canonical,
        visibleMessages: [final],
      }),
    ).toEqual([]);
    // Both reads must agree on one record: a late final replay stays
    // suppressed instead of being re-admitted through an alias gap (#149153).
    expect(authoritativeHistoryAppliedForRun(host, "run-1", canonical)).toBe(true);
  });

  it("keeps the history filter and the pane cleanup on one applied snapshot past the cap", () => {
    const host = {};
    const lives: unknown[] = [];
    const page: unknown[] = [];
    for (let index = 1; index <= 65; index += 1) {
      const runId = `run-${index}`;
      lives.push(
        rememberLiveTerminalRun(
          { role: "assistant", content: [{ type: "text", text: `Answer ${index}` }] },
          runId,
        ),
      );
      rememberAuthoritativeTerminal({
        event: { key: "main", runId, hasActiveRun: true },
        host,
        matchesChat: true,
        payload: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Answer ${index}` }],
            __openclaw: { id: `final-${index}` },
          },
          messageId: `final-${index}`,
        },
        runIdBeforeApply: runId,
      });
      page.push({
        role: "assistant",
        content: [{ type: "text", text: `Answer ${index}` }],
        __openclaw: { id: `final-${index}` },
      });
    }
    armPendingAuthoritativeTerminalForHistory({ host, sessionKey: "main", visibleMessages: page });
    // One page applying 65 terminals: the filter and the pane cleanup must read
    // the same applied set — eviction happens at arm time, never in between (#149153).
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: lives,
        sessionKey: "main",
        visibleMessages: page,
      }),
    ).toEqual([]);
    for (let index = 1; index <= 65; index += 1) {
      expect(authoritativeHistoryAppliedForRun(host, `run-${index}`, "main")).toBe(true);
    }
    // The next arm trims past the cap; the oldest applied run loses its flag
    // (documented boundary, still strictly safer than the old single slot).
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-66", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Late answer" }],
          __openclaw: { id: "late-final" },
        },
        messageId: "late-final",
      },
      runIdBeforeApply: "run-66",
    });
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "main")).toBe(false);
    expect(authoritativeHistoryAppliedForRun(host, "run-2", "main")).toBe(true);
  });
});

describe("unkeyed stream projections", () => {
  it("keeps a keyed commentary segment beside the terminal", () => {
    const host = {};
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });
    // Keyed segments are live commentary keyed to items; they must survive the
    // final's retirement and keep rendering beside it (#149153).
    const keyedSegment: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: "checking the file" }],
      openclawStreamFallback: {
        replacementText: "checking the file",
        source: "segment",
        itemId: "item-0",
        runId: "run-1",
      },
    };
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [keyedSegment],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([keyedSegment]);
  });

  it("keeps projections attributed to another run", () => {
    const host = {};
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });
    const otherRunProjection: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: "Earlier partial" }],
      openclawStreamFallback: {
        replacementText: "Earlier partial",
        source: "current",
        runId: "run-0",
      },
    };
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [otherRunProjection],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([otherRunProjection]);
  });
});

describe("steer fencing", () => {
  const finalRow = {
    role: "assistant",
    content: [{ type: "text", text: "Before steer." }],
    __openclaw: { id: "pre-steer-message" },
  };
  const steerRow = {
    role: "user",
    content: [{ type: "text", text: "Steer" }],
    __openclaw: { id: "steer-1", steerTargetRunId: "run-1" },
  };
  const armApplied = (host: object) => {
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: finalRow, messageId: "pre-steer-message" },
      runIdBeforeApply: "run-1",
    });
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [finalRow],
    });
    reconcileAuthoritativeTerminalHistory({
      host,
      previousMessages: [],
      sessionKey: "main",
      visibleMessages: [finalRow],
    });
  };

  it("fences the applied terminal when a steer row follows it", () => {
    const host = {};
    armApplied(host);
    expect(
      authoritativeTerminalFencedBySteer({
        host,
        messages: [finalRow, steerRow],
        runId: "run-1",
        sessionKey: "main",
      }),
    ).toBe(true);
  });

  it("keeps the terminal when its row follows the steer", () => {
    const host = {};
    armApplied(host);
    expect(
      authoritativeTerminalFencedBySteer({
        host,
        messages: [steerRow, finalRow],
        runId: "run-1",
        sessionKey: "main",
      }),
    ).toBe(false);
  });

  it("leaves a run without a steer unfenced", () => {
    const host = {};
    armApplied(host);
    expect(
      authoritativeTerminalFencedBySteer({
        host,
        messages: [finalRow],
        runId: "run-1",
        sessionKey: "main",
      }),
    ).toBe(false);
  });

  it("still fences when the applied row is out of view", () => {
    const host = {};
    armApplied(host);
    expect(
      authoritativeTerminalFencedBySteer({
        host,
        messages: [steerRow],
        runId: "run-1",
        sessionKey: "main",
      }),
    ).toBe(true);
  });

  it("does not fence another run without a terminal record", () => {
    const host = {};
    armApplied(host);
    expect(
      authoritativeTerminalFencedBySteer({
        host,
        messages: [finalRow, steerRow],
        runId: "run-2",
        sessionKey: "main",
      }),
    ).toBe(false);
  });

  it("stops contributing an applied run id once a later read fences it", () => {
    const host = {};
    armApplied(host);
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "After steer answer" }] },
      "run-1",
    );
    // A stale read carries the applied row and the steer but not the newer
    // reply's own row: retirement must not delete that reply, on any repeat
    // of that read, and the durable replay flag must survive it (#149153).
    for (let read = 0; read < 2; read += 1) {
      expect(
        reconcileAuthoritativeTerminalHistory({
          host,
          previousMessages: [liveTerminal],
          sessionKey: "main",
          visibleMessages: [finalRow, steerRow],
        }),
      ).toEqual([liveTerminal]);
    }
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "main")).toBe(true);
  });

  it("keeps the durable applied flag when a fenced read follows convergence", () => {
    const host = {};
    armApplied(host);
    const postSteerRow = {
      role: "assistant",
      content: [{ type: "text", text: "After steer answer" }],
      __openclaw: { id: "post-steer-message" },
    };
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: postSteerRow, messageId: "post-steer-message" },
      runIdBeforeApply: "run-1",
    });
    // Converge: the newer row replaces the pre-steer record and applies.
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [finalRow, steerRow, postSteerRow],
    });
    reconcileAuthoritativeTerminalHistory({
      host,
      previousMessages: [],
      sessionKey: "main",
      visibleMessages: [finalRow, steerRow, postSteerRow],
    });
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "main")).toBe(true);
    // A later stale read that still omits the converged row must not retract
    // the durable flag: the gateway replay gate reads it (#149153).
    reconcileAuthoritativeTerminalHistory({
      host,
      previousMessages: [],
      sessionKey: "main",
      visibleMessages: [finalRow, steerRow],
    });
    expect(authoritativeHistoryAppliedForRun(host, "run-1", "main")).toBe(true);
  });
});
