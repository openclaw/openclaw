import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCodexHarnessReply,
  createCodexHarnessLiveInstance,
  createCodexHarnessEventCapture,
  logCodexHarnessTurnMeasurement,
  readCodexNativeUsageSnapshots,
  CODEX_HARNESS_CONTEXT_EVENT_PREFIXES,
} from "../../test/helpers/gateway-codex-harness.js";
import { withIsolatedTestHome } from "../../test/test-env.js";
import { withEnvAsync } from "../test-utils/env.js";

describe("native Codex fixture boundaries", () => {
  it.each([
    { authMode: undefined, customHome: false, baseUrl: "https://example.invalid/v1" },
    { authMode: "api-key" as const, customHome: true, baseUrl: " https://example.invalid/v1 " },
  ])(
    "preserves staged native home ($authMode, custom=$customHome, url=$baseUrl)",
    async ({ authMode, customHome, baseUrl }) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "codex-fixture-env-")),
      );
      const nativeHome = path.join(root, customHome ? "custom-codex" : ".codex");
      await fs.mkdir(nativeHome, { recursive: true });
      const sentinels = {
        "auth.json": '{"fixture":"not-a-credential"}\n',
        "config.toml": "# synthetic staged config\n",
      };
      for (const [name, contents] of Object.entries(sentinels)) {
        await fs.writeFile(path.join(nativeHome, name), contents);
      }
      try {
        await withEnvAsync(
          {
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "source-state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "source-config.json"),
            OPENCLAW_LIVE_TEST: "1",
            OPENCLAW_LIVE_USE_REAL_HOME: undefined,
            CODEX_HOME: customHome ? nativeHome : undefined,
            OPENAI_API_KEY: "synthetic-fixture-key",
            CODEX_API_KEY: "synthetic-codex-key",
            CEREBRAS_API_KEY: "synthetic-cerebras-key",
            GROQ_API_KEY: "synthetic-groq-key",
            OPENAI_BASE_URL: baseUrl,
          },
          async () => {
            const staged = withIsolatedTestHome({ loadProfileEnv: false });
            try {
              const callerHome = process.env.HOME;
              const instance = await createCodexHarnessLiveInstance(
                "fixture-gateway-token",
                authMode,
              );
              try {
                expect(process.env.HOME).toBe(callerHome);
                expect(instance.env.HOME).toBe(callerHome);
                expect(instance.env.USERPROFILE).toBe(process.env.USERPROFILE);
                expect(instance.env.OPENCLAW_HOME).toBe(process.env.OPENCLAW_HOME);
                expect(instance.env.CODEX_HOME).toBe(customHome ? nativeHome : undefined);
                const resolvedHome =
                  instance.env.CODEX_HOME ?? path.join(instance.env.HOME!, ".codex");
                for (const [name, contents] of Object.entries(sentinels)) {
                  expect(await fs.readFile(path.join(resolvedHome, name), "utf8")).toBe(contents);
                }
                expect(instance.env.OPENAI_API_KEY).toBe(
                  authMode === "api-key" ? "synthetic-fixture-key" : undefined,
                );
                expect(instance.env.CODEX_API_KEY).toBeUndefined();
                expect(instance.env.CEREBRAS_API_KEY).toBeUndefined();
                expect(instance.env.GROQ_API_KEY).toBeUndefined();
                expect(instance.env.OPENAI_BASE_URL).toBe(
                  authMode === "api-key" && baseUrl.trim() ? baseUrl : undefined,
                );
                expect(instance.stateDir.startsWith(instance.state.root + path.sep)).toBe(true);
                expect(instance.configPath.startsWith(instance.state.root + path.sep)).toBe(true);
                expect(instance.state.workspaceDir.startsWith(instance.state.root + path.sep)).toBe(
                  true,
                );
                expect(instance.stateDir.startsWith(staged.tempHome + path.sep)).toBe(false);
                instance.state.applyEnv();
                expect(process.env.HOME).toBe(callerHome);
                expect(process.env.OPENCLAW_STATE_DIR).toBe(instance.stateDir);
              } finally {
                await instance.cleanup();
              }
              expect(process.env.HOME).toBe(callerHome);
            } finally {
              staged.cleanup();
            }
          },
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("retains full-context usage through the request capture and snapshot reader", () => {
    const capture = createCodexHarnessEventCapture({
      sessionKey: "session-a",
      eventPrefixes: CODEX_HARNESS_CONTEXT_EVENT_PREFIXES,
    });
    capture.start(100);
    const usage = {
      activeContextTokens: 300_010,
      promptTokens: 300_000,
      modelContextWindow: 875_900,
      cachedInputTokens: 250_000,
      cacheWriteInputTokens: 5_000,
      inputTokens: 300_000,
      outputTokens: 10,
    };
    const emit = (stream: string, data: Record<string, unknown>, sessionKey = "session-a") =>
      capture.onAgentEvent({ runId: "run-a", seq: 1, ts: 125, stream, data, sessionKey });
    emit("assistant", { text: "first" }, "session-b");
    expect(capture.firstAssistantMs).toBeUndefined();
    emit("assistant", { text: "first" });
    emit("codex_app_server.lifecycle", { phase: "turn_starting" });
    emit("codex_app_server.guardian", { phase: "completed", status: "approved" });
    emit("compaction", { phase: "end", completed: true });
    emit("usage", usage, "session-b");
    emit("tool", { phase: "result" });
    emit("usage", usage);
    expect(readCodexNativeUsageSnapshots(capture.events)).toEqual([usage]);
    expect(capture.events.map(({ stream }) => stream)).toEqual([
      "codex_app_server.lifecycle",
      "codex_app_server.guardian",
      "compaction",
      "usage",
    ]);
    expect(capture.firstAssistantMs).toBe(25);
    let measurement: Record<string, unknown> | undefined;
    logCodexHarnessTurnMeasurement(
      "fixture",
      {
        runId: "run-a",
        text: "first",
        events: capture.events,
        capture,
        elapsedMs: 25,
        firstAssistantMs: 25,
        compactionCount: 0,
      },
      (step, details) => {
        expect(step).toBe("turn-measurement");
        measurement = details;
      },
    );
    expect(measurement).toMatchObject({
      label: "fixture",
      elapsedMs: 25,
      timeToFirstAssistantMs: 25,
      activeContextTokens: 300_010,
      promptTokens: 300_000,
      modelContextWindow: 875_900,
      compactionCount: 1,
    });
    const guardian = createCodexHarnessEventCapture({
      sessionKey: "session-a",
      includeAllSessions: true,
    });
    guardian.onAgentEvent({
      runId: "run-b",
      seq: 1,
      ts: 200,
      stream: "codex_app_server.guardian",
      sessionKey: "session-b",
      data: { phase: "completed" },
    });
    expect(guardian.events).toHaveLength(1);
  });
  it("retains bounded content-free failure evidence before rejecting a reply", () => {
    const capture = createCodexHarnessEventCapture({
      sessionKey: "session-a",
      eventPrefix: "codex_app_server.",
    });
    capture.start(100, "run-a");
    const emit = (stream: string, data: Record<string, unknown>, runId = "run-a") =>
      capture.onAgentEvent({ runId, seq: 1, ts: 125, stream, data, sessionKey: "session-a" });
    emit("codex_app_server.lifecycle", {
      phase: "turn_starting",
      threadId: "thread-a",
      turnId: "turn-a",
      model: "private-model",
    });
    emit("assistant", { text: "PRIVATE-ASSISTANT", delta: "PRIVATE-DELTA" });
    emit("tool", {
      phase: "result",
      isError: true,
      args: { password: "PRIVATE-ARGS" },
      result: "PRIVATE-RESULT",
    });
    emit("lifecycle", { phase: "error", error: "PRIVATE-ERROR" });
    const reports: string[] = [];
    expect(() =>
      assertCodexHarnessReply(
        { runId: "run-a", capture, report: (line) => reports.push(line) },
        () => expect("wrong").toContain("expected"),
      ),
    ).toThrow();
    expect(reports).toHaveLength(1);
    const report = reports[0];
    if (report === undefined) {
      throw new Error("Expected failure evidence before the assertion");
    }
    const evidence = JSON.parse(report);
    expect(evidence.runId).toBe("run-a");
    expect(evidence.events.map((event: { stream: string }) => event.stream)).toEqual([
      "codex_app_server.lifecycle",
      "assistant",
      "tool",
      "lifecycle",
    ]);
    expect(evidence.events[0]).toMatchObject({ threadId: "thread-a", turnId: "turn-a" });
    expect(evidence.events[1]).toMatchObject({ textLength: 17, deltaLength: 13 });
    expect(evidence.events[2]).toMatchObject({ isError: true });
    expect(report).not.toMatch(/PRIVATE|private-model/);
    reports.length = 0;
    assertCodexHarnessReply({ runId: "run-a", capture, report: (line) => reports.push(line) }, () =>
      expect("expected").toContain("expected"),
    );
    expect(reports).toEqual([]);
    for (let index = 0; index < 300; index++) {
      emit("codex_app_server.diagnostic", { phase: "notification", index });
    }
    expect(capture.failureEvidence("run-a").identity).toMatchObject({
      threadId: "thread-a",
      turnId: "turn-a",
    });
    expect(capture.failureEvidence("run-a").events).toHaveLength(128);
    expect(capture.failureEvidence("run-a").droppedEvents).toBe(176);
    expect(capture.failureEvidence("other-run").events).toEqual([]);
    expect(capture.events).toHaveLength(1);
  });
  it.each([
    {
      name: "substring",
      match: "prefix expected suffix",
      assert: (text: string) => expect(text).toContain("expected"),
    },
    {
      name: "trimmed exact",
      match: " expected ",
      assert: (text: string) => expect(text.trim()).toBe("expected"),
    },
    {
      name: "pattern",
      match: "permission denied",
      assert: (text: string) => expect(text).toMatch(/permission|denied/),
    },
  ])("retains the caller's $name reply contract with failure evidence", ({ match, assert }) => {
    const capture = createCodexHarnessEventCapture({ sessionKey: "session-a" });
    capture.start(100, "run-a");
    const reports: string[] = [];
    const params = { runId: "run-a", capture, report: (line: string) => reports.push(line) };
    expect(() => assertCodexHarnessReply(params, () => assert(""))).toThrow();
    expect(reports).toHaveLength(1);
    const report = reports[0];
    if (report === undefined) {
      throw new Error("Expected the caller assertion to report failure evidence");
    }
    expect(JSON.parse(report)).toMatchObject({ runId: "run-a", events: [] });
    reports.length = 0;
    assertCodexHarnessReply(params, () => assert(match));
    expect(reports).toEqual([]);
    const error = new Error("caller assertion");
    expect(() =>
      assertCodexHarnessReply(params, () => {
        throw error;
      }),
    ).toThrow(error);
  });
});
