// @vitest-environment node
import { describe, expect, it } from "vitest";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

function agentEvent(
  runId: string,
  seq: number,
  stream: AgentEvent["stream"],
  data: AgentEvent["data"],
  sessionKey?: string,
): AgentEvent {
  return {
    runId,
    seq,
    stream,
    ts: Date.now(),
    ...(sessionKey ? { sessionKey } : {}),
    data,
  };
}

describe("app-tool-stream run usage", () => {
  it("bounds retained usage while keeping the most recently updated run", () => {
    const host = createHost();
    for (let index = 0; index < 60; index++) {
      handleAgentEvent(
        host,
        agentEvent(`run-${index}`, 1, "usage", { outputTokens: index }, "main"),
      );
      handleAgentEvent(
        host,
        agentEvent("still-active", index + 1, "usage", { outputTokens: index }, "main"),
      );
    }
    expect(host.chatRunUsageById?.size).toBe(50);
    expect(host.chatRunUsageById?.has("run-0")).toBe(false);
    expect(host.chatRunUsageById?.get("still-active")?.outputTokens).toBe(59);
  });

  it("keeps the last usage through completion even without an intervening render", () => {
    const host = createHost({ chatRunId: "client-run" });
    handleAgentEvent(host, agentEvent("client-run", 1, "usage", { outputTokens: 695 }, "main"));
    handleAgentEvent(host, agentEvent("client-run", 2, "lifecycle", { phase: "end" }, "main"));
    expect(host.chatRunUsageById?.get("client-run")?.outputTokens).toBe(695);
  });

  it("accepts a newer corrected count but ignores older recovery usage", () => {
    const host = createHost({ chatRunId: "client-run" });
    handleAgentEvent(host, agentEvent("client-run", 8, "usage", { outputTokens: 120 }, "main"));
    handleAgentEvent(host, agentEvent("client-run", 9, "usage", { outputTokens: 115 }, "main"));
    resetToolStream(host);
    handleAgentEvent(host, agentEvent("client-run", 7, "lifecycle", { phase: "start" }, "main"));
    handleAgentEvent(host, agentEvent("client-run", 7, "usage", { outputTokens: 150 }, "main"));
    expect(host.chatRunUsageById?.get("client-run")?.outputTokens).toBe(115);
  });

  it("projects provider-independent system warnings into the visible session transcript", () => {
    const host = createHost({ chatRunId: "client-run" });

    expect(
      handleAgentEvent(
        host,
        agentEvent(
          "client-run",
          1,
          "notice",
          { phase: "warning", message: "Custom execution rules were not applied." },
          "main",
        ),
      ),
    ).toBe(true);
    expect(host.guardianNotices).toMatchObject([
      {
        kind: "warning",
        source: "system",
        message: "Custom execution rules were not applied.",
      },
    ]);
  });

  it("replaces a pending targetless Guardian review with its terminal decision", () => {
    const host = createHost({ chatRunId: "client-run" });
    const review = {
      reviewId: "network-review",
      targetItemId: null,
      command: "https://api.example.test:443",
    };

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        1,
        "codex_app_server.guardian",
        { ...review, phase: "started", status: "inProgress" },
        "main",
      ),
    );
    expect(host.guardianNotices).toMatchObject([
      { kind: "reviewing", command: "https://api.example.test:443" },
    ]);

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        2,
        "codex_app_server.guardian",
        { ...review, phase: "completed", status: "denied" },
        "main",
      ),
    );
    expect(host.guardianNotices).toMatchObject([
      { kind: "denied", command: "https://api.example.test:443" },
    ]);
  });

  it("shows a targeted strict-review requirement only until its decision arrives", () => {
    const host = createHost({ chatRunId: "client-run" });
    const review = {
      reviewId: "strict-review",
      targetItemId: "command-1",
      command: "printf hello",
    };

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        1,
        "codex_app_server.guardian",
        { ...review, phase: "strict_review_required" },
        "main",
      ),
    );
    expect(host.guardianNotices).toMatchObject([
      { kind: "strict-review-required", command: "printf hello" },
    ]);

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        2,
        "codex_app_server.guardian",
        { ...review, phase: "completed", status: "approved" },
        "main",
      ),
    );
    expect(host.guardianNotices).toEqual([]);
  });

  it("rejects a sessionless system notice from a foreign run", () => {
    const host = createHost({ chatRunId: "client-run" });

    expect(
      handleAgentEvent(
        host,
        agentEvent("foreign-run", 1, "notice", {
          phase: "warning",
          message: "Foreign system warning",
        }),
      ),
    ).toBe(true);
    expect(host.guardianNotices).toEqual([]);
  });

  it("rejects a same-session Guardian notice from a foreign run", () => {
    const host = createHost({ chatRunId: "client-run" });

    expect(
      handleAgentEvent(
        host,
        agentEvent(
          "foreign-run",
          1,
          "codex_app_server.guardian",
          {
            reviewId: "foreign-review",
            phase: "started",
            status: "inProgress",
            command: "foreign command",
            rationale: "foreign rationale",
          },
          "main",
        ),
      ),
    ).toBe(true);
    expect(host.guardianNotices).toEqual([]);
  });

  it("requires the local run id when an event has no session identity", () => {
    const host = createHost({ chatRunId: "client-run" });

    handleAgentEvent(host, agentEvent("engine-run", 1, "usage", { outputTokens: 20 }));
    handleAgentEvent(host, agentEvent("client-run", 2, "usage", { outputTokens: 7 }));

    expect(Array.from(host.chatRunUsageById?.entries() ?? [])).toEqual([
      ["client-run", { outputTokens: 7, seq: 2 }],
    ]);
  });
});

