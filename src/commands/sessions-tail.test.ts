import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.test-support.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand } from "./sessions-tail.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  callGatewayFromCliWithTransport: vi.fn(),
}));

// mock-isolation: Session-tail fixtures select synthetic Gateway settings without reading operator state.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("./test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "getRuntimeConfig"),
  };
});

// mock-isolation: Exercise CLI selection without connecting to an operator Gateway.
vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGatewayFromCliWithTransport,
}));

const sessionKey = "agent:main:telegram:direct:owner";

function makeEvent(params: Partial<TrajectoryEvent> & { type: string }): TrajectoryEvent {
  return {
    ts: "2026-05-18T12:04:21.000Z",
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    seq: 1,
    sessionId: "session-one",
    sessionKey,
    ...params,
  };
}

function runtimeOutput(runtime: RuntimeEnv): string {
  return vi
    .mocked(runtime.log)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sessions-tail-");

function toolResult(name: string, extra: Partial<TrajectoryEvent> = {}) {
  return makeEvent({ type: "tool.result", data: { name, success: true }, ...extra });
}

function modelCompleted(data?: TrajectoryEvent["data"]) {
  return makeEvent({
    type: "model.completed",
    ts: "2026-05-18T12:04:29.000Z",
    provider: "openai",
    modelId: "gpt-5.2",
    data,
  });
}

describe("sessionsTailCommand", () => {
  let runtime: ReturnType<typeof createTestRuntime>;
  const tail = (options?: Parameters<typeof sessionsTailCommand>[0]) =>
    sessionsTailCommand(options ?? { agent: "main", store: storePath, sessionKey }, runtime);

  let tmpDir: string;
  let storePath: string;
  const explicitTail = (options: Parameters<typeof sessionsTailCommand>[0] = {}) =>
    tail({ agent: "main", store: storePath, sessionKey, ...options });
  const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

  beforeEach(() => {
    runtime = createTestRuntime();
    mocks.callGatewayFromCliWithTransport.mockReset().mockResolvedValue({ sessions: [] });
    tmpDir = sessionDirs.make();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tmpDir, "state"));
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        entries: { main: {}, ops: {} },
      },
    });
    storePath = path.join(tmpDir, "sessions.sqlite");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function writeSessionEntry(
    key = sessionKey,
    entry: Partial<SessionEntry> = {},
  ): Promise<void> {
    await upsertSessionEntryCore(
      { sessionKey: key, storePath },
      {
        sessionId: "session-one",
        updatedAt: 2,
        status: "done",
        ...entry,
      },
    );
  }

  async function appendEvents(
    events: TrajectoryEvent[],
    params: { key?: string; sessionId?: string } = {},
  ): Promise<void> {
    appendSqliteTrajectoryRuntimeEvents(
      {
        agentId: "main",
        sessionId: params.sessionId ?? "session-one",
        storePath,
      },
      events.map((event) => ({ ...event, sessionKey: params.key ?? event.sessionKey })),
    );
  }

  async function render(
    events: TrajectoryEvent[],
    options: Parameters<typeof explicitTail>[0] = {},
  ) {
    const key = options.sessionKey ?? sessionKey;
    await writeSessionEntry(key);
    await appendEvents(events, { key });
    await explicitTail(options);
    return runtimeOutput(runtime);
  }

  function expectOutput(contains: string[], absent: string[] = []) {
    const output = runtimeOutput(runtime);
    for (const text of contains) {
      expect(output).toContain(text);
    }
    for (const text of absent) {
      expect(output).not.toContain(text);
    }
  }

  it("renders the requested newest progress lines with tool arguments", async () => {
    await render(
      [
        makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
        makeEvent({
          type: "tool.call",
          ts: "2026-05-18T12:04:18.000Z",
          data: { name: "bash", arguments: { command: "echo SECRET" } },
        }),
        makeEvent({
          type: "tool.call",
          ts: "2026-05-18T12:04:19.000Z",
          data: { name: "read", args: { path: ".env", expression: "API_TOKEN = computeToken()" } },
        }),
        toolResult("bash", { data: { name: "bash", success: true, output: "SECRET" } }),
        modelCompleted(),
      ],
      { tail: "4" },
    );
    expectOutput(
      [
        "12:04:18Z",
        "tool.call",
        'bash {"command":"echo SECRET"}',
        'read {"path":".env","expression":"API_TOKEN = computeToken()"}',
        "tool.result",
        "bash ok",
        "model.completed",
        "openai/gpt-5.2 done",
      ],
      ["session.started"],
    );
  });

  it.each<[string, TrajectoryEvent["data"], string]>([
    ["provider failure", { stopReason: "error", aborted: false, timedOut: false }, "error"],
    [
      "tool turn without delivery",
      { stopReason: "toolUse", terminalError: "non_deliverable_terminal_turn" },
      "error",
    ],
    ["assistant interruption", { stopReason: "aborted", aborted: false }, "aborted"],
    ["prompt failure", { promptError: "sensitive failure detail" }, "error"],
    [
      "timeout with abort and failure",
      { timedOut: true, aborted: true, promptError: "sensitive failure detail" },
      "timeout",
    ],
    ["abort with failure", { aborted: true, promptError: "sensitive failure detail" }, "aborted"],
    ["delivered partial reply", { stopReason: "length" }, "done"],
  ])("renders the recorded terminal outcome for %s", async (_name, data, expected) => {
    await render([modelCompleted(data)]);
    expectOutput([`openai/gpt-5.2 ${expected}`], ["sensitive failure detail"]);
  });

  it("aligns CJK session keys and replaces invalid timestamps", async () => {
    const key = "agent:main:中文";
    const line = await render([toolResult("proof", { ts: "invalid" })], { sessionKey: key });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("--:--:-- ")).toBe(true);
    expect(line).toContain(` ${key} `);
    expect(line).toContain("tool.result");
    expect(line.endsWith("proof ok")).toBe(true);
    expect(visibleWidth(line.slice(0, line.indexOf("proof ok")))).toBe(58);
  });

  it.each([
    ["CSI inside", "a\u001b[31mb", "custom\u001b[31m", "ab", "custom"],
    [
      "OSC beyond cutoff",
      `${"a".repeat(30)}\u001b]8;;https://example.invalid/\u0007`,
      "custom.progress-long\u001b]8;;https://example.invalid/\u0007",
      `${"a".repeat(18)}…`,
      "custom.progress…",
    ],
  ])(
    "renders %s as plain progress labels",
    async (_name, suffix, type, displayed, displayedType) => {
      const key = `agent:main:${suffix}`;
      const line = await render([makeEvent({ type, data: { name: "proof" } })], {
        sessionKey: key,
      });
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\u0007");
      expect(line).toContain(` ${displayedType} `);
      expect(line).toContain(` agent:main:${displayed} `);
      expect(line.endsWith(" proof")).toBe(true);
      expect(visibleWidth(line.slice(0, line.lastIndexOf(" proof") + 1))).toBe(58);
    },
  );

  it.each([
    [
      "unsafe tail count",
      { tail: "9007199254740992" },
      "--tail must be a non-negative integer, for example --tail 25.",
    ],
    [
      "missing session before following",
      { sessionKey: "agent:main:missing", follow: true },
      "Session not found: agent:main:missing. Run openclaw sessions list --all-agents --json to choose a valid key.",
    ],
    [
      "blank session key",
      { sessionKey: "   " },
      "--session-key must not be empty. Omit it to tail active sessions.",
    ],
  ] as const)("rejects %s", async (_name, options, error) => {
    await writeSessionEntry();
    await explicitTail(options);
    expect(runtime.error).toHaveBeenCalledWith(error);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("reports an empty default selection without failing or following", async () => {
    await tail({ agent: "main", follow: true });

    expect(runtimeOutput(runtime)).toBe("No sessions found.");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each<[string, string[], string?]>([
    ["reachable", ["older", "concurrent"]],
    ["unreachable", ["latest"], "Gateway unreachable: showing the most recently active session"],
    ["explicit store", ["latest"], "explicit store: ordered by activity"],
    ["explicit key", ["older"]],
    ["different session id", ["latest"]],
    ["rejected", []],
  ])("selects trajectory sessions with a %s Gateway source", async (mode, expected, notice) => {
    storePath = path.join(tmpDir, "state", "agents", "main", "agent", "openclaw-agent.sqlite");
    const entries = ["older", "concurrent", "latest", "queued"].map((label, index) => ({
      label,
      key: index === 0 ? sessionKey : `agent:main:${label}`,
      sessionId: `${label}-session`,
      lastActivityAt: [1, 2, 4, 3][index],
    }));
    for (const entry of entries) {
      await writeSessionEntry(entry.key, {
        sessionId: entry.sessionId,
        lastActivityAt: entry.lastActivityAt,
        updatedAt: entry.label === "older" ? 100 : entry.lastActivityAt,
      });
      await appendEvents([toolResult(entry.label, { sessionId: entry.sessionId })], {
        key: entry.key,
        sessionId: entry.sessionId,
      });
    }
    mocks.callGatewayFromCliWithTransport.mockResolvedValue({
      sessions: entries
        .filter((entry) => entry.label !== "latest")
        .map((entry) => ({
          key: entry.key,
          sessionId: mode === "different session id" ? "remote-session" : entry.sessionId,
          hasActiveRun: true,
          status: entry.label === "queued" ? "queued" : "running",
        })),
    });
    if (mode === "unreachable") {
      mocks.callGatewayFromCliWithTransport.mockRejectedValue(
        new Error("gateway closed (1006): connection refused"),
      );
    } else if (mode === "rejected") {
      mocks.callGatewayFromCliWithTransport.mockRejectedValue(new Error("missing scope"));
    }

    const auditProjection = ["reachable", "explicit store", "explicit key"].includes(mode);
    if (auditProjection) {
      replaceSessionEntrySync(
        { sessionKey: "agent:main:unrelated", storePath },
        {
          sessionId: "unrelated",
          status: "done",
          updatedAt: 1,
          skillsSnapshot: { prompt: `UNRELATED_TAIL_PAYLOAD_${"x".repeat(4096)}`, skills: [] },
          systemPromptReport: {
            source: "run",
            generatedAt: 1,
            workspaceDir: `UNRELATED_TAIL_PAYLOAD_${"y".repeat(4096)}`,
            systemPrompt: { chars: 0, projectContextChars: 0, nonProjectContextChars: 0 },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 0, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
        },
      );
    }
    const parse = vi.spyOn(JSON, "parse");
    onTestFinished(() => parse.mockRestore());

    const selection = tail({
      agent: "main",
      store: mode === "explicit store" ? storePath : undefined,
      sessionKey: mode === "explicit key" ? sessionKey : undefined,
    });
    if (mode === "rejected") {
      await expect(selection).rejects.toThrow("missing scope");
    } else {
      await selection;
    }
    if (auditProjection) {
      expect(
        parse.mock.calls.filter(
          ([value]) => typeof value === "string" && value.includes("UNRELATED_TAIL_PAYLOAD_"),
        ),
      ).toHaveLength(0);
      expect(runtime.error).not.toHaveBeenCalled();
    }

    const output = runtimeOutput(runtime);
    for (const entry of entries) {
      expect(output.includes(`${entry.label} ok`)).toBe(expected.includes(entry.label));
    }
    expect(
      vi
        .mocked(runtime.log)
        .mock.calls.filter(
          ([line]) =>
            String(line).startsWith("Gateway unreachable:") ||
            String(line).startsWith("explicit store:"),
        ),
    ).toEqual(notice ? [[notice]] : []);
    if (mode === "explicit store" || mode === "explicit key") {
      expect(mocks.callGatewayFromCliWithTransport).not.toHaveBeenCalled();
    }
  });

  it("isolates trajectory rows by session id", async () => {
    await writeSessionEntry();
    await writeSessionEntry("agent:main:old", { sessionId: "old-session" });
    await appendEvents([toolResult("stale", { sessionId: "old-session" })], {
      sessionId: "old-session",
    });
    await appendEvents([toolResult("current", { ts: "2026-05-18T12:04:22.000Z" })]);

    await tail();

    expectOutput(["current ok"], ["stale ok"]);
  });

  it.each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])("continues following until $signal and exits with $exitCode", async ({ signal, exitCode }) => {
    vi.useFakeTimers();
    const initialListeners = listeners();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({ sourceSeq: 1, type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
    ]);
    const appendedEvent = toolResult("sqlite", { sourceSeq: 2 });
    let appended = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!appended && String(message).includes("session.started")) {
        appended = true;
        appendSqliteTrajectoryRuntimeEvents(
          { agentId: "main", sessionId: "session-one", storePath },
          [appendedEvent],
        );
      }
    });

    const run = explicitTail({ tail: "1", follow: true });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      process.emit(signal, signal);
      await run;
    }

    expectOutput(["tool.result", "sqlite ok"]);
    expect(runtime.exit).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledWith(exitCode);
    expect(listeners()).toEqual(initialListeners);
  });

  it("exits unsuccessfully when the followed trajectory store becomes unreadable", async () => {
    vi.useFakeTimers();
    const initialListeners = listeners();
    await writeSessionEntry();
    await appendEvents([makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" })]);

    const run = explicitTail({ tail: "0", follow: true });
    await vi.advanceTimersByTimeAsync(0);
    await closeOpenClawAgentDatabasesAsync();
    fs.writeFileSync(storePath, "not a SQLite database");
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to read trajectory progress for ${sessionKey}`),
    );
    expect(vi.mocked(runtime.exit).mock.calls).toEqual([[1]]);
    expect(listeners()).toEqual(initialListeners);
  });

  it("rejects an explicit blank agent without inferring a store", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    const result = tail({ agent: "", sessionKey });

    await expect(result).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(result).rejects.toMatchObject({ message: "--agent must not be blank" });
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("resolves the target store from a fully qualified non-default agent session key", async () => {
    const opsSessionKey = "agent:ops:telegram:direct:owner";
    const opsSessionsDir = path.join(process.env.OPENCLAW_STATE_DIR!, "agents", "ops", "sessions");
    const opsStorePath = path.join(opsSessionsDir, "sessions.json");
    await upsertSessionEntryCore(
      { sessionKey: opsSessionKey, storePath: opsStorePath },
      { sessionId: "ops-session", updatedAt: 3, status: "done" },
    );
    appendSqliteTrajectoryRuntimeEvents(
      { agentId: "ops", sessionId: "ops-session", storePath: opsStorePath },
      [toolResult("bash", { sessionId: "ops-session", sessionKey: opsSessionKey })],
    );

    await tail({ sessionKey: opsSessionKey });

    expectOutput(
      ["agent:ops:telegram:direct:own…", "tool.result", "bash ok"],
      ["No sessions found"],
    );
  });
});
