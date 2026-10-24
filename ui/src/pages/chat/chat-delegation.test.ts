import { expect, it } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { projectDelegatedTasks } from "./chat-delegation.ts";

function activity(status: "accepted" | "done" | "timeout", runId: string): AgentActivityItem {
  return {
    itemId: runId + status,
    phase: "end",
    kind: "tool",
    title: "Delegate review",
    status: "completed",
    delegation: [
      {
        runId,
        childSessionKey: "agent:main:subagent:" + runId,
        groupId: "custom",
        label: "Review " + runId,
        status,
        ...(status !== "accepted" ? { runtimeMs: 42000 } : {}),
      },
    ],
  };
}
function group(key: string, runId: string): MessageGroup {
  return {
    kind: "group",
    key,
    role: "assistant",
    runId: "same-parent",
    messages: [
      {
        key,
        message: { role: "assistant", activity: [activity("accepted", runId)] },
        hasVisibleContent: true,
      },
    ],
    visibleContent: "text",
    timestamp: 1,
    isStreaming: false,
  };
}

it("keeps collected outcomes when routine waits are absent from the rendered chain", () => {
  const first = group("before-steer", "one");
  const second = group("after-steer", "two");
  const live = group("next-turn", "three");
  const history = [
    { role: "assistant", activity: [activity("done", "one"), activity("timeout", "two")] },
  ];
  const result = projectDelegatedTasks([first, second, live], [], undefined, history);
  expect([...result.keys()]).toEqual(["before-steer", "after-steer", "next-turn"]);
  expect(result.get(first.key)?.[0]?.tasks[0]).toMatchObject({
    status: "done",
    runtimeMs: 42000,
    listed: false,
  });
  expect(result.get(second.key)?.[0]?.tasks[0]?.status).toBe("timeout");
  expect(result.get(live.key)?.[0]?.tasks[0]?.status).toBe("unknown");
  expect(projectDelegatedTasks([live], [], undefined, history).size).toBe(1);
  expect(projectDelegatedTasks([], [], undefined, history).size).toBe(0);
});

it("does not turn a persistent dashboard session into an inline helper", () => {
  const own = group("own-session", "own");
  const receipt = activity("accepted", "own");
  receipt.delegation![0]!.childSessionKey = "agent:main:dashboard:own";
  own.messages[0]!.message = { role: "assistant", activity: [receipt] };
  expect(projectDelegatedTasks([own], [], undefined, []).size).toBe(0);
});

it("keeps collector completion separate from provider completion", () => {
  const origin = group("origin", "one");
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:one",
    kind: "direct",
    lastRunId: "one",
    status: "done",
  };
  expect(
    projectDelegatedTasks([origin], [child], undefined, []).get("origin")?.[0]?.tasks[0]?.status,
  ).toBe("accepted");
  const summary: GatewaySessionRow["swarm"] = {
    otherActiveGroups: 0,
    groups: [
      {
        groupId: "custom",
        createdAt: 1,
        queued: 0,
        running: 1,
        done: 0,
        failed: 0,
        children: [{ sessionKey: child.key, status: "running" }],
      },
    ],
  };
  expect(
    projectDelegatedTasks([origin], [child], summary, []).get("origin")?.[0]?.tasks[0]?.status,
  ).toBe("running");
  expect(
    projectDelegatedTasks([origin], [child], summary, [
      { role: "assistant", activity: [activity("timeout", "one")] },
    ]).get("origin")?.[0]?.tasks[0]?.status,
  ).toBe("timeout");
});