describe("app-tool-stream startup status", () => {
  function toolStart(runId: string, toolCallId: string): AgentEvent {
    return {
      runId,
      seq: 1,
      stream: "tool",
      ts: 1,
      sessionKey: "main",
      data: { phase: "start", toolCallId, name: "read", args: {} },
    };
  }

  it.each(["tool", "preamble", "assistant"])(
    "keeps retry waits transient and ordered across %s progress and delayed replay",
    (kind) => {
      const host = createHost({
        chatRunId: "run-1",
        chatRunStartup: { state: "status", runId: "run-1", phase: "starting_model" },
        toolStreamSyncTimer: 1,
      });
      const retry: AgentEvent = {
        runId: "run-1",
        seq: 3,
        stream: "run_status",
        ts: 3,
        sessionKey: "main",
        data: { phase: "retrying", message: "Rate limited. Retrying in 2 seconds (attempt 2/8)." },
      };
      const retryLabel = () =>
        chatStartupStatusLabel(activeChatRunStartupStatus(host.chatRunStartup), null);
      handleAgentEvent(host, toolStart("run-1", "tool-1"));
      handleAgentEvent(host, retry);
      handleAgentEvent(host, { ...retry, runId: "run-other", seq: 4 });
      handleAgentEvent(host, { ...toolStart("run-1", "tool-old"), seq: 2 });
      expect(host.chatRunId).toBe("run-1");
      expect(retryLabel()).toBe(retry.data.message);

      handleAgentEvent(host, {
        ...retry,
        seq: 4,
        stream: kind === "preamble" ? "item" : kind,
        data:
          kind === "tool"
            ? { phase: "start", toolCallId: "tool-next", name: "read" }
            : kind === "preamble"
              ? { kind: "preamble", itemId: "resumed", progressText: "Continuing" }
              : { text: "Continuing" },
      });
      handleAgentEvent(host, retry);
      expect(retryLabel()).toBeUndefined();
      expect(host.chatRunId).toBe("run-1");

      handleAgentEvent(host, { ...retry, seq: 5 });
      expect(retryLabel()).toBe(retry.data.message);
    },
  );
});
