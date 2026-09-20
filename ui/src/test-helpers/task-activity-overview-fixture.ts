import type {
  AgentActivityItem,
  TasksHistoryResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { TaskSummary } from "../lib/tasks/task-summary.ts";

const timestamp = Date.UTC(2026, 8, 18, 12, 0);
const root = "/workspace/synthetic-review/very-long-component-ownership-and-verification-path";

type FixtureCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  title: string;
  raw: string;
  status?: AgentActivityItem["status"];
  hidden?: boolean;
  missingResult?: boolean;
};

/** Synthetic only: prepared titles intentionally include the full commands that
 * made the Review overview unreadable, rather than already-shortened labels. */
export function createTaskActivityOverviewFixture() {
  const calls: FixtureCall[] = [];
  for (let index = 1; index <= 32; index++) {
    const number = String(index).padStart(2, "0");
    const command = [
      `cd ${root}/scenario-${number}`,
      `node --input-type=module <<'REVIEW_${number}'`,
      `const caseId = "review-case-${number}";`,
      `const owner = "ui/src/pages/chat/components/deeply-nested-review-evidence-${number}.ts";`,
      'console.log(JSON.stringify({ caseId, owner, checks: ["layout", "keyboard", "failure visibility"] }));',
      `REVIEW_${number}`,
      `rg --line-number 'activity|outcome|summary|disclosure' ${root}/scenario-${number}/src`,
    ].join("\n");
    calls.push({
      id: `exec-${number}`,
      name: "exec",
      args: { command },
      title: `Run review check ${number}: ${command}`,
      raw: command,
      // Two authoritative failures deliberately contradict isError:false below.
      status: index === 7 || index === 26 ? "failed" : index === 32 ? undefined : "completed",
      missingResult: index === 32,
    });
    if (index === 8 || index === 24) {
      const path = `${root}/scenario-${number}/src/pages/chat/components/review-activity-ownership-and-accessibility-contract.ts`;
      calls.push({
        id: `read-${number}`,
        name: "read",
        args: { path },
        title: `Read the complete ownership and accessibility contract at ${path}`,
        raw: path,
        status: "completed",
      });
    }
    if (index === 12) {
      const query =
        "Review activity disclosure order, authoritative failure visibility, missing outcomes, and deeply nested ownership boundaries";
      calls.push({
        id: "search-12",
        name: "codebase_search",
        args: { query },
        title: `Search for ${query} across synthetic documentation and regression examples`,
        raw: query,
        status: "completed",
      });
    }
    if (index === 16) {
      const path = `${root}/scenario-16/src/styles/chat/review-activity-overview-and-command-disclosure.css`;
      calls.push({
        id: "edit-16",
        name: "edit",
        args: { path, oldText: "white-space: pre-wrap", newText: "white-space: normal" },
        title: `Edit the disclosure layout and preserve complete command details in ${path}`,
        raw: path,
        status: "completed",
      });
    }
    if (index === 20) {
      calls.push({
        id: "poll-20",
        name: "process",
        args: { action: "poll", sessionId: "synthetic-review-poll" },
        title: "Routine poll of synthetic-review-poll",
        raw: "synthetic-review-poll",
        status: "completed",
        hidden: true,
      });
    }
  }
  calls.push({
    id: "generic-33",
    name: "inspect_artifact",
    args: { target: "synthetic-artifact-without-outcome" },
    title: "Inspect synthetic artifact",
    raw: "synthetic-artifact-without-outcome",
    missingResult: true,
  });

  const messages: unknown[] = [
    {
      role: "user",
      messageId: "review-request",
      timestamp,
      content:
        "Review the synthetic activity feed. Keep failures visible and raw commands available on demand.",
    },
  ];
  const activity: NonNullable<TasksHistoryResult["activity"]> = [];
  for (const [index, call] of calls.entries()) {
    const messageId = `message-${call.id}`;
    messages.push({
      role: "assistant",
      messageId,
      timestamp: timestamp + (index + 1) * 1_000,
      content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }],
    });
    activity.push({
      messageId,
      items: [
        {
          itemId: `tool:${call.id}`,
          toolCallId: call.id,
          kind: "tool",
          phase: call.missingResult ? "start" : "end",
          name: call.name,
          title: call.title,
          ...(call.status ? { status: call.status } : {}),
          ...(call.hidden ? { hideFromChannelProgress: true } : {}),
          ...(call.name === "exec" ? { commandBearing: true } : {}),
        },
      ],
    });
    if (!call.missingResult) {
      messages.push({
        role: "toolResult",
        messageId: `result-${call.id}`,
        toolCallId: call.id,
        toolName: call.name,
        isError: false,
        content: [{ type: "text", text: "Synthetic tool transport completed." }],
      });
    }
  }
  messages.push({
    role: "assistant",
    messageId: "review-conclusion",
    timestamp: timestamp + 60_000,
    content:
      "Review checkpoint: two checks failed; one command and one artifact inspection have no recorded outcome.",
  });

  const sessionKey = "agent:main:main";
  const task: TaskSummary = {
    id: "dense-review-child",
    taskId: "dense-review-child",
    sessionKey,
    ownerKey: sessionKey,
    agentId: "main",
    title: "Review",
    runtime: "subagent",
    status: "completed",
    startedAt: timestamp,
    endedAt: timestamp + 60_000,
    updatedAt: timestamp + 60_000,
    hasTranscript: true,
    toolUseCount: calls.length,
    execution: { state: "finished", lastActivityAt: timestamp + 60_000 },
    deliveryStatus: "delivered",
  };
  const history: TasksHistoryResult = { messages, activity };
  return { sessionKey, task, history, calls };
}
