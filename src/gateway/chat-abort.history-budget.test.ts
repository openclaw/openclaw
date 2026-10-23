import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import type { RpcSourceAdapter, RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import {
  initializeRpcSourceTiming,
  markRpcSourceExecutionStarted,
  requestRpcSourceCancellation,
} from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { resolveInFlightRunSnapshot } from "./chat-inflight-snapshot.runtime.js";
import { updateChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import { createChatRunState, type ChatRunPlanSnapshot } from "./server-chat-state.js";
import { boundInFlightRunSnapshotForChatHistory } from "./server-methods/chat-history-budget.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

afterEach(() => vi.useRealTimers());

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

describe("resolveInFlightRunSnapshot", async () => {
  const inFlightEntry = async (
    sessionKey: string,
    opts?: {
      agentId?: string;
      aborted?: boolean;
      controlUiVisible?: boolean;
      projectSessionActive?: boolean;
      startedAtMs?: number;
      kind?: RpcSourceAdapter["kind"];
      storePath?: string;
    },
  ): Promise<RpcSourceRef> => {
    if (opts?.startedAtMs !== undefined) {
      vi.useFakeTimers();
      vi.setSystemTime(opts.startedAtMs);
    }
    const source = createRpcSourceForTest(
      {
        controlUiVisible: opts?.controlUiVisible,
        projectSessionActive: opts?.projectSessionActive ?? true,
        kind: opts?.kind,
      },
      {
        sessionKey,
        sessionId: `${sessionKey}-fixture-session`,
        agentId: opts?.agentId,
        storeScope:
          opts?.storePath ??
          (sessionKey === "global" ? "/synthetic/history-global/sessions.db" : undefined),
      },
    );
    await claimRpcSourceForTest(source);
    if (opts?.aborted) {
      requestRpcSourceCancellation(source);
    }
    return source;
  };

  // Most cases request with requestedKey === canonicalKey; default canonical to
  // the requested key unless a case exercises the requested/canonical split.
  const resolveSnap = (p: {
    sources: Map<string, RpcSourceRef>;
    chatRunBuffers: Map<string, string>;
    chatRunPlanSnapshots?: Map<string, ChatRunPlanSnapshot>;
    sessionKey: string;
    canonicalSessionKey?: string;
    agentId?: string;
    defaultAgentId?: string;
    storePath?: string;
  }) => {
    rpcSourceTesting.reset(p.sources);
    const chatRunState = createChatRunState();
    for (const [runId, buffer] of p.chatRunBuffers ?? []) {
      chatRunState.getOrCreate(runId).buffer = buffer;
    }
    for (const [runId, plan] of p.chatRunPlanSnapshots ?? []) {
      chatRunState.getOrCreate(runId).planSnapshot = plan;
    }
    return resolveInFlightRunSnapshot({
      chatRunState,
      storePath:
        p.storePath ??
        p.sources.values().next().value?.input.target?.storeScope ??
        "/synthetic/history-empty/sessions.db",
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

  it("replays accepted preparation before execution until cancellation", () => {
    const runId = "preparing-repository";
    const sessionKey = "agent:main:repository";
    const storePath = "/synthetic/repository/sessions.db";
    const source = createRpcSourceForTest(
      {},
      { runId, sessionKey, storeScope: storePath, accepted: true },
    );
    rpcSourceTesting.reset(new Map([[runId, source]]));
    const chatRunState = createChatRunState();
    chatRunState.recordProgressEvent(runId, {
      runId,
      sessionKey,
      seq: 1,
      ts: 1,
      stream: "run_status",
      data: { phase: "preparing_worktree_base" },
    });
    const resolve = () =>
      resolveInFlightRunSnapshot({
        chatRunState,
        storePath,
        requestedSessionKey: sessionKey,
        canonicalSessionKey: sessionKey,
      });
    expect(resolve()).toMatchObject({
      runId,
      events: [{ data: { phase: "preparing_worktree_base" } }],
    });
    requestRpcSourceCancellation(source);
    expect(resolve()).toBeUndefined();
  });

  it("omits execution timing until a queued source actually starts", async () => {
    const source = createRpcSourceForTest(
      { projectSessionActive: true },
      { runId: "queued-clock", sessionKey: "agent:main:queued-clock" },
    );
    rpcSourceTesting.reset(new Map([["queued-clock", source]]));
    initializeRpcSourceTiming(source, { timeoutMs: 60_000 });
    await claimRpcSourceForTest(source);
    const params = {
      sources: new Map([["queued-clock", source]]),
      chatRunBuffers: new Map<string, string>(),
      sessionKey: "agent:main:queued-clock",
    };
    expect(resolveSnap(params)).toEqual({ runId: "queued-clock", text: "" });
    const now = Date.now();
    expect(markRpcSourceExecutionStarted(source)).toBe(true);
    expect(resolveSnap(params)).toEqual({
      runId: "queued-clock",
      text: "",
      startedAt: expect.any(Number),
    });
    expect(resolveSnap(params)?.startedAt).toBeGreaterThanOrEqual(now);
  });

  it("returns an explicit empty plan snapshot for dismissal", async () => {
    expect(
      snap({
        sources: new Map([["run-1", await inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map(),
        chatRunPlanSnapshots: new Map([["run-1", { steps: [] }]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-1", text: "", plan: { steps: [] } });
  });

  it("matches a run stored under the canonical key when requested with a different key", async () => {
    // Abort entry holds the canonical store key; the client requests history with
    // a different (requested) key for the same logical session.
    const result = snap({
      sources: new Map([["run-1", await inFlightEntry("agent:main:main")]]),
      chatRunBuffers: new Map([["run-1", "partial"]]),
      sessionKey: "main",
      canonicalSessionKey: "agent:main:main",
    });
    expect(result).toEqual({ runId: "run-1", text: "partial" });
  });

  it("ignores aborted, completed, hidden, internal agent, and other-session runs", async () => {
    const variants: RpcSourceRef[] = [
      await inFlightEntry("agent:main:s", { aborted: true }),
      await inFlightEntry("agent:main:s", { projectSessionActive: false }),
      await inFlightEntry("agent:main:s", { controlUiVisible: false }),
      await inFlightEntry("agent:main:s", { kind: "agent" }),
      await inFlightEntry("agent:main:other"),
    ];
    for (const entry of variants) {
      expect(
        snap({
          sources: new Map([["run", entry]]),
          chatRunBuffers: new Map([["run", "text"]]),
          sessionKey: "agent:main:s",
        }),
      ).toBeUndefined();
    }
  });

  it("preserves literal partial control-token text from the live buffer", async () => {
    expect(
      snap({
        sources: new Map([["run", await inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map([["run", "NO_"]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "NO_" });
  });

  it.each([
    { agentId: "work", defaultAgentId: undefined, expected: "work" },
    { agentId: undefined, defaultAgentId: "main", expected: "main" },
  ])(
    "scopes global history to $expected when requested agent is $agentId",
    async ({ agentId, defaultAgentId, expected }) => {
      const controllers = new Map<string, RpcSourceRef>([
        ["run-main", await inFlightEntry("global", { agentId: "main", startedAtMs: 1_000 })],
        ["run-work", await inFlightEntry("global", { agentId: "work", startedAtMs: 2_000 })],
      ]);
      const buffers = new Map([
        ["run-main", "main global text"],
        ["run-work", "work global text"],
      ]);

      expect(
        snap({
          sources: controllers,
          chatRunBuffers: buffers,
          sessionKey: "global",
          agentId,
          defaultAgentId,
        }),
      ).toEqual({ runId: `run-${expected}`, text: `${expected} global text` });
    },
  );

  it("prefers the newest startedAtMs across the requested and canonical session keys", async () => {
    const storePath = "/synthetic/history-aliases/sessions.db";
    const controllers = new Map<string, RpcSourceRef>([
      ["run-old", await inFlightEntry("agent:main:requested", { startedAtMs: 1_000, storePath })],
      ["run-new", await inFlightEntry("agent:main:canonical", { startedAtMs: 2_000, storePath })],
    ]);
    const buffers = new Map([
      ["run-old", "stale partial"],
      ["run-new", "current partial"],
    ]);
    expect(
      snap({
        sources: controllers,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:requested",
        canonicalSessionKey: "agent:main:canonical",
        storePath,
      }),
    ).toEqual({ runId: "run-new", text: "current partial" });
  });

  it.each([false, true])(
    "breaks startedAtMs ties by runId (reverse insertion=%s)",
    async (reverse) => {
      const storePath = "/synthetic/history-tie/sessions.db";
      const buffers = new Map([
        ["run-a", "a"],
        ["run-b", "b"],
      ]);
      const entries: [string, RpcSourceRef][] = [
        ["run-a", await inFlightEntry("agent:main:requested", { startedAtMs: 5_000, storePath })],
        ["run-b", await inFlightEntry("agent:main:canonical", { startedAtMs: 5_000, storePath })],
      ];
      expect(
        snap({
          sources: new Map(reverse ? entries.toReversed() : entries),
          chatRunBuffers: buffers,
          sessionKey: "agent:main:requested",
          canonicalSessionKey: "agent:main:canonical",
          storePath,
        }),
      ).toEqual({ runId: "run-b", text: "b" });
    },
  );

  it("excludes a newer run with the same logical identity in another physical store", async () => {
    const local = await inFlightEntry("agent:main:s", { startedAtMs: 1_000 });
    const foreign = await inFlightEntry("agent:main:s", { startedAtMs: 2_000 });
    expect(
      snap({
        sources: new Map([
          ["local", local],
          ["foreign", foreign],
        ]),
        chatRunBuffers: new Map([
          ["local", "local partial"],
          ["foreign", "foreign partial"],
        ]),
        sessionKey: "agent:main:s",
        storePath: local.input.target!.storeScope,
      }),
    ).toEqual({ runId: "local", text: "local partial" });
  });

  it("drops startedAt when the former minimal fallback exactly fills the budget", async () => {
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

  it("keeps small buffered text and clears an oversized plan explicitly", async () => {
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

  it("prioritizes active progress and explicitly clears budget-dropped projections", async () => {
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
