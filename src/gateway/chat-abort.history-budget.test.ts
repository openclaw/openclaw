import { describe, expect, it, vi } from "vitest";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { resolveInFlightRunSnapshot, type ChatAbortControllerEntry } from "./chat-abort.js";
import { updateChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import { createChatRunState, type ChatRunPlanSnapshot } from "./server-chat-state.js";
import { boundInFlightRunSnapshotForChatHistory } from "./server-methods/chat-history-budget.js";

it.each([2, 50])("keeps the newest %i progress events with bounded serialization", (retained) => {
  let progress: ReturnType<typeof updateChatRunProgressSnapshot>;
  for (let index = 0; index < 50; index++) {
    progress = updateChatRunProgressSnapshot(progress, {
      runId: "run-budget",
      seq: index + 1,
      stream: "tool",
      ts: 1_000 + index,
      data: {
        phase: "result",
        name: "read",
        toolCallId: `tool-${index}`,
        result: '漢字\n"\\'.repeat(200),
      },
    });
  }
  const events = progress?.events ?? [];
  expect(events).toHaveLength(50);
  const snapshot = { runId: "run-budget", text: "x".repeat(200_000), startedAt: 1_000, events };
  const original = JSON.stringify(snapshot);
  const expected = { ...snapshot, text: "", events: events.slice(-retained) };
  const maxBytes = 2 + Buffer.byteLength(JSON.stringify(expected));
  const inputBytes = 2 + Buffer.byteLength(original);
  const stringify = JSON.stringify;
  let serializedBytes = 0;
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const result = stringify(...args);
    serializedBytes += typeof result === "string" ? Buffer.byteLength(result) : 0;
    return result;
  });
  let result;
  try {
    result = boundInFlightRunSnapshotForChatHistory({ snapshot, messages: [], maxBytes });
  } finally {
    serialization.mockRestore();
  }
  expect(result).toEqual(expected);
  expect(2 + Buffer.byteLength(JSON.stringify(result))).toBe(maxBytes);
  expect(JSON.stringify(snapshot)).toBe(original);
  expect(serializedBytes).toBeLessThan(inputBytes * 3);
});

