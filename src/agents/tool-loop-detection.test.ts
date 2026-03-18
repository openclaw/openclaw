import { describe, expect, it } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  BROWSER_SEARCH_CRITICAL_THRESHOLD,
  BROWSER_SEARCH_WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  TOOL_CALL_HISTORY_SIZE,
  WARNING_THRESHOLD,
  detectToolCallLoop,
  getToolCallStats,
  hashToolCall,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    state: "processing",
    queueDepth: 0,
  };
}

const enabledLoopDetectionConfig: ToolLoopDetectionConfig = { enabled: true };

const shortHistoryLoopConfig: ToolLoopDetectionConfig = {
  enabled: true,
  historySize: 4,
};

function recordSuccessfulCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  result: unknown,
  index: number,
): void {
  const toolCallId = `${toolName}-${index}`;
  recordToolCall(state, toolName, params, toolCallId);
  recordToolCallOutcome(state, {
    toolName,
    toolParams: params,
    toolCallId,
    result,
  });
}

function recordRepeatedSuccessfulCalls(params: {
  state: SessionState;
  toolName: string;
  toolParams: unknown;
  result: unknown;
  count: number;
  startIndex?: number;
}) {
  const startIndex = params.startIndex ?? 0;
  for (let i = 0; i < params.count; i += 1) {
    recordSuccessfulCall(
      params.state,
      params.toolName,
      params.toolParams,
      params.result,
      startIndex + i,
    );
  }
}

function createNoProgressPollFixture(sessionId: string) {
  return {
    params: { action: "poll", sessionId },
    result: {
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    },
  };
}

function createReadNoProgressFixture() {
  return {
    toolName: "read",
    params: { path: "/same.txt" },
    result: {
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    },
  } as const;
}

function createPingPongFixture() {
  return {
    state: createState(),
    readParams: { path: "/a.txt" },
    listParams: { dir: "/workspace" },
  };
}

function createBrowserSearchFixture(
  query: string,
  host = "www.google.com",
  options?: {
    path?: string;
    queryParam?: string;
    action?: "open" | "navigate";
    urlField?: "url" | "targetUrl";
    targetId?: string;
  },
) {
  const path = options?.path ?? "/search";
  const queryParam = options?.queryParam ?? "q";
  const url = `https://${host}${path}?${queryParam}=${encodeURIComponent(query)}`;
  const action = options?.action ?? "open";
  const urlField = options?.urlField ?? "url";
  return {
    toolName: "browser",
    params: { action, [urlField]: url },
    result: {
      content: [{ type: "text", text: `results for ${query}` }],
      details: {
        url,
        ...(options?.targetId ? { targetId: options.targetId } : {}),
      },
    },
  } as const;
}

function createBrowserPageFixture(url: string) {
  return {
    toolName: "browser",
    params: { action: "open", url },
    result: {
      content: [{ type: "text", text: `opened ${url}` }],
      details: { url },
    },
  } as const;
}

function createBrowserActClickFixture(ref = "1") {
  return {
    toolName: "browser",
    params: { action: "act", request: { kind: "click", ref } },
    result: {
      content: [{ type: "text", text: `clicked ${ref}` }],
      details: { ok: true },
    },
  } as const;
}

function createBrowserActTypeFixture(
  query: string,
  targetId = "tab-search",
  options?: { submit?: boolean },
) {
  return {
    toolName: "browser",
    params: {
      action: "act",
      request: {
        kind: "type",
        targetId,
        ref: "qbox",
        text: query,
        ...(options?.submit !== undefined ? { submit: options.submit } : {}),
      },
    },
    result: {
      content: [{ type: "text", text: `typed ${query}` }],
      details: { ok: true, targetId },
    },
  } as const;
}

function createBrowserActPressFixture(key = "Enter", targetId = "tab-search") {
  return {
    toolName: "browser",
    params: {
      action: "act",
      request: {
        kind: "press",
        targetId,
        key,
      },
    },
    result: {
      content: [{ type: "text", text: `pressed ${key}` }],
      details: { ok: true, targetId },
    },
  } as const;
}

