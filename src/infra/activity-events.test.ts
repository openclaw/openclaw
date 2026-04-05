import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitActivityEvent, type ActivityEventData } from "./activity-events.js";
import { onAgentEvent, resetAgentEventsForTest, type AgentEventPayload } from "./agent-events.js";

describe("emitActivityEvent", () => {
  let captured: AgentEventPayload[];
  let unsub: () => void;

  beforeEach(() => {
    captured = [];
    unsub = onAgentEvent((evt) => captured.push(evt));
  });

  afterEach(() => {
    unsub();
    resetAgentEventsForTest();
  });

  it("emits an agent event with stream=activity", () => {
    emitActivityEvent("run-1", { kind: "run.start", agentId: "main" });
    expect(captured).toHaveLength(1);
    expect(captured[0].stream).toBe("activity");
    expect(captured[0].runId).toBe("run-1");
    expect(captured[0].data).toMatchObject({ kind: "run.start", agentId: "main" });
  });

  it("includes sessionKey when provided", () => {
    emitActivityEvent("run-2", { kind: "tool.start", toolName: "read" }, "agent:main:user");
    expect(captured[0].sessionKey).toBe("agent:main:user");
  });

  it("auto-assigns seq and ts", () => {
    emitActivityEvent("run-3", { kind: "run.end" });
    expect(captured[0].seq).toBe(1);
    expect(typeof captured[0].ts).toBe("number");
    expect(captured[0].ts).toBeGreaterThan(0);
  });

  it("increments seq per runId", () => {
    emitActivityEvent("run-4", { kind: "run.start" });
    emitActivityEvent("run-4", { kind: "tool.start", toolName: "exec" });
    emitActivityEvent("run-4", { kind: "tool.end", toolName: "exec", durationMs: 150 });
    expect(captured.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("emits all activity event kinds without error", () => {
    const kinds: ActivityEventData["kind"][] = [
      "run.start",
      "run.end",
      "run.error",
      "tool.start",
      "tool.end",
      "thinking.start",
      "thinking.end",
      "subagent.start",
      "subagent.end",
    ];
    for (const kind of kinds) {
      emitActivityEvent("run-kinds", { kind });
    }
    expect(captured).toHaveLength(kinds.length);
    expect(captured.map((e) => (e.data as ActivityEventData).kind)).toEqual(kinds);
  });
});
