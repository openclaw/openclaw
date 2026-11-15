// @vitest-environment node
import { describe, expect, it } from "vitest";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

function usageHarness(overrides: Parameters<typeof createHost>[0] = {}) {
  const host = createHost(overrides);
  const send = (
    seq: number,
    stream: AgentEvent["stream"],
    data: AgentEvent["data"],
    runId = "client-run",
    sessionKey: string | null = "main",
  ) =>
    handleAgentEvent(host, {
      runId,
      seq,
      stream,
      ts: Date.now(),
      ...(sessionKey ? { sessionKey } : {}),
      data,
    });
  return { host, send };
}

describe("app-tool-stream run usage", () => {
  it("bounds retained usage while keeping the most recently updated run", () => {
    const { host, send } = usageHarness();
    for (let index = 0; index < 60; index++) {
      send(1, "usage", { outputTokens: index }, `run-${index}`, "main");
      send(index + 1, "usage", { outputTokens: index }, "still-active", "main");
    }
    expect(host.chatRunUsageById?.size).toBe(50);
    expect(host.chatRunUsageById?.has("run-0")).toBe(false);
    expect(host.chatRunUsageById?.get("still-active")?.outputTokens).toBe(59);
  });

  it("accepts a newer corrected count but ignores older recovery usage", () => {
    const { host, send } = usageHarness({ chatRunId: "client-run" });
    send(8, "usage", { outputTokens: 120 });
    send(9, "usage", { outputTokens: 115 });
    resetToolStream(host);
    send(7, "lifecycle", { phase: "start" });
    send(7, "usage", { outputTokens: 150 });
    expect(host.chatRunUsageById?.get("client-run")?.outputTokens).toBe(115);
    send(10, "usage", {
      outputTokens: 115,
      usageReport: { state: "unavailable" },
    });
    resetToolStream(host);
    send(9, "usage", { outputTokens: 115 });
    expect(host.chatRunUsageById?.get("client-run")).toEqual({ outputTokens: null, seq: 10 });
  });

  it("projects provider-independent system warnings into the visible session transcript", () => {
    const { host, send } = usageHarness({ chatRunId: "client-run" });

    expect(
      send(1, "notice", { phase: "warning", message: "Custom execution rules were not applied." }),
    ).toBe(true);
    expect(host.guardianNotices).toMatchObject([
      { kind: "warning", source: "system", message: "Custom execution rules were not applied." },
    ]);
  });

  it("shows the bounded-context warning for a run this pane does not own", () => {
    const warning = { phase: "context_bounded", message: "Older history is omitted." };
    const viewer = usageHarness();
    expect(viewer.send(1, "compaction", warning, "channel-run")).toBe(true);
    expect(viewer.host.guardianNotices).toMatchObject([
      { kind: "warning", source: "system", message: "Older history is omitted." },
    ]);

    // The run's status reply already shows it in the pane that started the run.
    const owner = usageHarness({ chatRunId: "client-run" });
    expect(owner.send(1, "compaction", warning)).toBe(true);
    expect(owner.host.guardianNotices).toEqual([]);
  });

  it.each([false, true])(
    "replaces pending Guardian reviews with decisions (strict=%s)",
    (strict) => {
      const { host, send } = usageHarness({ chatRunId: "client-run" });
      const review = {
        reviewId: "review",
        targetItemId: strict ? "command-1" : null,
        command: strict ? "printf hello" : "https://api.example.test:443",
      };
      const started = strict
        ? { phase: "strict_review_required" }
        : { phase: "started", status: "inProgress" };
      send(1, "codex_app_server.guardian", { ...review, ...started });
      expect(host.guardianNotices).toMatchObject([
        {
          kind: strict ? "strict-review-required" : "reviewing",
          command: review.command,
        },
      ]);
      send(2, "codex_app_server.guardian", {
        ...review,
        phase: "completed",
        status: strict ? "approved" : "denied",
      });
      if (strict) {
        expect(host.guardianNotices).toEqual([]);
      } else {
        expect(host.guardianNotices).toMatchObject([{ kind: "denied", command: review.command }]);
      }
    },
  );

  it.each([
    ["notice", { phase: "warning", message: "Foreign system warning" }, null],
    [
      "codex_app_server.guardian",
      {
        reviewId: "foreign-review",
        phase: "started",
        status: "inProgress",
        command: "foreign command",
        rationale: "foreign rationale",
      },
      "main",
    ],
  ] satisfies Array<[AgentEvent["stream"], AgentEvent["data"], string | null]>)(
    "rejects foreign-run %s notices",
    (stream, data, sessionKey) => {
      const { host, send } = usageHarness({ chatRunId: "client-run" });
      expect(send(1, stream, data, "foreign-run", sessionKey)).toBe(true);
      expect(host.guardianNotices).toEqual([]);
    },
  );

  it("requires the local run id when an event has no session identity", () => {
    const { host, send } = usageHarness({ chatRunId: "client-run" });

    send(1, "usage", { outputTokens: 20 }, "engine-run", null);
    send(2, "usage", { outputTokens: 7 }, "client-run", null);

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
      expect(retryLabel()).toBe("Retrying…");

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
      expect(retryLabel()).toBe("Retrying…");
    },
  );
});