function recordSuccessfulBrowserSearchCalls(params: {
  state: SessionState;
  queries: string[];
  hostAtIndex?: (index: number) => string;
  startIndex?: number;
}) {
  const startIndex = params.startIndex ?? 0;
  for (let i = 0; i < params.queries.length; i += 1) {
    const fixture = createBrowserSearchFixture(
      params.queries[i] ?? `query-${i}`,
      params.hostAtIndex?.(i) ?? "www.google.com",
    );
    recordSuccessfulCall(
      params.state,
      fixture.toolName,
      fixture.params,
      fixture.result,
      startIndex + i,
    );
  }
}

function detectLoopAfterRepeatedCalls(params: {
  toolName: string;
  toolParams: unknown;
  result: unknown;
  count: number;
  config?: ToolLoopDetectionConfig;
}) {
  const state = createState();
  recordRepeatedSuccessfulCalls({
    state,
    toolName: params.toolName,
    toolParams: params.toolParams,
    result: params.result,
    count: params.count,
  });
  return detectToolCallLoop(
    state,
    params.toolName,
    params.toolParams,
    params.config ?? enabledLoopDetectionConfig,
  );
}

function recordSuccessfulPingPongCalls(params: {
  state: SessionState;
  readParams: { path: string };
  listParams: { dir: string };
  count: number;
  textAtIndex: (toolName: "read" | "list", index: number) => string;
}) {
  for (let i = 0; i < params.count; i += 1) {
    if (i % 2 === 0) {
      recordSuccessfulCall(
        params.state,
        "read",
        params.readParams,
        { content: [{ type: "text", text: params.textAtIndex("read", i) }], details: { ok: true } },
        i,
      );
    } else {
      recordSuccessfulCall(
        params.state,
        "list",
        params.listParams,
        { content: [{ type: "text", text: params.textAtIndex("list", i) }], details: { ok: true } },
        i,
      );
    }
  }
}

function expectPingPongLoop(
  loopResult: ReturnType<typeof detectToolCallLoop>,
  expected: { level: "warning" | "critical"; count: number; expectCriticalText?: boolean },
) {
  expect(loopResult.stuck).toBe(true);
  if (!loopResult.stuck) {
    return;
  }
  expect(loopResult.level).toBe(expected.level);
  expect(loopResult.detector).toBe("ping_pong");
  expect(loopResult.count).toBe(expected.count);
  if (expected.expectCriticalText) {
    expect(loopResult.message).toContain("CRITICAL");
  }
}

