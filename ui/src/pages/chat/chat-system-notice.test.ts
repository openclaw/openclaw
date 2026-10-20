// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { pending as pendingInput } from "./chat-thread-fixtures.test-support.ts";
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
type Pending = ChatPendingInputsPage["items"];
function group(role: string, message: unknown) {
  return { kind: "group", role, messages: [{ message }] };
}
function notice(label: string, text: string) {
  return { kind: "notice", icon: "cpu", label, text, timestamp: 1000 };
}
function reply(content: string, timestamp = 1001) {
  return { role: "assistant", content, timestamp, __openclaw: { runId: "run" } };
}
function system(sourceTool: string | undefined, content = baseMessage.content) {
  return { ...baseMessage, content, provenance: { kind: "internal_system", sourceTool } };
}

function pending(message: object, state: Pending[number]["state"] = "queued"): Pending {
  const value = { ...message, __openclaw: { id: "pending:input-1", transport: { clients } } };
  return [pendingInput("input-1", "run", value, 1000, state)];
}
function render(messages: unknown[], pendingInputs: Pending = [], searchQuery = "") {
  return buildItems({
    paneId: "notices",
    messages,
    pendingInputs,
    searchOpen: Boolean(searchQuery),
    searchQuery,
  });
}
function expectMidTurn(item: ChatItem) {
  expect([chatItemStartsUserTurn(item), chatItemStartsDisplayTurn(item)]).toEqual([false, false]);
}
afterEach(() => resetChatThreadState());

it.each([
  ["main_session_restart_recovery", "System · restart recovery", "", false],
  [
    "cron_failure_repair",
    "System · automation recovery",
    "An automation failed — asked the agent to investigate and continue if needed.",
    false,
  ],
  ["restart-sentinel", "System · gateway restarted", "Gateway restarted.", false],
  ["cli_harness_context", "System · injected context", "Skill context", true],
  ["claude_cli_task_notification", "System · background task", "Task completed", true],
  ...[undefined, " restart-sentinel "].map(
    (sourceTool) => [sourceTool, "System", "Keep the raw fallback copy.", false] as const,
  ),
] as const)(
  "preserves %s presentation, search and turn boundaries",
  (sourceTool, label, text, midTurn) => {
    const imported = sourceTool === "cli_harness_context";
    const message = {
      ...system(
        sourceTool,
        sourceTool === "main_session_restart_recovery"
          ? baseMessage.content
          : sourceTool === "cron_failure_repair"
            ? "Repair.\n<untrusted-text>Private task payload</untrusted-text>"
            : (midTurn ? "" : "[System] ") + text,
      ),
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
        const interrupted = notice(
          label,
          `The Gateway restarted. Automatic recovery was ${state} before the agent could resume. Send a message to continue.`,
        );
        expect(render([], pending(message, state))).toMatchObject([
          { ...interrupted, startsTurn: true },
        ]);
        expect(render([message], pending(message, state))).toMatchObject([
          {
            ...notice(label, text),
            boundaryId: "send:run",
          },
        ]);
      }
    }
    const inputs = pending(message);
    const before = { role: "user", content: "before", timestamp: 999 };
    const after = reply("after");
    const stages = [
      [before, after],
      [before, message, after],
    ];
    // Search evicts the pending notice; check promotion first.
    for (const [stage, messages] of stages.entries()) {
      const items = render(messages, inputs);
      const canonical = [group("user", before), notice(label, text), group("assistant", after)];
      expect(items).toMatchObject(
        stage === 1 ? canonical : [canonical[0], canonical[2], canonical[1]],
      );
      const item = items.find((entry) => entry.kind === "notice")!;
      expect([item.startsTurn, item.collapsedBody, item.boundaryId]).toEqual([
        midTurn ? undefined : true,
        midTurn ? true : undefined,
        stage === 1 && !imported ? "send:run" : undefined,
      ]);
      const framed = coalesceAgentRunFrames(items);
      expect(framed).toContain(item);
      expect(framed.filter((entry) => entry.kind === "agent-run-frame")).toMatchObject([
        {
          runId: "run",
          boundaryId: "send:run",
          parts: [items[stage === 1 ? 2 : 1]],
        },
      ]);
    }
    for (const messages of stages) {
      expect(render(messages, inputs, "after")).toMatchObject([group("assistant", after)]);
    }
  },
);