describe("resolveInFlightRunSnapshot", () => {
  const inFlightEntry = (
    sessionKey: string,
    opts?: {
      agentId?: string;
      aborted?: boolean;
      controlUiVisible?: boolean;
      projectSessionActive?: boolean;
      startedAtMs?: number;
      kind?: ChatAbortControllerEntry["kind"];
    },
  ): ChatAbortControllerEntry => {
    const now = Date.now();
    const controller = new AbortController();
    if (opts?.aborted) {
      controller.abort();
    }
    const startedAtMs = opts?.startedAtMs ?? now;
    return {
      controller,
      sessionId: "sess-1",
      sessionKey,
      agentId: opts?.agentId,
      startedAtMs,
      expiresAtMs: startedAtMs + 10_000,
      controlUiVisible: opts?.controlUiVisible,
      projectSessionActive: opts?.projectSessionActive ?? true,
      kind: opts?.kind,
    };
  };

  // Most cases request with requestedKey === canonicalKey; default canonical to
  // the requested key unless a case exercises the requested/canonical split.
  const resolveSnap = (p: {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    chatRunBuffers: Map<string, string>;
    chatRunPlanSnapshots?: Map<string, ChatRunPlanSnapshot>;
    sessionKey: string;
    canonicalSessionKey?: string;
    agentId?: string;
    defaultAgentId?: string;
  }) => {
    const chatRunState = createChatRunState();
    for (const [runId, buffer] of p.chatRunBuffers ?? []) {
      chatRunState.getOrCreate(runId).buffer = buffer;
    }
    for (const [runId, plan] of p.chatRunPlanSnapshots ?? []) {
      chatRunState.getOrCreate(runId).planSnapshot = plan;
    }
    return resolveInFlightRunSnapshot({
      chatAbortControllers: p.chatAbortControllers,
      chatRunState,
      requestedSessionKey: p.sessionKey,
      canonicalSessionKey: p.canonicalSessionKey ?? p.sessionKey,
      agentId: p.agentId,
      defaultAgentId: p.defaultAgentId,
    });
  };
  const snap = (p: Parameters<typeof resolveSnap>[0]) => {
    const result = resolveSnap(p);
    if (result) {
      Reflect.deleteProperty(result, "startedAt");
    }
    return result;
  };

  it("returns an explicit empty plan snapshot for dismissal", () => {
    expect(
      snap({
        chatAbortControllers: new Map([["run-1", inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map(),
        chatRunPlanSnapshots: new Map([["run-1", { steps: [] }]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-1", text: "", plan: { steps: [] } });
  });

  it("matches a run stored under the canonical key when requested with a different key", () => {
    // Abort entry holds the canonical store key; the client requests history with
    // a different (requested) key for the same logical session.
    const result = snap({
      chatAbortControllers: new Map([["run-1", inFlightEntry("agent:main:main")]]),
      chatRunBuffers: new Map([["run-1", "partial"]]),
      sessionKey: "main",
      canonicalSessionKey: "agent:main:main",
    });
    expect(result).toEqual({ runId: "run-1", text: "partial" });
  });

  it("ignores aborted, completed (not projected active), and other-session runs", () => {
    const variants: ChatAbortControllerEntry[] = [
      inFlightEntry("agent:main:s", { aborted: true }),
      inFlightEntry("agent:main:s", { projectSessionActive: false }),
      inFlightEntry("agent:main:s", { controlUiVisible: false }),
      inFlightEntry("agent:main:other"),
    ];
    for (const entry of variants) {
      expect(
        snap({
          chatAbortControllers: new Map([["run", entry]]),
          chatRunBuffers: new Map([["run", "text"]]),
          sessionKey: "agent:main:s",
        }),
      ).toBeUndefined();
    }
  });

  it("ignores hidden agent runs that are not visible chat sends", () => {
    expect(
      snap({
        chatAbortControllers: new Map([
          ["run-agent", inFlightEntry("agent:main:s", { kind: "agent" })],
        ]),
        chatRunBuffers: new Map([["run-agent", "hidden partial"]]),
        sessionKey: "agent:main:s",
      }),
    ).toBeUndefined();
  });

  it("does not surface suppressed control-token lead fragments from the live buffer", () => {
    expect(
      snap({
        chatAbortControllers: new Map([["run", inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map([["run", "NO_"]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "" });
  });

  it("scopes the shared global session by agent so one agent's run is not restored into another", () => {
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-a", inFlightEntry("global", { agentId: "main" })],
      ["run-b", inFlightEntry("global", { agentId: "work" })],
    ]);
    const buffers = new Map([
      ["run-a", "main agent global text"],
      ["run-b", "work agent global text"],
    ]);
    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({ runId: "run-b", text: "work agent global text" });
    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        agentId: "main",
      }),
    ).toEqual({ runId: "run-a", text: "main agent global text" });
  });

  it("resolves bare global history snapshots to the default agent", () => {
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-main", inFlightEntry("global", { agentId: "main", startedAtMs: 1_000 })],
      ["run-work", inFlightEntry("global", { agentId: "work", startedAtMs: 2_000 })],
    ]);
    const buffers = new Map([
      ["run-main", "main default text"],
      ["run-work", "work global text"],
    ]);

    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        defaultAgentId: "main",
      }),
    ).toEqual({ runId: "run-main", text: "main default text" });
  });

  it("prefers the newest startedAtMs when several runs match the same session+agent", () => {
    // A fast restart/retry/stale-controller race can leave two active entries for
    // the same key; selection must not depend on Map insertion order. Insert the
    // older run first so a first-match selector would return the wrong one.
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-old", inFlightEntry("agent:main:s", { startedAtMs: 1_000 })],
      ["run-new", inFlightEntry("agent:main:s", { startedAtMs: 2_000 })],
    ]);
    const buffers = new Map([
      ["run-old", "stale partial"],
      ["run-new", "current partial"],
    ]);
    expect(
      snap({
        chatAbortControllers: controllers,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-new", text: "current partial" });
  });

  it("breaks startedAtMs ties deterministically by runId regardless of insertion order", () => {
    const buffers = new Map([
      ["run-a", "a"],
      ["run-b", "b"],
    ]);
    const ascending = new Map<string, ChatAbortControllerEntry>([
      ["run-a", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
      ["run-b", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
    ]);
    const descending = new Map<string, ChatAbortControllerEntry>([
      ["run-b", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
      ["run-a", inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
    ]);
    // Same winner ("run-b" > "run-a") no matter which order the map was built in.
    expect(
      snap({
        chatAbortControllers: ascending,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-b", text: "b" });
    expect(
      snap({
        chatAbortControllers: descending,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-b", text: "b" });
  });

  it("drops startedAt when the former minimal fallback exactly fills the budget", () => {
    const messages = [{ role: "user", content: "near budget" }];
    const minimal = { runId: "run-1", text: "" };
    const maxBytes = jsonUtf8Bytes(messages) + jsonUtf8Bytes(minimal);
    const result = boundInFlightRunSnapshotForChatHistory({
      snapshot: { runId: "run-1", text: "x", startedAt: 1_000 },
      messages,
      maxBytes,
    });
    expect(result).toEqual(minimal);
    expect(jsonUtf8Bytes(messages) + jsonUtf8Bytes(result)).toBeLessThanOrEqual(maxBytes);
  });

  it("keeps small buffered text and clears an oversized plan explicitly", () => {
    // Absence means legacy-gateway unknown to clients; a budget drop must send
    // an explicit empty plan so retained stale checklists cannot survive.
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "short answer",
          plan: {
            steps: [{ step: "x".repeat(500), status: "pending" }],
          },
        },
        messages: [],
        maxBytes: 200,
      }),
    ).toEqual({ runId: "run-1", text: "short answer", plan: { steps: [] } });
  });

  it("prioritizes active progress and explicitly clears budget-dropped projections", () => {
    const event = {
      runId: "run-1",
      seq: 2,
      stream: "tool" as const,
      ts: 1_000,
      data: { phase: "start", name: "read", toolCallId: "tool-1", args: {} },
    };
    const expected = {
      runId: "run-1",
      text: "",
      events: [event],
      plan: { steps: [] },
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "x".repeat(1_000),
          events: [event],
          plan: { steps: [{ step: "y".repeat(1_000), status: "in_progress" }] },
        },
        messages: [],
        maxBytes: jsonUtf8Bytes([]) + jsonUtf8Bytes(expected),
      }),
    ).toEqual(expected);

    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "", events: [event] },
        messages: [],
        maxBytes: jsonUtf8Bytes([]) + jsonUtf8Bytes({ runId: "run-1", text: "", events: [] }),
      }),
    ).toEqual({ runId: "run-1", text: "", events: [] });
  });
});
