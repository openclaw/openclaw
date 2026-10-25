// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";
import { chatItemStartsDisplayTurn, chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

const clients = [{ id: "cli", mode: "cli", displayName: "Release helper" }];
const baseMessage = {
  role: "user",
  content: "[System] Continue the interrupted turn.",
  timestamp: 1000,
  __openclaw: { id: "input-1", seq: 2, idempotencyKey: "run:user", transport: { clients } },
};
const systemMessage = (sourceTool?: string, content = baseMessage.content) => ({
  ...baseMessage,
  content,
  provenance: { kind: "internal_system", sourceTool },
});
const messageItem = <T extends object>(message: T) => ({
  kind: "message" as const,
  key: "input-1",
  message,
});

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
  pendingInputs: ChatPendingInputsPage["items"] = [],
  searchQuery = "",
) {
  return buildItems({
    paneId: "notices",
    messages,
    pendingInputs,
    searchOpen: Boolean(searchQuery),
    searchQuery,
  });
}

afterEach(() => resetChatThreadState());

const before = { role: "user", content: "Review the patch.", timestamp: 999 };
const after = {
  role: "assistant",
  content: "The rollback path is safe.",
  timestamp: 1001,
  __openclaw: { runId: "run" },
};
const group = (message: { role: string }) => ({
  kind: "group",
  role: message.role,
  messages: [{ message }],
});
function expectMidTurn(notice: ChatItem) {
  expect([chatItemStartsUserTurn(notice), chatItemStartsDisplayTurn(notice)]).toEqual([
    false,
    false,
  ]);
}

it.each([
  ["main_session_restart_recovery", "System · restart recovery", "", false],
  [
    "cron_failure_repair",
    "System · automation recovery",
    "An automation failed — asked the agent to investigate and continue if needed.",
    false,
  ],
  ["restart-sentinel", "System · gateway restarted", "Gateway restarted.", false],
  ["cli_harness_context", "System · injected context", "# Auto Review", true],
  ["claude_cli_task_notification", "System · background task", "<task-notification/>", true],
  ...[undefined, " restart-sentinel "].map(
    (sourceTool) => [sourceTool, "System", "Keep the raw fallback copy.", false] as const,
  ),
] as const)(
  "projects %s presentation without exposing internal payloads",
  (sourceTool, label, text, midTurn) => {
    const message = systemMessage(
      sourceTool,
      sourceTool === "main_session_restart_recovery"
        ? baseMessage.content
        : sourceTool === "cron_failure_repair"
          ? "Automation repair request from the scheduler.\n<untrusted-text>Private task payload and last error</untrusted-text>"
          : (midTurn ? "" : "[System] ") + text,
    );
    const [notice] = projectChatSystemNotice(messageItem(message));
    expect(notice).toMatchObject({ kind: "notice", icon: "cpu", label, text, timestamp: 1000 });
    expect(notice?.kind === "notice" && [notice.startsTurn, notice.collapsedBody]).toEqual(
      midTurn ? [undefined, true] : [true, undefined],
    );
  },
);

