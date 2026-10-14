import { describe, expect, it } from "vitest";
import { activeChatRunStartupStatus, reconcileChatRunStartup } from "./chat-run-startup.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { isSessionRunVisuallyActive } from "../../lib/session-run-state.ts";
import { handleAgentEvent } from "./tool-stream.ts";

describe("runtime-owned answer finalization", () => {
  it("keeps the run active while ignoring stale preparation and history activity", () => {
    const host = createHost({
      chatRunId: "run",
      chatRunStartup: { state: "activity", runId: "run", seq: 2 },
    });
    handleAgentEvent(host, agentEvent("run", 3, "lifecycle", { phase: "finishing" }));
    expect(host.chatRunStartup).toEqual({
      state: "status",
      runId: "run",
      phase: "finishing",
      seq: 3,
    });
    expect(host.chatRunId).toBe("run");
    reconcileChatRunStartup(host, { state: "activity", runId: "run" });
    reconcileChatRunStartup(host, {
      state: "status",
      runId: "run",
      phase: "preparing_context",
      seq: 1,
    });
    handleAgentEvent(host, agentEvent("run", 4, "assistant", { text: "Late answer tail" }));
    handleAgentEvent(
      host,
      agentEvent("run", 5, "tool", { phase: "result", toolCallId: "read", name: "read_file" }),
    );
    expect(host.chatRunStartup).toMatchObject({ phase: "finishing", seq: 3 });
  });

  it("does not finalize ordinary text followed by tools", () => {
    const host = createHost({ chatRunId: "run" });
    handleAgentEvent(host, agentEvent("run", 1, "assistant", { text: "Checking the file." }));
    expect(host.chatRunStartup).toMatchObject({ state: "status", phase: "answer" });
    handleAgentEvent(
      host,
      agentEvent("run", 2, "tool", { phase: "start", toolCallId: "read", name: "read_file" }),
    );
    expect(host.chatRunStartup).toMatchObject({ state: "activity", runId: "run" });
    expect(host.chatRunId).toBe("run");
    expect(
      isSessionRunVisuallyActive(true, activeChatRunStartupStatus(host.chatRunStartup)?.phase),
    ).toBe(true);
  });
});
