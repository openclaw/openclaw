// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

const clients = [{ id: "cli", mode: "cli", displayName: "Release helper" }];
const baseMessage = {
  role: "user",
  content: "[System] Continue the interrupted turn.",
  timestamp: 1000,
  __openclaw: { id: "input-1", seq: 2, idempotencyKey: "run:user", transport: { clients } },
};

function pending(
  message: object,
  state: ChatPendingInputsPage["items"][number]["state"] = "queued",
): ChatPendingInputsPage["items"] {
  return [
    {
      id: "input-1",
      runId: "run",
      acceptedAt: 1000,
      state,
      message: { ...message, __openclaw: { id: "pending:input-1", transport: { clients } } },
    },
  ];
}

function render(
  messages: unknown[],
  pendingInputs: ChatPendingInputsPage["items"],
  searchQuery = "",
) {
  return buildCachedChatItems(
    createProps({
      paneId: "notices",
      messages,
      pendingInputs,
      searchOpen: Boolean(searchQuery),
      searchQuery,
    }),
  );
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
    ...[undefined, " restart-sentinel "].map(
      (sourceTool) => [sourceTool, "System", "Keep the raw fallback copy.", false] as const,
    ),
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
      if (sourceTool === "main_session_restart_recovery") {
        expect(render([], pending(message))).toMatchObject([{ kind: "notice", label }]);
        for (const state of ["interrupted", "cancelled"] as const) {
          expect(render([], pending(message, state))).toMatchObject([
            {
              kind: "notice",
              label,
              text: `The Gateway restarted. Automatic recovery was ${state} before the agent could resume. Send a message to continue.`,
              startsTurn: true,
            },
          ]);
          expect(render([message], pending(message, state))).toMatchObject([
            {
              kind: "notice",
              label,
              text,
              boundaryId: "send:run",
            },
          ]);
        }
      }
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
        const framed = coalesceAgentRunFrames(items);
        expect(framed).toContain(notice);
        // A known-run reply frames even before promotion supplies a causal boundary.
        expect(framed.filter((item) => item.kind === "agent-run-frame")).toMatchObject([
          { runId: "run", boundaryId: "send:run", parts: [items[stage === 1 ? 2 : 1]] },
        ]);
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

describe("skill review notices", () => {
  const notice = (skills: unknown) => ({
    role: "assistant",
    content: [{ type: "text", text: "💾 Learned: updated `deploy-staging`." }],
    provider: "openclaw",
    model: "delivery-mirror",
    timestamp: 2000,
    openclawDeliveryMirror: {
      kind: "skill-workshop-change",
      agentId: "main",
      runId: "skill-workshop-review:r1",
      skills,
    },
    __openclaw: { id: "notice-1", seq: 3 },
  });
  const question = { role: "user", content: "deploy it", timestamp: 1000 };
  const answer = {
    role: "assistant",
    content: "Deployed.",
    timestamp: 1500,
    __openclaw: { runId: "run" },
  };

  it("renders a marked review notice natively and keeps malformed markers as text", () => {
    const skills = [{ name: "deploy-staging", action: "updated", summary: "rollback" }];
    expect(render([question, answer, notice(skills)], [])).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "group", role: "assistant", messages: [{ message: answer }] },
      {
        kind: "notice",
        text: "",
        timestamp: 2000,
        skillChanges: {
          kind: "skill-workshop-change",
          agentId: "main",
          runId: "skill-workshop-review:r1",
          skills,
        },
      },
    ]);

    const malformed = notice([{ name: "deploy-staging", action: "renamed" }]);
    const items = render([question, malformed], []);
    expect(items.some((item) => item.kind === "notice")).toBe(false);
    expect(items).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "group", role: "assistant", messages: [{ message: malformed }] },
    ]);
  });
});
