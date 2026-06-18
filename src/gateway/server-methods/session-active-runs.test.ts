import { describe, expect, it } from "vitest";
import { collectTrackedActiveSessionRunSnapshot } from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

function contextWithRuns(
  runs: Array<
    [
      string,
      {
        sessionId: string;
        sessionKey: string;
        agentId?: string;
        ownerConnId?: string;
        kind?: "chat-send" | "agent";
        startedAtMs?: number;
        expiresAtMs?: number;
        controlUiVisible?: boolean;
        projectSessionActive?: boolean;
        projectSessionTerminalPending?: boolean;
        projectSessionTerminalPersisted?: boolean;
      },
    ]
  >,
): Partial<Pick<GatewayRequestContext, "chatAbortControllers">> {
  return {
    chatAbortControllers: new Map(
      runs.map(([runId, run]) => [
        runId,
        {
          controller: new AbortController(),
          startedAtMs: 1_000,
          expiresAtMs: 10_000,
          ...run,
        },
      ]),
    ),
  };
}

describe("collectTrackedActiveSessionRunSnapshot", () => {
  it("projects visible active runs without exposing abort controllers", () => {
    const snapshot = collectTrackedActiveSessionRunSnapshot({
      context: contextWithRuns([
        [
          "run-visible",
          {
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            agentId: "main",
            ownerConnId: "conn-1",
            kind: "agent",
            startedAtMs: 1_000,
            expiresAtMs: 11_000,
            projectSessionTerminalPending: true,
          },
        ],
        [
          "run-hidden",
          {
            sessionId: "session-hidden",
            sessionKey: "agent:main:main",
            controlUiVisible: false,
          },
        ],
      ]),
      requestedKey: "agent:main:main",
      canonicalKey: "agent:main:main",
      now: 6_000,
    });

    expect(snapshot).toEqual({
      hasActiveRun: true,
      runs: [
        {
          runId: "run-visible",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          ownerConnId: "conn-1",
          kind: "agent",
          startedAtMs: 1_000,
          expiresAtMs: 11_000,
          startedAgeMs: 5_000,
          expiresInMs: 5_000,
          terminalPending: true,
        },
      ],
    });
  });

  it("matches global sessions by requested agent id", () => {
    const context = contextWithRuns([
      [
        "run-main",
        {
          sessionId: "session-main",
          sessionKey: "global",
          agentId: "main",
        },
      ],
      [
        "run-work",
        {
          sessionId: "session-work",
          sessionKey: "global",
          agentId: "work",
          projectSessionTerminalPersisted: true,
        },
      ],
    ]);

    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "global",
        canonicalKey: "global",
        agentId: "work",
        defaultAgentId: "main",
        now: 2_000,
      }).runs,
    ).toEqual([
      expect.objectContaining({
        runId: "run-work",
        sessionId: "session-work",
        terminalPersisted: true,
      }),
    ]);
  });
});
