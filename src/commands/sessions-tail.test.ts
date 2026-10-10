// Sessions tail tests cover transcript tailing, filtering, and session-store setup.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand } from "./sessions-tail.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  callGatewayFromCliWithTransport: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

// mock-isolation: Exercise CLI selection without connecting to an operator Gateway.
vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGatewayFromCliWithTransport,
}));

const sessionKey = "agent:main:telegram:direct:owner";

function makeEvent(
  params: Partial<TrajectoryEvent> & { type: string; ts: string },
): TrajectoryEvent {
  return {
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

describe("sessionsTailCommand", () => {
  let tmpDir: string;
  let storePath: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    mocks.callGatewayFromCliWithTransport.mockReset().mockResolvedValue({ sessions: [] });
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = sessionDirs.make();
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        entries: { main: {}, ops: {} },
      },
    });
    storePath = path.join(tmpDir, "sessions.sqlite");
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
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

  it("renders compact redacted progress lines", async () => {
    const runtime = createTestRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash", arguments: { command: "echo SECRET" } },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true, output: "SECRET" },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:29.000Z",
        provider: "openai",
        modelId: "gpt-5.2",
      }),
    ]);

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("12:04:18Z");
    expect(output).toContain("tool.call");
    expect(output).toContain("bash {...redacted...}");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).toContain("model.completed");
    expect(output).toContain("openai/gpt-5.2 done");
    expect(output).not.toContain("SECRET");
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
    const runtime = createTestRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:29.000Z",
        provider: "openai",
        modelId: "gpt-5.2",
        data,
      }),
    ]);

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey }, runtime);

    expect(runtimeOutput(runtime)).toContain(`openai/gpt-5.2 ${expected}`);
    expect(runtimeOutput(runtime)).not.toContain("sensitive failure detail");
  });

  it.each([
    ["CJK", "invalid", "--:--:--", "中文", "中文"],
    [
      "truncated emoji",
      "2026-05-18T12:04:21.000Z",
      "12:04:21Z",
      `${"a".repeat(17)}👩🏽‍💻-incident`,
      `${"a".repeat(17)}…`,
    ],
  ])(
    "keeps progress columns aligned with %s session keys",
    async (_name, ts, timestamp, suffix, displayed) => {
      const runtime = createTestRuntime();
      const key = `agent:main:${suffix}`;
      await writeSessionEntry(key);
      await appendEvents(
        [
          makeEvent({
            type: "tool.result",
            ts,
            data: { name: "proof", success: true },
          }),
        ],
        { key },
      );

      await sessionsTailCommand({ agent: "main", store: storePath, sessionKey: key }, runtime);

      const line = runtimeOutput(runtime);
      expect(line.split("\n")).toHaveLength(1);
      expect(line.startsWith(`${timestamp} `)).toBe(true);
      expect(line).toContain(` agent:main:${displayed} `);
      expect(line).toContain("tool.result");
      expect(line.endsWith("proof ok")).toBe(true);
      const previewOffset = line.indexOf("proof ok");
      expect(visibleWidth(line.slice(0, previewOffset))).toBe(58);
    },
  );

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
      const runtime = createTestRuntime();
      const key = `agent:main:${suffix}`;
      await writeSessionEntry(key);
      await appendEvents(
        [makeEvent({ type, ts: "2026-05-18T12:04:21.000Z", data: { name: "proof" } })],
        { key },
      );

      await sessionsTailCommand({ agent: "main", store: storePath, sessionKey: key }, runtime);

      const line = runtimeOutput(runtime);
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\u0007");
      expect(line).toContain(` ${displayedType} `);
      expect(line).toContain(` agent:main:${displayed} `);
      expect(line.endsWith(" proof")).toBe(true);
      expect(visibleWidth(line.slice(0, line.lastIndexOf(" proof") + 1))).toBe(58);
    },
  );

  it("honors the tail count before rendering existing trajectory events", async () => {
    const runtime = createTestRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash" },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey, tail: "2" }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).not.toContain("session.started");
    expect(output).toContain("tool.call");
    expect(output).toContain("tool.result");
  });

  it("rejects tail counts that exceed JavaScript safe integer precision", async () => {
    const runtime = createTestRuntime();

    await sessionsTailCommand(
      { agent: "main", store: storePath, sessionKey, tail: "9007199254740992" },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "--tail must be a non-negative integer, for example --tail 25.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a missing explicit session with follow=%s", async (follow) => {
    const runtime = createTestRuntime();
    await writeSessionEntry();

    await sessionsTailCommand(
      { agent: "main", store: storePath, sessionKey: "agent:main:missing", follow },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:missing. Run openclaw sessions list --all-agents --json to choose a valid key.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects a blank explicit session key %j", async (blankKey) => {
    const runtime = createTestRuntime();
    await writeSessionEntry();

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey: blankKey }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--session-key must not be empty. Omit it to tail active sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("reports an empty default selection without failing or following", async () => {
    const runtime = createTestRuntime();

    await sessionsTailCommand({ agent: "main", follow: true }, runtime);

    expect(runtimeOutput(runtime)).toBe("No sessions found.");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "reachable", expected: ["older ok", "concurrent ok"], notice: undefined },
    {
      mode: "unreachable",
      expected: ["latest ok"],
      notice: "Gateway unreachable: showing the most recently active session",
    },
    {
      mode: "explicit store",
      expected: ["latest ok"],
      notice: "explicit store: ordered by activity",
    },
    { mode: "explicit key", expected: ["older ok"], notice: undefined },
    { mode: "different session id", expected: ["latest ok"], notice: undefined },
    { mode: "rejected", expected: [], notice: undefined },
  ])(
    "selects trajectory sessions with a $mode Gateway source",
    async ({ mode, expected, notice }) => {
      const runtime = createTestRuntime();
      storePath = path.join(tmpDir, "state", "agents", "main", "agent", "openclaw-agent.sqlite");
      const entries = [
        { key: sessionKey, sessionId: "older-session", label: "older", lastActivityAt: 1 },
        {
          key: "agent:main:concurrent",
          sessionId: "concurrent-session",
          label: "concurrent",
          lastActivityAt: 2,
        },
        {
          key: "agent:main:latest",
          sessionId: "latest-session",
          label: "latest",
          lastActivityAt: 4,
        },
        {
          key: "agent:main:queued",
          sessionId: "queued-session",
          label: "queued",
          lastActivityAt: 3,
        },
      ];
      for (const entry of entries) {
        await writeSessionEntry(entry.key, {
          sessionId: entry.sessionId,
          lastActivityAt: entry.lastActivityAt,
          updatedAt: entry.label === "older" ? 100 : entry.lastActivityAt,
        });
        await appendEvents(
          [
            makeEvent({
              sessionId: entry.sessionId,
              type: "tool.result",
              ts: "2026-05-18T12:04:21.000Z",
              data: { name: entry.label, success: true },
            }),
          ],
          { key: entry.key, sessionId: entry.sessionId },
        );
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

      const selection = sessionsTailCommand(
        {
          agent: "main",
          store: mode === "explicit store" ? storePath : undefined,
          sessionKey: mode === "explicit key" ? sessionKey : undefined,
        },
        runtime,
      );
      if (mode === "rejected") {
        await expect(selection).rejects.toThrow("missing scope");
      } else {
        await selection;
      }

      const output = runtimeOutput(runtime);
      for (const entry of entries) {
        expect(output.includes(`${entry.label} ok`)).toBe(expected.includes(`${entry.label} ok`));
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
    },
  );

  it.each(["explicit", "running", "latest"])(
    "selects %s sessions without decoding unrelated saved prompts",
    async (selection) => {
      const runtime = createTestRuntime();
      storePath = path.join(tmpDir, "state", "agents", "main", "agent", "openclaw-agent.sqlite");
      replaceSessionEntrySync(
        { sessionKey, storePath },
        {
          sessionId: "session-one",
          updatedAt: 2,
          status: "done",
        },
      );
      if (selection === "running") {
        mocks.callGatewayFromCliWithTransport.mockResolvedValue({
          sessions: [
            { key: sessionKey, sessionId: "session-one", hasActiveRun: true, status: "running" },
          ],
        });
      }
      await appendEvents([
        makeEvent({
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "selected", success: true },
        }),
      ]);
      for (let index = 0; index < 100; index += 1) {
        replaceSessionEntrySync(
          { sessionKey: `agent:main:unrelated:${index}`, storePath },
          {
            sessionId: `unrelated-${index}`,
            status: "done",
            updatedAt: 1,
            skillsSnapshot: {
              prompt: `UNRELATED_TAIL_PAYLOAD_${"x".repeat(4096)}`,
              skills: [],
            },
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
      try {
        await sessionsTailCommand(
          {
            agent: "main",
            store: selection === "running" ? undefined : storePath,
            sessionKey: selection === "explicit" ? sessionKey : undefined,
            tail: "1",
          },
          runtime,
        );

        expect(
          parse.mock.calls.filter(
            ([value]) => typeof value === "string" && value.includes("UNRELATED_TAIL_PAYLOAD_"),
          ),
        ).toHaveLength(0);
        expect(runtimeOutput(runtime)).toContain("selected ok");
        expect(runtime.error).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    },
  );

  it("isolates trajectory rows by session id", async () => {
    const runtime = createTestRuntime();
    await writeSessionEntry();
    await writeSessionEntry("agent:main:old", { sessionId: "old-session" });
    await appendEvents(
      [
        makeEvent({
          sessionId: "old-session",
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "stale", success: true },
        }),
      ],
      { sessionId: "old-session" },
    );
    await appendEvents([
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:22.000Z",
        data: { name: "current", success: true },
      }),
    ]);

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("current ok");
    expect(output).not.toContain("stale ok");
  });

  it.each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])("continues following until $signal and exits with $exitCode", async ({ signal, exitCode }) => {
    vi.useFakeTimers();
    const runtime = createTestRuntime();
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    await writeSessionEntry();
    appendSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-one", storePath }, [
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const appendedEvent = makeEvent({
      sourceSeq: 2,
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "sqlite", success: true },
    });
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

    const run = sessionsTailCommand(
      { agent: "main", store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      process.emit(signal, signal);
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("sqlite ok");
    expect(runtime.exit).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledWith(exitCode);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });

  it("exits unsuccessfully when the followed trajectory store becomes unreadable", async () => {
    vi.useFakeTimers();
    const runtime = createTestRuntime();
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    await writeSessionEntry();
    await appendEvents([makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" })]);

    const run = sessionsTailCommand(
      { agent: "main", store: storePath, sessionKey, tail: "0", follow: true },
      runtime,
    );
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
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });

  it.each([{ agent: "   " }, { agent: "", sessionKey }])(
    "rejects an explicit blank agent without inferring a store: %j",
    async (opts) => {
      mocks.getRuntimeConfig.mockReturnValue({});
      const runtime = createTestRuntime();
      const result = sessionsTailCommand(opts, runtime);

      await expect(result).rejects.toBeInstanceOf(ExpectedCliError);
      await expect(result).rejects.toMatchObject({ message: "--agent must not be blank" });
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("resolves the target store from a fully qualified non-default agent session key", async () => {
    const runtime = createTestRuntime();
    const opsSessionKey = "agent:ops:telegram:direct:owner";
    const opsSessionsDir = path.join(process.env.OPENCLAW_STATE_DIR!, "agents", "ops", "sessions");
    const opsStorePath = path.join(opsSessionsDir, "sessions.json");
    await upsertSessionEntryCore(
      { sessionKey: opsSessionKey, storePath: opsStorePath },
      { sessionId: "ops-session", updatedAt: 3, status: "done" },
    );
    appendSqliteTrajectoryRuntimeEvents(
      { agentId: "ops", sessionId: "ops-session", storePath: opsStorePath },
      [
        makeEvent({
          sessionId: "ops-session",
          sessionKey: opsSessionKey,
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "bash", success: true },
        }),
      ],
    );

    await sessionsTailCommand({ sessionKey: opsSessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("agent:ops:telegram:direct:own…");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).not.toContain("No sessions found");
  });
});
