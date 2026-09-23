// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

const clients = [{ id: "cli", mode: "cli", displayName: "Release helper" }];
const baseMessage = {
  role: "user",
  content: "[System] Continue the interrupted turn.",
  timestamp: 1000,
  __openclaw: { id: "input-1", seq: 2, idempotencyKey: "run:user", transport: { clients } },
};

function pending(message: object): ChatPendingInputsPage["items"] {
  return [
    {
      id: "input-1",
      runId: "run",
      acceptedAt: 1000,
      state: "queued",
      message: { ...message, __openclaw: { id: "pending:input-1", transport: { clients } } },
    },
  ];
}

function render(
  messages: unknown[],
  pendingInputs: ChatPendingInputsPage["items"],
  searchQuery = "",
) {
  return buildCachedChatItems({
    paneId: "notices",
    sessionKey: "main",
    messages,
    pendingInputs,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    searchOpen: Boolean(searchQuery),
    searchQuery,
  });
}

afterEach(() => resetChatThreadState());

describe("system notices through pending-to-history promotion", () => {
  it.each([
    [
      "main_session_restart_recovery",
      "System · restart recovery",
      "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.",
      false,
    ],
    [
      "restart-sentinel",
      "System · gateway restarted",
      "Gateway restarted during update 2026.8.2 -> 2026.8.3.",
      false,
    ],
    [
      "cli_harness_context",
      "System · injected context",
      "Base directory for this skill: /tmp/skills/autoreview\n\n# Auto Review",
      true,
    ],
    [
      "claude_cli_task_notification",
      "System · background task",
      "<task-notification>\n<status>completed</status>\n</task-notification>",
      true,
    ],
    ...[
      undefined,
      "session-companion",
      "heartbeat",
      "main-session-restart-recovery",
      "restart_sentinel",
      " restart-sentinel ",
    ].map((sourceTool) => [sourceTool, "System", "Keep the raw fallback copy.", false] as const),
  ] as const)(
    "preserves %s presentation, search and turn boundaries",
    (sourceTool, label, text, midTurn) => {
      const imported = sourceTool === "cli_harness_context";
      const message = {
        ...baseMessage,
        content:
          sourceTool === "main_session_restart_recovery"
            ? baseMessage.content
            : (midTurn ? "" : "[System] ") + text,
        provenance: { kind: "internal_system", sourceTool },
        __openclaw: imported
          ? {
              id: "input-1",
              importedFrom: "claude-cli",
              cliSessionId: "cli-1",
              externalId: "input-1",
              transport: { clients },
            }
          : baseMessage["__openclaw"],
      };
      const inputs = pending(message);
      const before = { role: "user", content: "before", timestamp: 999 };
      const after = {
        role: "assistant",
        content: "after",
        timestamp: 1001,
        __openclaw: { runId: "run" },
      };
      const stages = [
        [before, after],
        [before, message, after],
      ];
      // Promotion must not be separated by search, which evicts the pending notice.
      for (const [stage, messages] of stages.entries()) {
        const items = render(messages, inputs);
        const canonicalOrder = [
          { kind: "group", role: "user", messages: [{ message: before }] },
          { kind: "notice", icon: "cpu", label, text, timestamp: 1000 },
          { kind: "group", role: "assistant", messages: [{ message: after }] },
        ];
        expect(items).toMatchObject(
          stage === 1 ? canonicalOrder : [canonicalOrder[0], canonicalOrder[2], canonicalOrder[1]],
        );
        const notice = items.find((item) => item.kind === "notice");
        if (notice?.kind !== "notice") {
          throw new Error("Expected one system notice");
        }
        expect(notice.startsTurn).toBe(midTurn ? undefined : true);
        expect(notice.collapsedBody).toBe(midTurn ? true : undefined);
        expect(
          coalesceAgentRunFrames(items).filter((item) => item.kind === "agent-run-frame"),
        ).toMatchObject(
          stage === 1 && !midTurn
            ? [{ runId: "run", boundaryId: "send:run", parts: [items[2]] }]
            : [],
        );
        expect(notice.boundaryId).toBe(stage === 1 && !imported ? "send:run" : undefined);
      }
      for (const messages of stages) {
        expect(render(messages, inputs, "after")).toMatchObject([
          { kind: "group", role: "assistant", messages: [{ message: after }] },
        ]);
      }
    },
  );

  it("keeps a user's System prefix and sender attribution through promotion", () => {
    const inputs = pending(baseMessage);
    for (const consumed of [false, true]) {
      expect(render(consumed ? [baseMessage] : [], inputs)).toMatchObject([
        {
          kind: "group",
          role: "user",
          sourceClients: clients,
          messages: [{ message: consumed ? baseMessage : inputs[0]?.message }],
        },
      ]);
    }
  });
});