describe("tool-loop-detection", () => {
  describe("hashToolCall", () => {
    it("creates consistent hash for same tool and params", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("read", { path: "/file.txt" });
      expect(hash1).toBe(hash2);
    });

    it("creates different hashes for different params", () => {
      const hash1 = hashToolCall("read", { path: "/file1.txt" });
      const hash2 = hashToolCall("read", { path: "/file2.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("creates different hashes for different tools", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("write", { path: "/file.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("handles non-object params", () => {
      expect(() => hashToolCall("tool", "string-param")).not.toThrow();
      expect(() => hashToolCall("tool", 123)).not.toThrow();
      expect(() => hashToolCall("tool", null)).not.toThrow();
    });

    it("produces deterministic hashes regardless of key order", () => {
      const hash1 = hashToolCall("tool", { a: 1, b: 2 });
      const hash2 = hashToolCall("tool", { b: 2, a: 1 });
      expect(hash1).toBe(hash2);
    });

    it("keeps hashes fixed-size even for large params", () => {
      const payload = { data: "x".repeat(20_000) };
      const hash = hashToolCall("read", payload);
      expect(hash.startsWith("read:")).toBe(true);
      expect(hash.length).toBe("read:".length + 64);
    });
  });

  describe("recordToolCall", () => {
    it("adds tool call to empty history", () => {
      const state = createState();

      recordToolCall(state, "read", { path: "/file.txt" }, "call-1");

      expect(state.toolCallHistory).toHaveLength(1);
      expect(state.toolCallHistory?.[0]?.toolName).toBe("read");
      expect(state.toolCallHistory?.[0]?.toolCallId).toBe("call-1");
    });

    it("maintains sliding window of last N calls", () => {
      const state = createState();

      for (let i = 0; i < TOOL_CALL_HISTORY_SIZE + 10; i += 1) {
        recordToolCall(state, "tool", { iteration: i }, `call-${i}`);
      }

      expect(state.toolCallHistory).toHaveLength(TOOL_CALL_HISTORY_SIZE);

      const oldestCall = state.toolCallHistory?.[0];
      expect(oldestCall?.argsHash).toBe(hashToolCall("tool", { iteration: 10 }));
    });

    it("records timestamp for each call", () => {
      const state = createState();
      const before = Date.now();
      recordToolCall(state, "tool", { arg: 1 }, "call-ts");
      const after = Date.now();

      const timestamp = state.toolCallHistory?.[0]?.timestamp ?? 0;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("respects configured historySize", () => {
      const state = createState();

      for (let i = 0; i < 10; i += 1) {
        recordToolCall(state, "tool", { iteration: i }, `call-${i}`, shortHistoryLoopConfig);
      }

      expect(state.toolCallHistory).toHaveLength(4);
      expect(state.toolCallHistory?.[0]?.argsHash).toBe(hashToolCall("tool", { iteration: 6 }));
    });

    it("skips browser loop hints when browserSearchStorm is disabled", () => {
      const state = createState();

      recordToolCall(
        state,
        "browser",
        { action: "open", url: "https://www.google.com/search?q=openclaw" },
        "browser-disabled",
        {
          enabled: true,
          detectors: {
            browserSearchStorm: false,
          },
        },
      );

      expect(state.toolCallHistory?.[0]?.loopHint).toBeUndefined();
    });
  });

  describe("recordToolCallOutcome", () => {
    it("skips browser loop hints when browserSearchStorm is disabled", () => {
      const state = createState();

      recordToolCallOutcome(state, {
        toolName: "browser",
        toolParams: { action: "open", url: "https://www.google.com/search?q=openclaw" },
        toolCallId: "browser-outcome-disabled",
        result: {
          content: [{ type: "text", text: "results" }],
          details: { ok: true },
        },
        config: {
          enabled: true,
          detectors: {
            browserSearchStorm: false,
          },
        },
      });

      expect(state.toolCallHistory?.[0]?.loopHint).toBeUndefined();
    });

    it("updates the pre-hook browser entry instead of appending a second adjusted search", () => {
      const state = createState();
      const toolCallId = "browser-adjusted";
      const originalParams = {
        action: "open",
        url: "https://www.google.com/search?q=openclaw",
      };
      const adjustedParams = {
        action: "open",
        url: "https://www.google.com/search?q=openclaw+bug",
      };

      recordToolCall(state, "browser", originalParams, toolCallId, enabledLoopDetectionConfig);
      const originalQueryHash = state.toolCallHistory?.[0]?.loopHint?.browserSearch?.queryHash;

      recordToolCallOutcome(state, {
        toolName: "browser",
        toolParams: adjustedParams,
        toolCallId,
        result: {
          content: [{ type: "text", text: "results" }],
          details: { ok: true },
        },
        config: enabledLoopDetectionConfig,
      });

      expect(state.toolCallHistory).toHaveLength(1);
      expect(state.toolCallHistory?.[0]?.argsHash).toBe(hashToolCall("browser", adjustedParams));
      expect(state.toolCallHistory?.[0]?.loopHint?.browserSearch?.queryHash).not.toBe(
        originalQueryHash,
      );
      expect(state.toolCallHistory?.[0]?.resultHash).toBeDefined();
    });

    it("does not rewrite unfinished entries when toolCallId collides across runs", () => {
      const state = createState();
      const sharedToolCallId = "shared-call";

      recordToolCall(
        state,
        "read",
        { path: "/run-a.txt" },
        sharedToolCallId,
        enabledLoopDetectionConfig,
        "run-a",
      );

      recordToolCallOutcome(state, {
        toolName: "read",
        toolParams: { path: "/run-b.txt" },
        toolCallId: sharedToolCallId,
        runId: "run-b",
        result: {
          content: [{ type: "text", text: "run b output" }],
          details: { ok: true },
        },
        config: enabledLoopDetectionConfig,
      });

      expect(state.toolCallHistory).toHaveLength(2);
      const runAEntry = state.toolCallHistory?.find((call) => call.runId === "run-a");
      const runBEntry = state.toolCallHistory?.find((call) => call.runId === "run-b");
      expect(runAEntry?.argsHash).toBe(hashToolCall("read", { path: "/run-a.txt" }));
      expect(runAEntry?.resultHash).toBeUndefined();
      expect(runBEntry?.argsHash).toBe(hashToolCall("read", { path: "/run-b.txt" }));
      expect(runBEntry?.resultHash).toBeDefined();
    });
  });

  describe("detectToolCallLoop", () => {
    it("is disabled by default", () => {
      const state = createState();

      for (let i = 0; i < 20; i += 1) {
        recordToolCall(state, "read", { path: "/same.txt" }, `default-${i}`);
      }

      const loopResult = detectToolCallLoop(state, "read", { path: "/same.txt" });
      expect(loopResult.stuck).toBe(false);
    });

    it("does not flag unique tool calls", () => {
      const state = createState();

      for (let i = 0; i < 15; i += 1) {
        recordToolCall(state, "read", { path: `/file${i}.txt` }, `call-${i}`);
      }

      const result = detectToolCallLoop(
        state,
        "read",
        { path: "/new-file.txt" },
        enabledLoopDetectionConfig,
      );
      expect(result.stuck).toBe(false);
    });

    it("warns on generic repeated tool+args calls", () => {
      const state = createState();
      for (let i = 0; i < WARNING_THRESHOLD; i += 1) {
        recordToolCall(state, "read", { path: "/same.txt" }, `warn-${i}`);
      }

      const result = detectToolCallLoop(
        state,
        "read",
        { path: "/same.txt" },
        enabledLoopDetectionConfig,
      );

      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe("warning");
        expect(result.detector).toBe("generic_repeat");
        expect(result.count).toBe(WARNING_THRESHOLD);
        expect(result.message).toContain("WARNING");
        expect(result.message).toContain(`${WARNING_THRESHOLD} times`);
      }
    });

    it("keeps generic loops warn-only below global breaker threshold", () => {
      const fixture = createReadNoProgressFixture();
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: fixture.toolName,
        toolParams: fixture.params,
        result: fixture.result,
        count: CRITICAL_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
      }
    });

    it("applies custom thresholds when detection is enabled", () => {
      const state = createState();
      const { params, result } = createNoProgressPollFixture("sess-custom");
      const config: ToolLoopDetectionConfig = {
        enabled: true,
        warningThreshold: 2,
        criticalThreshold: 4,
        detectors: {
          genericRepeat: false,
          knownPollNoProgress: true,
          pingPong: false,
        },
      };

      recordRepeatedSuccessfulCalls({
        state,
        toolName: "process",
        toolParams: params,
        result,
        count: 2,
      });
      const warningResult = detectToolCallLoop(state, "process", params, config);
      expect(warningResult.stuck).toBe(true);
      if (warningResult.stuck) {
        expect(warningResult.level).toBe("warning");
      }

      recordRepeatedSuccessfulCalls({
        state,
        toolName: "process",
        toolParams: params,
        result,
        count: 2,
        startIndex: 2,
      });
      const criticalResult = detectToolCallLoop(state, "process", params, config);
      expect(criticalResult.stuck).toBe(true);
      if (criticalResult.stuck) {
        expect(criticalResult.level).toBe("critical");
        expect(criticalResult.detector).toBe("known_poll_no_progress");
      }
    });

    it("can disable specific detectors", () => {
      const state = createState();
      const { params, result } = createNoProgressPollFixture("sess-no-detectors");
      const config: ToolLoopDetectionConfig = {
        enabled: true,
        detectors: {
          genericRepeat: false,
          knownPollNoProgress: false,
          pingPong: false,
        },
      };

      recordRepeatedSuccessfulCalls({
        state,
        toolName: "process",
        toolParams: params,
        result,
        count: CRITICAL_THRESHOLD,
      });

      const loopResult = detectToolCallLoop(state, "process", params, config);
      expect(loopResult.stuck).toBe(false);
    });

    it("warns for known polling no-progress loops", () => {
      const { params, result } = createNoProgressPollFixture("sess-1");
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: "process",
        toolParams: params,
        result,
        count: WARNING_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("known_poll_no_progress");
        expect(loopResult.message).toContain("no progress");
      }
    });

    it("blocks known polling no-progress loops at critical threshold", () => {
      const { params, result } = createNoProgressPollFixture("sess-1");
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: "process",
        toolParams: params,
        result,
        count: CRITICAL_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("known_poll_no_progress");
        expect(loopResult.message).toContain("CRITICAL");
      }
    });

    it("does not block known polling when output progresses", () => {
      const state = createState();
      const params = { action: "poll", sessionId: "sess-1" };

      for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
        const result = {
          content: [{ type: "text", text: `line ${i}` }],
          details: { status: "running", aggregated: `line ${i}` },
        };
        recordSuccessfulCall(state, "process", params, result, i);
      }

      const loopResult = detectToolCallLoop(state, "process", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(false);
    });

    it("warns on browser search storms across changing queries", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: Array.from(
          { length: BROWSER_SEARCH_WARNING_THRESHOLD },
          (_, index) => `openclaw issue ${index}`,
        ),
      });

      const current = createBrowserSearchFixture("openclaw issue next");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("browser_search_storm");
        expect(loopResult.count).toBe(BROWSER_SEARCH_WARNING_THRESHOLD);
        expect(loopResult.message).toContain("prior browser search-page opens");
      }
    });

    it("does not warn on the first query change after identical history", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: Array.from(
          { length: BROWSER_SEARCH_WARNING_THRESHOLD },
          () => "openclaw repeated query",
        ),
      });

      const current = createBrowserSearchFixture("openclaw first variation");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("resets the browser search storm streak once searches settle on one query", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: ["openclaw initial", "openclaw varied", "openclaw varied", "openclaw varied"],
      });

      const current = createBrowserSearchFixture("openclaw varied");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("resets the browser search storm streak after opening a non-search page", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: ["openclaw issue 0", "openclaw issue 1", "openclaw issue 2", "openclaw issue 3"],
      });

      const openedResultPage = createBrowserPageFixture("https://example.com/openclaw/result");
      recordSuccessfulCall(
        state,
        openedResultPage.toolName,
        openedResultPage.params,
        openedResultPage.result,
        4,
      );

      recordSuccessfulBrowserSearchCalls({
        state,
        queries: ["openclaw follow-up 0", "openclaw follow-up 1", "openclaw follow-up 2"],
        startIndex: 5,
      });

      const current = createBrowserSearchFixture("openclaw follow-up next");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("resets the browser search storm streak after browser act click navigation", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: ["openclaw issue 0", "openclaw issue 1", "openclaw issue 2", "openclaw issue 3"],
      });

      const clickedResult = createBrowserActClickFixture("5");
      recordSuccessfulCall(
        state,
        clickedResult.toolName,
        clickedResult.params,
        clickedResult.result,
        4,
      );

      recordSuccessfulBrowserSearchCalls({
        state,
        queries: ["openclaw follow-up 0", "openclaw follow-up 1", "openclaw follow-up 2"],
        startIndex: 5,
      });

      const current = createBrowserSearchFixture("openclaw follow-up next");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("only counts the non-repeating active browser-search tail", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: ["openclaw issue A", "openclaw issue B", "openclaw issue A", "openclaw issue C"],
      });

      const current = createBrowserSearchFixture("openclaw issue D");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("blocks browser search storms at critical threshold", () => {
      const state = createState();
      recordSuccessfulBrowserSearchCalls({
        state,
        queries: Array.from(
          { length: BROWSER_SEARCH_CRITICAL_THRESHOLD },
          (_, index) => `openclaw loop detection ${index}`,
        ),
        hostAtIndex: (index) => (index % 2 === 0 ? "www.google.com" : "www.bing.com"),
      });

      const current = createBrowserSearchFixture("openclaw loop detection next", "www.bing.com");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("browser_search_storm");
        expect(loopResult.count).toBe(BROWSER_SEARCH_CRITICAL_THRESHOLD);
        expect(loopResult.message).toContain("CRITICAL");
      }
    });

    it("matches Yandex search pages with a trailing slash", () => {
      const state = createState();
      for (let i = 0; i < BROWSER_SEARCH_WARNING_THRESHOLD; i += 1) {
        const fixture = createBrowserSearchFixture(`yandex issue ${i}`, "yandex.com", {
          path: "/search/",
          queryParam: "text",
        });
        recordSuccessfulCall(state, fixture.toolName, fixture.params, fixture.result, i);
      }

      const current = createBrowserSearchFixture("yandex issue next", "yandex.com", {
        path: "/search/",
        queryParam: "text",
      });
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.detector).toBe("browser_search_storm");
        expect(loopResult.count).toBe(BROWSER_SEARCH_WARNING_THRESHOLD);
      }
    });

    it("matches browser search pages opened via navigate targetUrl", () => {
      const state = createState();
      for (let i = 0; i < BROWSER_SEARCH_WARNING_THRESHOLD; i += 1) {
        const fixture = createBrowserSearchFixture(`navigate issue ${i}`, "www.google.com", {
          action: "navigate",
          urlField: "targetUrl",
        });
        recordSuccessfulCall(state, fixture.toolName, fixture.params, fixture.result, i);
      }

      const current = createBrowserSearchFixture("navigate issue next", "www.google.com", {
        action: "navigate",
        urlField: "targetUrl",
      });
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.detector).toBe("browser_search_storm");
        expect(loopResult.count).toBe(BROWSER_SEARCH_WARNING_THRESHOLD);
      }
    });

    it("matches in-tab browser search submissions via act type submit", () => {
      const state = createState();
      const targetId = "tab-submit";
      const openedSearch = createBrowserSearchFixture("submit issue 0", "www.google.com", {
        targetId,
      });

      recordSuccessfulCall(
        state,
        openedSearch.toolName,
        openedSearch.params,
        openedSearch.result,
        0,
      );

      for (let i = 1; i < BROWSER_SEARCH_WARNING_THRESHOLD; i += 1) {
        const typedSearch = createBrowserActTypeFixture(`submit issue ${i}`, targetId, {
          submit: true,
        });
        recordSuccessfulCall(
          state,
          typedSearch.toolName,
          typedSearch.params,
          typedSearch.result,
          i,
        );
      }

      const current = createBrowserActTypeFixture(
        `submit issue ${BROWSER_SEARCH_WARNING_THRESHOLD}`,
        targetId,
        { submit: true },
      );
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("browser_search_storm");
        expect(loopResult.count).toBe(BROWSER_SEARCH_WARNING_THRESHOLD);
      }
    });

    it("matches in-tab browser search submissions via act press Enter", () => {
      const state = createState();
      const targetId = "tab-enter";
      const openedSearch = createBrowserSearchFixture("enter issue 0", "www.google.com", {
        targetId,
      });
      recordSuccessfulCall(
        state,
        openedSearch.toolName,
        openedSearch.params,
        openedSearch.result,
        0,
      );

      for (let i = 1; i < BROWSER_SEARCH_WARNING_THRESHOLD; i += 1) {
        const draft = createBrowserActTypeFixture(`enter issue ${i}`, targetId, {
          submit: false,
        });
        const press = createBrowserActPressFixture("Enter", targetId);
        recordSuccessfulCall(state, draft.toolName, draft.params, draft.result, i * 2 - 1);
        recordSuccessfulCall(state, press.toolName, press.params, press.result, i * 2);
      }

      const currentDraft = createBrowserActTypeFixture(
        `enter issue ${BROWSER_SEARCH_WARNING_THRESHOLD}`,
        targetId,
        {
          submit: false,
        },
      );
      recordSuccessfulCall(
        state,
        currentDraft.toolName,
        currentDraft.params,
        currentDraft.result,
        BROWSER_SEARCH_WARNING_THRESHOLD * 2 - 1,
      );

      const current = createBrowserActPressFixture("Enter", targetId);
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("browser_search_storm");
        expect(loopResult.count).toBe(BROWSER_SEARCH_WARNING_THRESHOLD);
      }
    });

    it("does not treat duckduckgo.com/html without a trailing slash as a search hop", () => {
      const state = createState();
      for (let i = 0; i < BROWSER_SEARCH_CRITICAL_THRESHOLD + 2; i += 1) {
        const fixture = createBrowserSearchFixture(`duck issue ${i}`, "duckduckgo.com", {
          path: "/html",
          queryParam: "q",
        });
        recordSuccessfulCall(state, fixture.toolName, fixture.params, fixture.result, i);
      }

      const current = createBrowserSearchFixture("duck issue next", "duckduckgo.com", {
        path: "/html",
        queryParam: "q",
      });
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("does not treat google.evil.com search pages as Google search hops", () => {
      const state = createState();
      for (let i = 0; i < BROWSER_SEARCH_CRITICAL_THRESHOLD + 2; i += 1) {
        const fixture = createBrowserSearchFixture(`evil google issue ${i}`, "google.evil.com");
        recordSuccessfulCall(state, fixture.toolName, fixture.params, fixture.result, i);
      }

      const current = createBrowserSearchFixture("evil google issue next", "google.evil.com");
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("does not treat yandex.evil.com search pages as Yandex search hops", () => {
      const state = createState();
      for (let i = 0; i < BROWSER_SEARCH_CRITICAL_THRESHOLD + 2; i += 1) {
        const fixture = createBrowserSearchFixture(`evil yandex issue ${i}`, "yandex.evil.com", {
          path: "/search/",
          queryParam: "text",
        });
        recordSuccessfulCall(state, fixture.toolName, fixture.params, fixture.result, i);
      }

      const current = createBrowserSearchFixture("evil yandex issue next", "yandex.evil.com", {
        path: "/search/",
        queryParam: "text",
      });
      const loopResult = detectToolCallLoop(
        state,
        current.toolName,
        current.params,
        enabledLoopDetectionConfig,
      );

      expect(loopResult.stuck).toBe(false);
    });

    it("does not flag normal browser page opens as a browser search storm", () => {
      const state = createState();
      for (let i = 0; i < BROWSER_SEARCH_CRITICAL_THRESHOLD + 2; i += 1) {
        recordSuccessfulCall(
          state,
          "browser",
          { action: "open", url: `https://example.com/page-${i}` },
          { content: [{ type: "text", text: `page ${i}` }], details: { ok: true } },
          i,
        );
      }

      const loopResult = detectToolCallLoop(
        state,
        "browser",
        { action: "open", url: "https://example.com/final" },
        enabledLoopDetectionConfig,
      );
      expect(loopResult.stuck).toBe(false);
    });

    it("blocks any tool with global no-progress breaker at 30", () => {
      const fixture = createReadNoProgressFixture();
      const loopResult = detectLoopAfterRepeatedCalls({
        toolName: fixture.toolName,
        toolParams: fixture.params,
        result: fixture.result,
        count: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("global_circuit_breaker");
        expect(loopResult.message).toContain("global circuit breaker");
      }
    });

    it("warns on ping-pong alternating patterns", () => {
      const state = createState();
      const readParams = { path: "/a.txt" };
      const listParams = { dir: "/workspace" };

      for (let i = 0; i < WARNING_THRESHOLD - 1; i += 1) {
        if (i % 2 === 0) {
          recordToolCall(state, "read", readParams, `read-${i}`);
        } else {
          recordToolCall(state, "list", listParams, `list-${i}`);
        }
      }

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, { level: "warning", count: WARNING_THRESHOLD });
      if (loopResult.stuck) {
        expect(loopResult.message).toContain("ping-pong loop");
      }
    });

    it("blocks ping-pong alternating patterns at critical threshold", () => {
      const { state, readParams, listParams } = createPingPongFixture();

      recordSuccessfulPingPongCalls({
        state,
        readParams,
        listParams,
        count: CRITICAL_THRESHOLD - 1,
        textAtIndex: (toolName) => (toolName === "read" ? "read stable" : "list stable"),
      });

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, {
        level: "critical",
        count: CRITICAL_THRESHOLD,
        expectCriticalText: true,
      });
      if (loopResult.stuck) {
        expect(loopResult.message).toContain("ping-pong loop");
      }
    });

    it("does not block ping-pong at critical threshold when outcomes are progressing", () => {
      const { state, readParams, listParams } = createPingPongFixture();

      recordSuccessfulPingPongCalls({
        state,
        readParams,
        listParams,
        count: CRITICAL_THRESHOLD - 1,
        textAtIndex: (toolName, index) => `${toolName} ${index}`,
      });

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, { level: "warning", count: CRITICAL_THRESHOLD });
    });

    it("does not flag ping-pong when alternation is broken", () => {
      const state = createState();
      recordToolCall(state, "read", { path: "/a.txt" }, "a1");
      recordToolCall(state, "list", { dir: "/workspace" }, "b1");
      recordToolCall(state, "read", { path: "/a.txt" }, "a2");
      recordToolCall(state, "write", { path: "/tmp/out.txt" }, "c1"); // breaks alternation

      const loopResult = detectToolCallLoop(
        state,
        "list",
        { dir: "/workspace" },
        enabledLoopDetectionConfig,
      );
      expect(loopResult.stuck).toBe(false);
    });

    it("records fixed-size result hashes for large tool outputs", () => {
      const state = createState();
      const params = { action: "log", sessionId: "sess-big" };
      const toolCallId = "log-big";
      recordToolCall(state, "process", params, toolCallId);
      recordToolCallOutcome(state, {
        toolName: "process",
        toolParams: params,
        toolCallId,
        result: {
          content: [{ type: "text", text: "y".repeat(40_000) }],
          details: { status: "running", totalLines: 1, totalChars: 40_000 },
        },
      });

      const entry = state.toolCallHistory?.find((call) => call.toolCallId === toolCallId);
      expect(typeof entry?.resultHash).toBe("string");
      expect(entry?.resultHash?.length).toBe(64);
    });

    it("handles empty history", () => {
      const state = createState();

      const result = detectToolCallLoop(state, "tool", { arg: 1 }, enabledLoopDetectionConfig);
      expect(result.stuck).toBe(false);
    });
  });

  describe("getToolCallStats", () => {
    it("returns zero stats for empty history", () => {
      const state = createState();

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });

    it("counts total calls and unique patterns", () => {
      const state = createState();

      for (let i = 0; i < 5; i += 1) {
        recordToolCall(state, "read", { path: "/file.txt" }, `same-${i}`);
      }

      recordToolCall(state, "write", { path: "/output.txt" }, "write-1");
      recordToolCall(state, "list", { dir: "/home" }, "list-1");
      recordToolCall(state, "read", { path: "/other.txt" }, "read-other");

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(8);
      expect(stats.uniquePatterns).toBe(4);
    });

    it("identifies most frequent pattern", () => {
      const state = createState();

      for (let i = 0; i < 3; i += 1) {
        recordToolCall(state, "read", { path: "/file1.txt" }, `p1-${i}`);
      }

      for (let i = 0; i < 7; i += 1) {
        recordToolCall(state, "read", { path: "/file2.txt" }, `p2-${i}`);
      }

      for (let i = 0; i < 2; i += 1) {
        recordToolCall(state, "write", { path: "/output.txt" }, `p3-${i}`);
      }

      const stats = getToolCallStats(state);
      expect(stats.mostFrequent?.toolName).toBe("read");
      expect(stats.mostFrequent?.count).toBe(7);
    });
  });
});