it.each(["cli_harness_context", "claude_cli_task_notification", "plugin:review-helper"])(
  "keeps %s between tool groups without starting a turn",
  (sourceTool) => {
    const call = (id: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
      timestamp: 999,
      __openclaw: { runId: "same-run" },
    });
    const items = render([call("before"), system(sourceTool), call("after")]);
    expect(items).toMatchObject([
      { kind: "group", role: "tool" },
      { kind: "notice", collapsedBody: true },
      { kind: "group", role: "tool" },
    ]);
    expectMidTurn(items[1]!);
  },
);

it("keeps a user's System prefix and sender attribution through promotion", () => {
  const inputs = pending(baseMessage);
  for (const consumed of [false, true]) {
    expect(render(consumed ? [baseMessage] : [], inputs)).toMatchObject([
      {
        ...group("user", consumed ? baseMessage : inputs[0]?.message),
        sourceClients: clients,
      },
    ]);
  }
});

it.each([
  [{ pluginId: "release-helper", pluginName: "Release Helper" }, "Release Helper"],
  [{ pluginId: "review-helper" }, "review-helper"],
  [{ pluginId: "review-helper", pluginName: " " }, "review-helper"],
  [undefined, "review-helper"],
] as const)(
  "uses plugin attribution without starting an operator turn: %j",
  (pluginSteering, name) => {
    const before = { role: "user", content: "Review the patch.", timestamp: 999 };
    const sourceTool = `plugin:${pluginSteering?.pluginId ?? "review-helper"}`;
    const steering = {
      ...system(sourceTool, "Check the rollback path."),
      __openclaw: { ...baseMessage["__openclaw"], pluginSteering },
    };
    const after = reply("The rollback path is safe.");
    const messages = [before, steering, after];
    const items = render(messages);
    expect(items).toMatchObject([
      group("user", before),
      { ...notice(`${name} guidance`, steering.content), collapsedBody: true, showTimestamp: true },
      group("assistant", after),
    ]);
    const item = items.find((entry) => entry.kind === "notice")!;
    expect(item).not.toHaveProperty("startsTurn");
    expectMidTurn(item);
    expect(coalesceAgentRunFrames(items)).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "notice", label: `${name} guidance` },
      { kind: "agent-run-frame", runId: "run", boundaryId: "send:run" },
    ]);
    expect(render(messages, [], "rollback")).toMatchObject([
      { kind: "notice", text: steering.content },
      { kind: "group", role: "assistant" },
    ]);
  },
);

it.each([
  ["user", "external_user"],
  ["assistant", "internal_system"],
])("does not treat unrelated plugin-tagged messages as steering: %s %s", (role, kind) => {
  const item = {
    kind: "message" as const,
    key: "not-steering",
    message: {
      ...baseMessage,
      role,
      provenance: { kind, sourceTool: "plugin:review-helper" },
      __openclaw: { pluginSteering: { pluginId: "review-helper", pluginName: "Review Helper" } },
    },
  };
  expect(projectChatSystemNotice(item)).toEqual([item]);
});

it("renders a marked review notice natively and keeps malformed markers as text", () => {
  const marker = {
    kind: "skill-workshop-change",
    agentId: "main",
    runId: "skill-workshop-review:r1",
  };
  const review = (skills: unknown) => ({
    role: "assistant",
    content: [{ type: "text", text: "💾 Learned: updated `deploy-staging`." }],
    provider: "openclaw",
    model: "delivery-mirror",
    timestamp: 2000,
    openclawDeliveryMirror: { ...marker, skills },
    __openclaw: { id: "notice-1", seq: 3 },
  });
  const question = { role: "user", content: "deploy it", timestamp: 1000 };
  const answer = reply("Deployed.", 1500);
  const skills = [{ name: "deploy-staging", action: "updated", summary: "rollback" }];
  expect(render([question, answer, review(skills)])).toMatchObject([
    { kind: "group", role: "user" },
    group("assistant", answer),
    { kind: "notice", text: "", timestamp: 2000, skillChanges: { ...marker, skills } },
  ]);
  const malformed = review([{ name: "deploy-staging", action: "renamed" }]);
  const items = render([question, malformed]);
  expect(items.some((item) => item.kind === "notice")).toBe(false);
  expect(items).toMatchObject([{ kind: "group", role: "user" }, group("assistant", malformed)]);
});