it.each([false, true])(
  "preserves notice promotion, search and framing (imported=%s)",
  (imported) => {
    const message = {
      ...systemMessage(imported ? "cli_harness_context" : "restart-sentinel", "[System] Context"),
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
    const stages = [
      [before, after],
      [before, message, after],
    ];
    // Search evicts the pending notice: check both promotion stages first.
    for (const [stage, messages] of stages.entries()) {
      const items = render(messages, inputs);
      const notice = items[stage === 1 ? 1 : 2];
      expect(items).toMatchObject(
        stage === 1
          ? [group(before), { kind: "notice", text: "Context" }, group(after)]
          : [group(before), group(after), { kind: "notice", text: "Context" }],
      );
      expect(notice?.kind === "notice" && notice.boundaryId).toBe(
        stage === 1 && !imported ? "send:run" : undefined,
      );
      const framed = coalesceAgentRunFrames(items);
      expect(framed).toContain(notice);
      expect(framed.filter((item) => item.kind === "agent-run-frame")).toMatchObject([
        { runId: "run", boundaryId: "send:run", parts: [items[stage === 1 ? 2 : 1]] },
      ]);
    }
    for (const messages of stages) {
      expect(render(messages, inputs, "rollback")).toMatchObject([group(after)]);
    }
  },
);

it.each(["queued", "interrupted", "cancelled"] as const)(
  "projects %s restart recovery custody",
  (state) => {
    const message = systemMessage("main_session_restart_recovery");
    const text =
      state === "queued"
        ? ""
        : `The Gateway restarted. Automatic recovery was ${state} before the agent could resume. Send a message to continue.`;
    expect(render([], pending(message, state))).toMatchObject([
      { kind: "notice", label: "System · restart recovery", text, startsTurn: true },
    ]);
    expect(render([message], pending(message, state))).toMatchObject([
      { kind: "notice", label: "System · restart recovery", text: "", boundaryId: "send:run" },
    ]);
  },
);

it.each([
  ["cli_harness_context", undefined, undefined],
  ["claude_cli_task_notification", undefined, undefined],
  ...(
    [
      [{ pluginId: "release-helper", pluginName: "Release Helper" }, "Release Helper"],
      [{ pluginId: "review-helper" }, "review-helper"],
      [{ pluginId: "review-helper", pluginName: " " }, "review-helper"],
      [undefined, "review-helper"],
    ] as const
  ).map(
    ([pluginSteering, name]) =>
      [`plugin:${pluginSteering?.pluginId ?? "review-helper"}`, pluginSteering, name] as const,
  ),
] as const)(
  "keeps %s between tool groups with source attribution and no new turn",
  (sourceTool, pluginSteering, name) => {
    const call = (id: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
      timestamp: 999,
      __openclaw: { runId: "same-run" },
    });
    const steering = {
      ...systemMessage(sourceTool, "Check rollback."),
      __openclaw: { ...baseMessage["__openclaw"], pluginSteering },
    };
    const items = render([call("before"), steering, call("after")]);
    expect(items).toMatchObject([
      { kind: "group", role: "tool" },
      { kind: "notice", collapsedBody: true },
      { kind: "group", role: "tool" },
    ]);
    if (name) {
      expect(items[1]).toMatchObject({
        label: `${name} guidance`,
        text: steering.content,
        timestamp: 1000,
        showTimestamp: true,
      });
      expect(items[1]).not.toHaveProperty("startsTurn");
    }
    expectMidTurn(items[1]!);
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
it.each([
  { role: "user", provenance: { kind: "external_user", sourceTool: "plugin:review-helper" } },
  {
    role: "assistant",
    provenance: { kind: "internal_system", sourceTool: "plugin:review-helper" },
  },
])("does not treat unrelated plugin-tagged messages as steering: %j", (fields) => {
  const item = messageItem({
    ...baseMessage,
    ...fields,
    __openclaw: { pluginSteering: { pluginId: "review-helper", pluginName: "Review Helper" } },
  });
  expect(projectChatSystemNotice(item)).toEqual([item]);
});
const skillMessage = {
  role: "assistant",
  content: "💾 Learned: updated `deploy-staging`.",
  provider: "openclaw",
  model: "delivery-mirror",
  timestamp: 2000,
};
const notice = (skills: unknown) => ({
  ...skillMessage,
  content: [{ type: "text", text: skillMessage.content }],
  openclawDeliveryMirror: {
    kind: "skill-workshop-change",
    agentId: "main",
    runId: "skill-workshop-review:r1",
    skills,
  },
  __openclaw: { id: "notice-1", seq: 3 },
});

it.each([
  [{ idempotencyKey: "skill-workshop-notice:review" }, true],
  [{ __openclaw: { idempotencyKey: "skill-workshop-notice:review" } }, true],
  [{ idempotencyKey: "ordinary-delivery" }, false],
  [{ idempotencyKey: "skill-workshop-notice:" }, false],
  [{ idempotencyKey: "skill-workshop-notice:review", provider: "model-provider" }, false],
  [{ idempotencyKey: "skill-workshop-notice:review", model: "model-output" }, false],
  [{ idempotencyKey: "skill-workshop-notice:review", role: "user" }, false],
])("uses legacy notice provenance, not Learned text: %j", (fields, projected) => {
  const item = messageItem({ ...skillMessage, ...fields });
  expect(projectChatSystemNotice(item)).toEqual(
    projected
      ? [{ kind: "notice", key: item.key, text: item.message.content, timestamp: 2000 }]
      : [item],
  );
});

it("renders a marked review notice natively and keeps malformed markers as text", () => {
  const skills = [{ name: "deploy-staging", action: "updated", summary: "rollback" }];
  expect(render([before, after, notice(skills)])).toMatchObject([
    { kind: "group", role: "user" },
    group(after),
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
  const items = render([before, malformed]);
  expect(items.some((item) => item.kind === "notice")).toBe(false);
  expect(items).toMatchObject([{ kind: "group", role: "user" }, group(malformed)]);
});
