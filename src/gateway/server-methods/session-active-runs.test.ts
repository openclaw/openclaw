// Tests gateway active-run matching by logical session key and backing id.
import { describe, expect, it } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import {
  collectTrackedActiveSessionRunSnapshot,
  hasVisibleActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

function contextWithRuns(
  runs: Array<
    [
      string,
      {
        sessionId?: string;
        sessionKey?: string;
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
    ) as GatewayRequestContext["chatAbortControllers"],
  };
}

describe("session active runs", () => {
  it("matches session-id-only gateway runs during archive admission", () => {
    const context = contextWithRuns([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]);

    expect(
      hasVisibleActiveSessionRun({
        context,
        requestedKey: "agent:main:child",
        canonicalKey: "agent:main:child",
        sessionId: "session-1",
      }),
    ).toBe(true);
  });

  it("returns deterministic visible run ids for the selected session", () => {
    const context = contextWithRuns([
      ["run-z", { sessionKey: "main" }],
      ["run-hidden", { sessionKey: "main", controlUiVisible: false }],
      ["run-other", { sessionKey: "other" }],
      ["run-a", { sessionKey: "main" }],
    ]);

    expect(
      resolveVisibleActiveSessionRunState({
        context,
        requestedKey: "main",
        canonicalKey: "main",
      }),
    ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
  });

  it("projects a lifecycle-owned worker run without widening event visibility", () => {
    registerAgentRunContext("worker-run", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionId: "worker-session",
      sessionKey: "agent:main:worker",
    });
    try {
      expect(
        resolveVisibleActiveSessionRunState({
          context: {},
          requestedKey: "agent:main:worker",
          canonicalKey: "agent:main:worker",
          sessionId: "worker-session",
        }),
      ).toEqual({ active: true, runIds: [] });
    } finally {
      clearAgentRunContext("worker-run");
    }
  });
});

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

  it("keeps unknown fallback active runs unscoped by default", () => {
    const context = contextWithRuns([
      [
        "run-main",
        {
          sessionId: "session-main",
          sessionKey: "unknown",
          agentId: "main",
        },
      ],
      [
        "run-work",
        {
          sessionId: "session-work",
          sessionKey: "unknown",
          agentId: "work",
        },
      ],
    ]);

    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "unknown",
        canonicalKey: "unknown",
        agentId: "work",
        defaultAgentId: "main",
        now: 2_000,
      }).runs,
    ).toEqual([
      expect.objectContaining({
        runId: "run-main",
        sessionId: "session-main",
        agentId: "main",
      }),
      expect.objectContaining({
        runId: "run-work",
        sessionId: "session-work",
        agentId: "work",
      }),
    ]);
  });

  it("matches unknown fallback sessions by requested agent id when scoped", () => {
    const context = contextWithRuns([
      [
        "run-main",
        {
          sessionId: "session-main",
          sessionKey: "unknown",
          agentId: "main",
        },
      ],
      [
        "run-work",
        {
          sessionId: "session-work",
          sessionKey: "unknown",
          agentId: "work",
        },
      ],
    ]);

    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "unknown",
        canonicalKey: "unknown",
        agentId: "work",
        defaultAgentId: "main",
        scopeUnknownByAgent: true,
        now: 2_000,
      }).runs,
    ).toEqual([
      expect.objectContaining({
        runId: "run-work",
        sessionId: "session-work",
        agentId: "work",
      }),
    ]);
  });
});
