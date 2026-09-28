// Gateway concurrency benchmark tests cover CLI controls, probe budgets, and summaries.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { Profiler } from "node:inspector";
import { createServer as createRawServer, type Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { testing } from "../../scripts/bench-gateway-concurrency.ts";
import { summarizeMockInferenceRequest } from "../../scripts/e2e/lib/mock-inference-facts.ts";
import { createActivitySummaryDiagnostics } from "../../scripts/lib/gateway-bench-activity-summary.ts";
import {
  createLiveGatewayEvidence,
  LIVE_GATEWAY_MODEL,
  LIVE_GATEWAY_MODEL_ID,
  redactLiveBenchmarkText,
} from "../../scripts/lib/gateway-bench-live.ts";
import { readGatewayMemory } from "../../scripts/lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuProfile,
  readGatewayHeapProfile,
} from "../../scripts/lib/gateway-bench-profile.ts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { createDeferred } from "../helpers/promise.js";

const testNodeExecPath = resolveTestNodeExecPath();

type BenchmarkRun = Parameters<typeof testing.summarizeRuns>[0][number];

function createBenchmarkRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    controlPlane: [],
    controlUi: [],
    cpuUsage: {
      pid: 1,
      startMonotonicMicros: 1_000,
      endMonotonicMicros: 101_000,
      wallMs: 100,
      process: { userMs: 48, systemMs: 16, totalMs: 64 },
      mainThread: { userMs: 32, systemMs: 8, totalMs: 40 },
    },
    durationMs: 10,
    freshConnection: { error: null, latencyMs: 25, ok: true },
    history: [],
    memory: {
      after: { atMs: 10, heapTotalMb: 120, heapUsedMb: 80, rssMb: 200 },
      before: { atMs: 0, heapTotalMb: 100, heapUsedMb: 60, rssMb: 180 },
      peakRssMb: 210,
    },
    messageSubscriptions: [],
    messageSubscriptionsDuringLoad: [],
    mockRequests: testing.summarizeMockRequests(
      [0, 0, 0, 0, 1, 1].map((responses, index) =>
        testing.parseMockRequests(
          {
            id: "fixture",
            ingress: { responses, chatCompletions: 0, embeddings: 0, other: 0 },
            selections: { model: 0, global: 0, automaticTool: 0, automaticText: responses },
          },
          index * 2,
          index * 2 + 1,
        ),
      ),
    ),
    turnEvidence: { toolTurns: 0, observerModelDigestTurns: 0 },
    providerRequests: testing.summarizeProviderRequests([], 0, 0),
    turnAccounting: { launched: 8, terminalOk: 8, verified: 8 },
    agentWarmup: {
      durationMs: 0,
      launched: 0,
      terminalOk: 0,
      verified: 0,
      beforeOrdinal: 0,
      afterOrdinal: 0,
      turnEvidence: { toolTurns: 0, observerModelDigestTurns: 0 },
    },
    probeWarmup: { durationMs: 2, samples: [] },
    pluginMetadataScans: { count: 0, durationMs: null, totalDurationMs: 0 },
    readyz: [],
    sessionSeedDurationMs: 2,
    sessionsList: [],
    sessionUpdates: [],
    setupDurationMs: 3,
    turnCount: 8,
    turnsDurationMs: 5,
    ...overrides,
  };
}

describe("gateway concurrency benchmark script", () => {
  describe("passive activity-summary diagnostics", () => {
    const create = () => createActivitySummaryDiagnostics(performance.now());
    const recapLog = (error: unknown = "Activity recap timed out") =>
      JSON.stringify({
        subsystem: "gateway/activity-summary",
        message: "Activity recap deferred",
        error,
        retryScheduled: false,
        agentId: "fixture-agent",
        time: "2026-09-22T00:00:00.000Z",
      });

    it("is explicit mock-only opt-in and changes only synthetic logging", async () => {
      expect(testing.parseOptions([]).activitySummaryDiagnostics).toBe(false);
      expect(
        testing.parseOptions(["--activity-summary-diagnostics"]).activitySummaryDiagnostics,
      ).toBe(true);
      expect(() =>
        testing.parseOptions(["--provider", "openai", "--activity-summary-diagnostics"]),
      ).toThrow("requires the mock provider");
      await withTempDir("gateway-recap-config-", async (root) => {
        const write = (enabled: boolean) =>
          testing.buildConfig(root, 12345, 1, 0, 0, ["main"], "mock", enabled);
        const normal = JSON.parse(await readFile(write(false), "utf8"));
        const diagnostic = JSON.parse(await readFile(write(true), "utf8"));
        expect(normal.logging).toBeUndefined();
        expect(diagnostic.logging).toEqual({ consoleLevel: "debug", consoleStyle: "json" });
        delete diagnostic.logging;
        expect(diagnostic).toEqual(normal);
      });
    });

    it("joins opaque identities while preserving absent, invalid, and late summary observations", () => {
      const capture = create();
      const row = {
        key: "fixture-session",
        agentId: "fixture-agent",
        sessionId: "fixture-session",
        activitySummary: { state: "updating", text: "private recap", updatedAt: 10 },
      };
      capture.setPhase("warmup");
      capture.onProbe({
        sessions: [
          row,
          { key: row.key },
          { key: row.key, activitySummary: { state: "secret-invalid-state", updatedAt: -1 } },
        ],
      });
      capture.setPhase("load");
      capture.onEvent({
        event: "agent",
        seq: 2,
        payload: {
          stream: "lifecycle",
          runId: "fixture-run",
          sessionKey: row.key,
          data: { phase: "end", extra: "private" },
        },
      });
      capture.setPhase("shutdown");
      capture.onEvent({
        event: "sessions.changed",
        seq: 3,
        payload: {
          ...row,
          sessionKey: row.key,
          reason: "activity-summary",
          activitySummary: { state: "current", text: "private recap", updatedAt: 12 },
        },
      });
      const result = capture.finish();
      const probes = result.records.filter((record) => record.source === "probe");
      const event = result.records.find((record) => record.source === "event")!;
      expect(probes[0]).toMatchObject({
        state: "updating",
        hasText: true,
        updatedAt: 10,
        phase: "warmup",
        summaryPresent: true,
      });
      expect(probes[1]).toMatchObject({ state: null, hasText: null, summaryPresent: false });
      expect(probes[2]).toMatchObject({ state: null, updatedAt: null, summaryPresent: true });
      expect(event).toMatchObject({ phase: "shutdown", seq: 3, state: "current", updatedAt: 12 });
      expect(event.session).toBe(probes[0]!.session);
      expect(event.sessionId).not.toBe(event.session);
      expect(result.records.find((record) => record.source === "lifecycle")).toMatchObject({
        lifecycle: "end",
        session: event.session,
      });
      expect(result.invalidFields).toBe(1);
      expect(result.delivery).toContain("missing events do not identify");
      expect(result.phaseClock).toContain("observation arrival");
      expect(result.instrumentation).toContain("not comparable performance evidence");
      for (const privateText of [
        "fixture-session",
        "fixture-agent",
        "fixture-run",
        "private recap",
        "secret-invalid-state",
      ]) {
        expect(JSON.stringify(result)).not.toContain(privateText);
      }
      const other = create();
      other.onProbe({ sessions: [row] });
      expect(other.finish().records.find((record) => record.source === "probe")!.session).not.toBe(
        event.session,
      );
    });

    it("frames streams separately and retains only closed error facts", () => {
      const capture = create();
      const secret = "synthetic-credential at /private/fixture/secret 😀";
      const line = Buffer.from(recapLog(secret) + "\n");
      const split = line.indexOf(Buffer.from("😀")) + 1;
      capture.onOutput("stdout", line.subarray(0, split));
      capture.onOutput("stderr", Buffer.from(recapLog() + "\n"));
      capture.onOutput("stdout", line.subarray(split));
      capture.onOutput(
        "stderr",
        Buffer.from(
          JSON.stringify({
            subsystem: "gateway",
            message: "Activity summary publication failed",
            error: {},
          }) + "\n",
        ),
      );
      capture.onOutput(
        "stderr",
        Buffer.from(recapLog().replace("gateway/activity-summary", "foreign") + "\n"),
      );
      const result = capture.finish();
      const logs = result.records.filter((record) => record.source === "log");
      expect(logs).toHaveLength(3);
      expect(logs[0]).toMatchObject({
        errorKind: "timeout",
        retryScheduled: false,
        errorPresent: true,
        emittedAt: 1790035200000,
      });
      expect(logs[1]).toMatchObject({ errorKind: "unclassified", errorPresent: true });
      expect(logs[1]!.errorFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(logs[2]).toMatchObject({
        errorKind: "unavailable",
        errorPresent: true,
        errorFingerprint: null,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("/private/");
      expect(result.truncated).toBe(false);
    });

    it("uses the current nested session projection without reviving outer recap fields", () => {
      const capture = create();
      const payload = {
        sessionKey: "fixture-session",
        agentId: "fixture-agent",
        activitySummary: { state: "stale", text: "older private recap" },
        session: { key: "fixture-session", activitySummary: { state: "current", updatedAt: 20 } },
      };
      capture.onEvent({ event: "sessions.changed", payload });
      capture.onEvent({
        event: "sessions.changed",
        payload: { ...payload, session: { key: "fixture-session" } },
      });
      const events = capture.finish().records.filter((record) => record.source === "event");
      expect(events).toMatchObject([
        { projection: "session", state: "current", updatedAt: 20 },
        { projection: "session", summaryPresent: false, state: null },
      ]);
      expect(events[0]!.session).toBe(events[1]!.session);
    });

    it("discards oversized line continuations and reports incomplete or malformed evidence", () => {
      const capture = create();
      capture.onOutput("stdout", Buffer.from("x".repeat(16 * 1024 + 1)));
      capture.onOutput("stdout", Buffer.from(recapLog() + "\n"));
      capture.onOutput("stdout", Buffer.from(recapLog() + "\n"));
      capture.onOutput("stderr", Buffer.from('{"broken":\n'));
      capture.onOutput("stderr", Buffer.from(recapLog()));
      const result = capture.finish();
      expect(result.records.filter((record) => record.source === "log")).toHaveLength(1);
      expect(result).toMatchObject({
        oversizedLogLines: 1,
        malformedLogLines: 1,
        incompleteLogLines: 1,
        truncated: true,
      });
    });

    it("caps projected records and bytes, including otherwise valid observations", () => {
      const capture = create();
      for (let index = 0; index < 600; index += 1) {
        capture.onProbe({
          sessions: [
            {
              key: "fixture-session",
              sessionId: "fixture-id",
              agentId: "fixture-agent",
              activitySummary: { state: "current", updatedAt: 1, text: "ignored" },
            },
          ],
        });
      }
      const result = capture.finish();
      expect(result.dropped).toBeGreaterThan(0);
      expect(result.records.length).toBeLessThanOrEqual(result.limits.records);
      expect(result.bytes).toBeLessThanOrEqual(result.limits.bytes);
      expect(result.bytes).toBe(
        result.records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0),
      );
      expect(result.truncated).toBe(true);
      const phases = create();
      for (let index = 0; index < 600; index += 1) {
        phases.setPhase("load");
      }
      expect(phases.finish()).toMatchObject({ dropped: 89, records: expect.any(Array) });
      const bytes = create();
      for (let index = 0; index < 600; index += 1) {
        bytes.onEvent({
          event: "sessions.changed",
          seq: index,
          payload: {
            sessionKey: "fixture-session",
            sessionId: "fixture-id",
            agentId: "fixture-agent",
            reason: "activity-summary",
            activitySummary: {
              state: "unavailable",
              updatedAt: 1_790_035_200_000,
              text: "ignored",
            },
          },
        });
      }
      const byteBounded = bytes.finish();
      expect(byteBounded.records.length).toBeLessThan(byteBounded.limits.records);
      expect(byteBounded.bytes).toBeLessThanOrEqual(byteBounded.limits.bytes);
      expect(byteBounded.dropped).toBeGreaterThan(0);
    });

    it("keeps readiness output internal and prevents diagnostic failure-tail leakage", async () => {
      const capture = create();
      const child = spawn(testNodeExecPath, [
        "-e",
        'console.log("startup trace: sidecars.ready synthetic-private-value"); console.error("synthetic-private-value");',
      ]);
      const output = testing.captureChildOutput(child, capture.onOutput);
      await once(child, "close");
      expect(output.readOutput()).toContain("startup trace: sidecars.ready");
      const failure = testing.formatRunFailure(
        new Error("nested synthetic-private-value"),
        output,
        { readOutput: () => "mock synthetic-private-value" },
      );
      expect(failure).not.toContain("synthetic-private-value");
      expect(failure).toContain("raw output omitted");
    });

    it("omits private paths when diagnostic startup fails before a child exists", async () => {
      await withTempDir("gateway-recap-failure-", async (root) => {
        const output = path.join(root, "report.json");
        const result = spawnSync(
          testNodeExecPath,
          [
            "scripts/bench-gateway-concurrency.ts",
            "--activity-summary-diagnostics",
            "--entry",
            "/private/fixture/diagnostic-secret/entry.js",
            "--output",
            output,
            "--json",
          ],
          { encoding: "utf8", env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root } },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Activity-summary diagnostic benchmark failed");
        expect(result.stderr).toContain("[bench-gateway-concurrency] FAILED (exit 1)");
        const written = await readFile(output, "utf8");
        expect(JSON.parse(result.stdout)).toEqual(JSON.parse(written));
        expect(JSON.parse(written)).toMatchObject({
          mode: "mock-activity-summary-diagnostics",
          runs: [],
          failedAttempt: { status: "failure", cleanup: { rootRemoved: true } },
        });
        expect(`${written}${result.stdout}${result.stderr}`).not.toContain("diagnostic-secret");
      });
    });

    it("observes the existing probe response without another RPC or request-shape change", async () => {
      const order: string[] = [];
      const server = createHttpServer((req, res) => {
        order.push(req.url!);
        res.end(req.url === "/readyz" ? "{}" : "<html></html>");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address !== "string");
      const capture = create();
      try {
        const sample = await testing.sampleGateway({
          deadlineAt: performance.now() + 5000,
          runStartedAt: performance.now(),
          serial: true,
          port: address.port,
          activitySummaryDiagnostics: capture,
          rpc: async <T>(method: string, params: unknown) => {
            order.push(method);
            expect(params).toEqual({});
            return { sessions: [{ key: "fixture-session" }] } as T;
          },
        });
        expect(order).toEqual(["/readyz", "/", "sessions.list"]);
        expect(sample.sessionsList.ok).toBe(true);
        expect(capture.finish().records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source: "probe", summaryPresent: false, state: null }),
          ]),
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });

  it("keeps mock as the default and admits bounded live profiling without mock controls", () => {
    expect(testing.parseOptions([]).provider).toBe("mock");
    const liveArgs = ["--provider", "openai", "--runs", "1", "--warmup", "0", "--concurrency", "1"];
    expect(
      testing.parseOptions([...liveArgs, "--load-cpu-prof-dir", "/tmp/profiles"]).provider,
    ).toBe("openai");
    expect(() => testing.parseOptions(["--provider", "other"])).toThrow("--provider");
    for (const extra of [
      ["--tool-events"],
      ["--agent-warmup-turns", "1"],
      ["--stream-chunk-delay-ms", "1"],
      ["--heap-prof-dir", "/tmp/heap"],
    ]) {
      expect(() => testing.parseOptions([...liveArgs, ...extra])).toThrow("OpenAI requires");
    }
  });

  it("scrubs an echoed live key at the child-output error and JSON boundaries", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-live-key-for-test");
    try {
      const error = testing.formatRunFailure(
        new Error("synthetic-live-key-for-test"),
        {
          readOutput: () => "provider echoed synthetic-live-key-for-test",
          readStderrTail: () => "synthetic-live-key-for-test",
        },
        { readOutput: () => "" },
      );
      expect(redactLiveBenchmarkText(error)).not.toContain("synthetic-live-key-for-test");
      expect(redactLiveBenchmarkText(JSON.stringify({ error }))).toContain("[REDACTED]");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  function liveTerminal(runId: string) {
    return {
      runId,
      status: "ok",
      terminalReply: { disposition: "visible", text: "LIVE_GATEWAY_OK_1" },
      terminalReceipt: {
        runId,
        sessionId: "live-session",
        turnId: "live-turn",
        requested: { provider: "openai", model: LIVE_GATEWAY_MODEL_ID },
        effective: {
          provider: "openai",
          model: LIVE_GATEWAY_MODEL_ID,
          responseModel: LIVE_GATEWAY_MODEL_ID,
        },
        terminalDisposition: "visible",
        successfulToolNames: [],
        rerouted: false,
      },
    };
  }

  it.each(["wrong model", "wrong response", "missing receipt"])(
    "rejects live %s through the shared turn entry point",
    async (failure) => {
      const live = createLiveGatewayEvidence(["main"], 1);
      const accounting = { launched: 0, terminalOk: 0, verified: 0 };
      const rpc = async <T>(method: string, params: unknown): Promise<T> => {
        const request = params as { idempotencyKey: string; runId: string };
        if (method === "agent") {
          return { status: "accepted", runId: request.idempotencyKey } as T;
        }
        const terminal = liveTerminal(request.runId);
        if (failure === "wrong model") {
          terminal.terminalReceipt.effective.responseModel = "other-model";
        }
        if (failure === "wrong response") {
          terminal.terminalReply.text = "different reply";
        }
        return (
          failure === "missing receipt" ? { ...terminal, terminalReceipt: undefined } : terminal
        ) as T;
      };
      await expect(
        testing.runTurn(rpc, 0, performance.now() + 1000, false, { live, accounting }),
      ).rejects.toThrow("Live terminal");
      expect(accounting).toEqual({ launched: 1, terminalOk: 1, verified: 0 });
      expect(live.snapshot().turns[0]?.terminalVerified).toBe(false);
      expect(JSON.stringify(live.snapshot())).not.toContain("different reply");
    },
  );

  it("requires streamed, terminal, history, and persisted live evidence", async () => {
    await withTempDir("gateway-live-evidence-", async (root) => {
      const live = createLiveGatewayEvidence(["main"], 1);
      const accounting = { launched: 0, terminalOk: 0, verified: 0 };
      const message = { role: "assistant", content: [{ type: "text", text: "LIVE_GATEWAY_OK_1" }] };
      const rpc = async <T>(method: string, params: unknown): Promise<T> => {
        const request = params as { idempotencyKey: string; runId: string };
        if (method === "agent") {
          live.onEvent({
            event: "agent",
            payload: {
              runId: request.idempotencyKey,
              stream: "assistant",
              data: { delta: "LIVE_GATEWAY_OK_1" },
            },
          });
          live.onEvent({
            event: "chat",
            payload: { runId: request.idempotencyKey, state: "final", message },
          });
          return { status: "accepted", runId: request.idempotencyKey } as T;
        }
        if (method === "agent.wait") {
          return liveTerminal(request.runId) as T;
        }
        if (method === "chat.history") {
          return { sessionId: "live-session", messages: [message] } as T;
        }
        throw new Error(`Unexpected RPC ${method}`);
      };
      await testing.runTurn(rpc, 0, performance.now() + 1000, false, { live, accounting });
      await live.captureHistories(rpc);
      const agentDir = path.join(root, "state", "agents", "main", "agent");
      await mkdir(agentDir, { recursive: true });
      const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
      try {
        database.exec(
          "CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
        );
        expect(live.finish(root).passed).toBe(false);
        database
          .prepare("INSERT INTO transcript_events VALUES (?, ?, ?)")
          .run("live-session", 1, JSON.stringify({ message }));
      } finally {
        database.close();
      }
      const proof = live.finish(root);
      expect(proof.passed).toBe(true);
      expect(proof.turns[0]).toMatchObject({
        historyMatches: 1,
        persistedMatches: 1,
        streamMatches: true,
        finalMatches: true,
      });
      live.onEvent({
        event: "chat",
        payload: { runId: proof.turns[0]?.runId, state: "final", message },
      });
      expect(live.finish(root).passed).toBe(false);
    });
  });

  it("partitions acknowledged ingress without attributing later selection events to the same phase", () => {
    const snapshots = [0, 2, 5, 7, 15, 19].map((responses, index) =>
      testing.parseMockRequests(
        {
          id: "mock-one",
          ingress: { responses, chatCompletions: 0, embeddings: index * 2, other: index },
          selections: { model: index, global: 0, automaticTool: 0, automaticText: index },
        },
        index * 10,
        index * 10 + 2,
      ),
    );
    const result = testing.summarizeMockRequests(snapshots);
    expect(result.ingress).toEqual({
      startupAndWarmup: { responses: 2, chatCompletions: 0, embeddings: 2, other: 1 },
      setup: { responses: 3, chatCompletions: 0, embeddings: 2, other: 1 },
      agentWarmup: { responses: 2, chatCompletions: 0, embeddings: 2, other: 1 },
      loadBracket: { responses: 8, chatCompletions: 0, embeddings: 2, other: 1 },
      postLoad: { responses: 4, chatCompletions: 0, embeddings: 2, other: 1 },
      total: { responses: 19, chatCompletions: 0, embeddings: 10, other: 5 },
    });
    expect(result.selections).toEqual({ model: 5, global: 0, automaticTool: 0, automaticText: 5 });
    expect(() => testing.summarizeMockRequests(snapshots.slice(1))).toThrow("incomplete");
    const finalSnapshot = snapshots[5];
    assert(finalSnapshot);
    for (const change of [
      { id: "replacement" },
      { beforeMs: 0 },
      { ingress: { ...finalSnapshot.ingress, responses: 1 } },
      { selections: { ...finalSnapshot.selections, model: 0 } },
    ]) {
      expect(() =>
        testing.summarizeMockRequests([...snapshots.slice(0, 5), { ...finalSnapshot, ...change }]),
      ).toThrow("regressed");
    }
  });

  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects missing or unsafe mock counters: %s",
    (responses) => {
      expect(() =>
        testing.parseMockRequests(
          {
            id: "mock",
            ingress: { responses, chatCompletions: 0, embeddings: 0, other: 0 },
            selections: { model: 0, global: 0, automaticTool: 0, automaticText: 0 },
          },
          0,
          1,
        ),
      ).toThrow("invalid");
    },
  );

  it("copies producer snapshots instead of retaining mutable counter objects", () => {
    const producer = {
      id: "mock",
      ingress: { responses: 0, chatCompletions: 0, embeddings: 0, other: 0 },
      selections: { model: 0, global: 0, automaticTool: 0, automaticText: 0 },
    };
    const snapshot = testing.parseMockRequests(producer, 0, 1);
    producer.ingress.responses = 1;
    producer.selections.model = 1;
    expect(snapshot.ingress.responses).toBe(0);
    expect(snapshot.selections.model).toBe(0);
    expect(() => testing.parseMockRequests(undefined, 0, 1)).toThrow("identity");
  });

  it.each([false, true])(
    "records tool events before or after final observation (delayed: %s)",
    async (delayed) => {
      const evidence = testing.createTurnEvidence(true);
      let runId = "";
      let emitToolEvents = () => {};
      const rpc = async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "agent") {
          const turn = params as { idempotencyKey: string; sessionKey: string };
          runId = turn.idempotencyKey;
          emitToolEvents = () => {
            for (const phase of ["start", "result"]) {
              evidence.onEvent({
                event: "session.tool",
                payload: {
                  runId,
                  sessionKey: turn.sessionKey,
                  data: {
                    phase,
                    name: "exec",
                    toolCallId: "call",
                    isError: false,
                    result: {
                      details: {
                        status: "completed",
                        exitCode: 0,
                        aggregated: "openclaw-draft-proof\n",
                      },
                    },
                  },
                },
              });
            }
          };
          if (!delayed) {
            emitToolEvents();
          }
          // The terminal fast path must still obtain canonical agent.wait evidence.
          return { runId, status: "ok" } as T;
        }
        evidence.onEvent({
          event: "session.observer",
          payload: {
            runId,
            sessionKey: "agent:main:test",
            assessment: "Synthetic benchmark observation is valid.",
          },
        });
        return {
          ...successfulTerminal(true),
          runId,
          terminalReceipt: { ...successfulTerminal(true).terminalReceipt, runId },
        } as T;
      };
      await testing.runTurn(rpc, 0, performance.now() + 10_000, true, {
        sessionKey: "agent:main:test",
        evidence,
      });
      if (delayed) {
        emitToolEvents();
      }
      expect(evidence.finish()).toEqual({ toolTurns: 1, observerModelDigestTurns: 1 });
      expect(() =>
        evidence.onEvent({
          event: "session.tool",
          payload: {
            runId,
            sessionKey: "agent:main:test",
            data: { phase: "result", name: "exec", toolCallId: "call" },
          },
        }),
      ).not.toThrow();
      expect(() => evidence.finish()).toThrow("duplicated");
    },
  );

  it("separates warmed lifecycle totals while retaining late warmup validation", async () => {
    const evidence = testing.createTurnEvidence(true);
    const runs: string[] = [];
    const sessionKey = "agent:main:phase-test";
    const toolResult = (runId: string) => ({
      event: "session.tool",
      payload: {
        runId,
        sessionKey,
        data: {
          phase: "result",
          name: "exec",
          toolCallId: runId,
          isError: false,
          result: {
            details: { status: "completed", exitCode: 0, aggregated: "openclaw-draft-proof" },
          },
        },
      },
    });
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      if (method === "agent") {
        const runId = (params as { idempotencyKey: string }).idempotencyKey;
        runs.push(runId);
        evidence.onEvent({
          event: "session.tool",
          payload: {
            runId,
            sessionKey,
            data: { phase: "start", name: "exec", toolCallId: runId },
          },
        });
        evidence.onEvent(toolResult(runId));
        evidence.onEvent({
          event: "session.observer",
          payload: {
            runId,
            sessionKey,
            assessment: "Synthetic benchmark observation is valid.",
          },
        });
        return { runId, status: "ok" } as T;
      }
      const runId = (params as { runId: string }).runId;
      return {
        ...successfulTerminal(true),
        runId,
        terminalReceipt: { ...successfulTerminal(true).terminalReceipt, runId },
      } as T;
    };
    for (const warmup of [true, false]) {
      await testing.runTurn(rpc, 0, performance.now() + 10_000, true, {
        sessionKey,
        evidence,
        warmup,
      });
    }
    expect(evidence.finish()).toEqual({ toolTurns: 1, observerModelDigestTurns: 1 });
    expect(evidence.finish("warmup")).toEqual({ toolTurns: 1, observerModelDigestTurns: 1 });
    evidence.onEvent(toolResult(runs[0]!));
    expect(() => evidence.finish()).toThrow("duplicated");
    expect(() => evidence.finish("warmup")).toThrow("duplicated");
  });

  it.each([undefined, "another-run"])(
    "rejects a missing or mismatched agent.wait identity: %s",
    async (waitRunId) => {
      const rpc = async <T>(method: string): Promise<T> =>
        (method === "agent"
          ? { runId: "expected-run", status: "accepted" }
          : { runId: waitRunId, status: "ok" }) as T;
      await expect(testing.runTurn(rpc, 0, performance.now() + 10_000)).rejects.toThrow(
        "agent.wait returned a different or missing benchmark run identity",
      );
    },
  );

  it.each([
    { name: "missing", result: undefined },
    {
      name: "validation error",
      result: {
        isError: true,
        result: {
          details: { status: "completed", exitCode: 0, aggregated: "openclaw-draft-proof" },
        },
      },
    },
    {
      name: "approval unavailable",
      result: { isError: false, result: { details: { status: "approval-unavailable" } } },
    },
    {
      name: "nonzero",
      result: {
        isError: false,
        result: {
          details: { status: "completed", exitCode: 1, aggregated: "openclaw-draft-proof" },
        },
      },
    },
    {
      name: "wrong call",
      result: {
        toolCallId: "other",
        isError: false,
        result: {
          details: { status: "completed", exitCode: 0, aggregated: "openclaw-draft-proof" },
        },
      },
    },
  ])("does not let a final marker conceal $name tool evidence", ({ result }) => {
    const evidence = testing.createTurnEvidence(true);
    evidence.register("run", "session");
    const tool = {
      event: "session.tool",
      payload: {
        runId: "run",
        sessionKey: "session",
        data: { name: "exec", toolCallId: "call", phase: "start" },
      },
    };
    evidence.onEvent(tool);
    if (result) {
      evidence.onEvent({
        ...tool,
        payload: { ...tool.payload, data: { ...tool.payload.data, phase: "result", ...result } },
      });
    }
    evidence.complete("run", { disposition: "visible", text: "OPENCLAW_E2E_DRAFTPROOF" });
    expect(() => evidence.finish()).toThrow("unsuccessful");
  });

  it.each([undefined, { disposition: "silent" }, { disposition: "visible", text: "wrong" }])(
    "rejects absent or incorrect final reply evidence",
    (reply) => {
      const evidence = testing.createTurnEvidence(true);
      evidence.register("run", "session");
      expect(() => evidence.complete("run", reply)).toThrow("visible final");
      expect(() => evidence.finish()).toThrow();
    },
  );

  it("rejects a changed Gateway CPU entitlement during measurement", () => {
    const before = {
      pid: 1,
      atMonotonicMicros: 1,
      process: { user: 0, system: 0 },
      mainThread: { user: 0, system: 0 },
      cpuEnvironment: { availableParallelism: 2, affinity: "0-1" },
    };
    expect(() =>
      measureGatewayCpuUsage(before, {
        ...before,
        atMonotonicMicros: 2,
        cpuEnvironment: { availableParallelism: 32, affinity: "0-31" },
      }),
    ).toThrow("changed during measurement");
  });

  it("classifies clipped utility requests before quoted turn markers and retains unbound continuations", () => {
    const recap = summarizeMockInferenceRequest({
      instructions: "Write an Activity recap for someone scanning their tasks: what was done here",
      input: [{ role: "user", content: "benchmark stream 1." }],
    });
    expect(recap).toMatchObject({ purpose: "activity-recap" });
    expect(recap.turnIndex).toBeUndefined();
    const continuation = summarizeMockInferenceRequest({
      previous_response_id: "mock-response",
      input: [{ type: "function_call_output", output: "done" }],
    });
    expect(continuation).toMatchObject({
      purpose: "other",
      hasToolOutput: true,
      hasPreviousResponse: true,
    });
    const records = [recap, continuation].map((inferenceFacts, index) =>
      JSON.stringify({
        seq: index + 1,
        method: "POST",
        path: "/v1/responses",
        body: { truncated: true, byteLength: 300_000 },
        requestBytes: 300_000,
        inferenceFacts,
      }),
    );
    expect(testing.summarizeProviderRequests(records, 0, 2)).toMatchObject({
      load: { inference: 2, requestBytes: 600_000, unknownRequestBytes: 0 },
      loadPurposes: { "activity-recap": 1, other: 1 },
      loadTurns: [],
      unboundLoadInference: 2,
      unclassifiedLoadInference: 1,
      loadContinuations: { withPreviousResponse: 1, withToolOutput: 1, unboundToolOutput: 1 },
    });
    expect(
      summarizeMockInferenceRequest({
        messages: [
          {
            role: "system",
            content:
              "You judge the trajectory of a running AI agent session for an operator status surface.",
          },
          { role: "user", content: "benchmark stream 2." },
        ],
      }).purpose,
    ).toBe("session-observer");
  });

  it("binds Responses continuations through runtime context to the newest ordinary user", () => {
    const runtimeContext = {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nQuoted benchmark stream 99.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      ],
    };
    const input = [
      { role: "user", content: "benchmark stream 1." },
      { role: "assistant", content: "old answer" },
      { role: "user", content: [{ type: "input_text", text: "benchmark warmup tool stream 2." }] },
      runtimeContext,
      { type: "function_call_output", output: "done" },
    ];
    expect(summarizeMockInferenceRequest({ input })).toMatchObject({
      purpose: "benchmark-turn",
      benchmarkPhase: "warmup",
      turnIndex: 2,
      hasToolOutput: true,
    });
    for (const content of [
      "an ordinary newer request",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nan incomplete carrier",
      "ordinary prefix\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\ncontext\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ]) {
      const facts = summarizeMockInferenceRequest({
        input: [...input, { role: "user", content }, runtimeContext],
      });
      expect(facts.purpose).toBe("other");
      expect(facts.turnIndex).toBeUndefined();
      expect(facts.hasToolOutput).toBe(false);
    }
  });

  it("keeps same-process warmup markers and request ordinals outside measured turns", () => {
    const bodies = [
      { input: [{ role: "user", content: "benchmark warmup stream 1." }] },
      { input: [{ role: "user", content: [{ type: "input_text", text: "benchmark stream 1." }] }] },
    ];
    const records = bodies.map((body, index) =>
      JSON.stringify({
        seq: index + 1,
        method: "POST",
        path: "/v1/responses",
        body: JSON.stringify(body),
        inferenceFacts: summarizeMockInferenceRequest(body),
      }),
    );
    expect(
      testing.summarizeProviderRequests(records, 1, 2, { beforeOrdinal: 0, afterOrdinal: 1 }),
    ).toMatchObject({
      setup: { inference: 0 },
      warmup: { inference: 1, byPurpose: { "benchmark-turn": 1 } },
      load: { inference: 1 },
      loadTurns: [{ turnIndex: 1, withoutToolOutput: 1, withToolOutput: 0 }],
    });
    expect(() =>
      testing.summarizeProviderRequests(records, 1, 2, { beforeOrdinal: 0, afterOrdinal: 2 }),
    ).toThrow("warmup snapshots");
    expect(
      testing.parseOptions(["--agent-warmup-turns", "1", "--gateway-cpus", "0,1"]),
    ).toMatchObject({ agentWarmupTurns: 1, gatewayCpus: "0,1" });
    expect(() => testing.parseOptions(["--agent-warmup-turns", "11"])).toThrow(
      "--agent-warmup-turns",
    );
    expect(() => testing.parseOptions(["--gateway-cpus", "0-1"])).toThrow("--gateway-cpus");
  });

  it("separates setup and embeddings from timed model rounds before deleting the request log", () => {
    const records = [
      { path: "/v1/responses", body: { input: [] } },
      { path: "/v1/embeddings", body: { input: "seeded transcript" } },
      {
        path: "/v1/responses",
        body: { input: [{ role: "user", content: "benchmark tool stream 1." }] },
      },
      {
        path: "/v1/responses",
        body: {
          input: [
            { role: "user", content: "benchmark tool stream 1." },
            { type: "function_call_output", output: "ok" },
          ],
        },
      },
      { path: "/v1/responses", body: { input: [{ role: "user", content: "background work" }] } },
    ].map((record, index) =>
      JSON.stringify({
        ...record,
        method: "POST",
        seq: index + 1,
        body: JSON.stringify(record.body),
      }),
    );
    expect(testing.summarizeProviderRequests(records, 2, 4)).toMatchObject({
      setup: {
        total: 2,
        inference: 1,
        byEndpoint: { "POST /v1/responses": 1, "POST /v1/embeddings": 1 },
      },
      load: { total: 2, inference: 2 },
      afterLoad: { total: 1, inference: 1 },
      loadTurns: [{ turnIndex: 1, withoutToolOutput: 1, withToolOutput: 1 }],
      unclassifiedLoadInference: 0,
    });
    expect(() => testing.summarizeProviderRequests(records.slice(1), 2, 4)).toThrow(
      "missing or repeated ordinal",
    );
    expect(() => testing.summarizeProviderRequests(records, 4, 2)).toThrow("out of order");
  });

  it("retains unclassifiable inference arrivals in the denominator", () => {
    const records = [
      { truncated: true, byteLength: 300_000, preview: "bounded evidence" },
      "[unparseable request body redacted: 42 bytes]",
      JSON.stringify({ input: [{ role: "user" }] }),
    ].map((body, index) =>
      JSON.stringify({ seq: index + 1, method: "POST", path: "/v1/responses", body }),
    );
    expect(testing.summarizeProviderRequests(records, 0, 3)).toMatchObject({
      load: { total: 3, inference: 3 },
      loadTurns: [],
      unclassifiedLoadInference: 3,
    });
  });
  it("reports process CPU per completed turn separately from main-thread CPU and probe samples", () => {
    const first = createBenchmarkRun();
    const second = createBenchmarkRun({
      turnCount: 16,
      cpuUsage: {
        ...first.cpuUsage,
        process: { userMs: 96, systemMs: 24, totalMs: 120 },
        mainThread: { userMs: 60, systemMs: 20, totalMs: 80 },
      },
    });

    expect(testing.summarizeRuns([first, second])).toMatchObject({
      cpuCoreRatio: null,
      gatewayProcessCpuMs: { count: 2, p50: 64, max: 120 },
      gatewayProcessCpuMsPerTurn: { count: 2, p50: 7.5, max: 8 },
      gatewayMainThreadCpuMs: { count: 2, p50: 40, max: 80 },
      gatewayProcessCpuCoreRatio: { count: 2, p50: 0.64, max: 1.2 },
    });
  });

  it.each([
    {
      name: "populated",
      fields: { externalBytes: 2_621_440, arrayBuffersBytes: 1_572_864 },
      expected: { externalMb: 2.5, arrayBuffersMb: 1.5 },
    },
    {
      name: "zero",
      fields: { externalBytes: 0, arrayBuffersBytes: 0 },
      expected: { externalMb: 0, arrayBuffersMb: 0 },
    },
    { name: "missing", fields: {}, expected: {} },
    {
      name: "external-only",
      fields: { externalBytes: 2_621_440 },
      expected: { externalMb: 2.5 },
    },
    {
      name: "ArrayBuffers-only",
      fields: { arrayBuffersBytes: 1_572_864 },
      expected: { arrayBuffersMb: 1.5 },
    },
    {
      name: "invalid",
      fields: { externalBytes: "unknown", arrayBuffersBytes: Number.POSITIVE_INFINITY },
      expected: {},
    },
  ])("preserves $name optional Gateway memory in MiB", async ({ fields, expected }) => {
    const rpc = vi.fn().mockResolvedValue({
      processMemory: {
        heapTotalBytes: 1_310_720,
        heapUsedBytes: 524_288,
        rssBytes: 3_145_728,
        ...fields,
      },
    });

    const sample = await readGatewayMemory(rpc, performance.now());

    expect(rpc).toHaveBeenCalledExactlyOnceWith("status", { includeChannelSummary: false });
    expect(sample).toEqual({
      atMs: expect.any(Number),
      heapTotalMb: 1.25,
      heapUsedMb: 0.5,
      rssMb: 3,
      ...expected,
    });
  });

  it("summarizes only observed optional memory values and complete growth pairs", () => {
    const memory = createBenchmarkRun().memory;
    const runs = [
      {
        before: { externalMb: 2, arrayBuffersMb: 1 },
        after: { externalMb: 5, arrayBuffersMb: 2 },
      },
      {
        before: { externalMb: 0, arrayBuffersMb: 0 },
        after: { externalMb: 0, arrayBuffersMb: 0 },
      },
      {
        before: { externalMb: 8, arrayBuffersMb: 3 },
        after: { externalMb: 6, arrayBuffersMb: 1.5 },
      },
      { before: { externalMb: 100 }, after: { arrayBuffersMb: 6 } },
      { before: { arrayBuffersMb: 8 }, after: { externalMb: 9 } },
      { before: {}, after: {} },
    ].map(({ before, after }) =>
      createBenchmarkRun({
        memory: {
          ...memory,
          before: { ...memory.before, ...before },
          after: { ...memory.after, ...after },
        },
      }),
    );

    expect(testing.summarizeRuns(runs)).toMatchObject({
      gatewayExternalMb: { count: 4, max: 9, p50: 5, p95: 9, p99: 9 },
      gatewayExternalGrowthMb: { count: 3, max: 3, p50: 0, p95: 3, p99: 3 },
      gatewayArrayBuffersMb: { count: 4, max: 6, p50: 1.5, p95: 6, p99: 6 },
      gatewayArrayBuffersGrowthMb: { count: 3, max: 1, p50: 0, p95: 1, p99: 1 },
    });
  });

  it("writes load CPU and collected allocations before child teardown, excluding startup", async () => {
    await withTempDir("gateway-heap-profile-", async (dir) => {
      const child = spawn(
        testNodeExecPath,
        [
          "--expose-gc",
          "--import",
          new URL("../../scripts/lib/gateway-bench-profile-preload.ts", import.meta.url).href,
          "--input-type=module",
          "--eval",
          `process.stdin.resume();
        function startupAllocations() {
          return Array.from({ length: 20000 }, (_, index) => Array(100).fill(index));
        }
        globalThis.startup = startupAllocations();
        globalThis.startup = null;
        gc();
        function loadAllocations() {
          return Array.from({ length: 20000 }, (_, index) => Array(100).fill(index));
        }
        function loadCpuWork() {
          const until = performance.now() + 250;
          while (performance.now() < until) {}
        }
        process.on("message", (message) => {
          if (message !== "allocate") return;
          loadCpuWork();
          globalThis.load = loadAllocations();
          globalThis.load = null;
          gc();
          gc();
          process.send("allocated");
        });
        process.send("ready");`,
        ],
        { stdio: ["pipe", "pipe", "pipe", "ipc"] },
      );
      const exited = once(child, "exit");
      try {
        const ready = await Promise.race([
          once(child, "message"),
          exited.then(() => {
            throw new Error("Heap profile fixture exited before ready");
          }),
        ]);
        expect(ready[0]).toBe("ready");
        const profilePath = `${dir}/load.heapprofile`;
        const cpuProfilePath = `${dir}/load.cpuprofile`;
        await controlGatewayProfile(child, "cpu", "start", cpuProfilePath);
        const allocated = once(child, "message");
        child.send("allocate");
        expect((await allocated)[0]).toBe("allocated");
        await controlGatewayProfile(child, "cpu", "stop", cpuProfilePath);
        await controlGatewayProfile(child, "heap", "start", profilePath);
        const heapAllocated = once(child, "message");
        child.send("allocate");
        expect((await heapAllocated)[0]).toBe("allocated");
        await controlGatewayProfile(child, "heap", "stop", profilePath);
        expect(child.exitCode).toBeNull();
        const cpuSummary = readGatewayCpuProfile(cpuProfilePath);
        expect(cpuSummary.sampleCount).toBeGreaterThan(0);
        const cpu: Profiler.Profile = JSON.parse(await readFile(cpuProfilePath, "utf8"));
        const functions = cpu.nodes.map((node) => node.callFrame.functionName);
        expect(functions).toContain("loadCpuWork");
        expect(functions).not.toContain("startupAllocations");
        const profile = readGatewayHeapProfile(profilePath);
        expect(profile.sampledAllocatedBytes).toBeGreaterThan(1_000_000);
        const stacks = profile.topAllocationSites.flatMap((site) => site.stack).join("\n");
        expect(stacks).toContain("loadAllocations");
        expect(stacks).not.toContain("startupAllocations");
      } finally {
        child.kill();
        await exited;
      }
    });
  });

  it("parses benchmark controls without booting a gateway", () => {
    expect(
      testing.parseOptions([
        "--agent-count",
        "12",
        "--concurrency",
        "12",
        "--turns-per-session",
        "8",
        "--runs",
        "2",
        "--warmup",
        "0",
        "--cadence-ms",
        "50",
        "--timeout-ms",
        "90000",
        "--cpu-prof-dir",
        "/tmp/gateway-cpu-profiles",
        "--heap-prof-dir",
        "/tmp/gateway-heap-profiles",
        "--plugin-count",
        "50",
        "--probe-rounds",
        "20",
        "--session-count",
        "120",
        "--control-plane",
        "--history-messages",
        "20",
        "--history-message-chars",
        "8192",
        "--history-clients",
        "6",
        "--history-burst",
        "5",
        "--session-updates",
        "500",
        "--session-update-clients",
        "8",
        "--subscribers",
        "4",
        "--stream-chunk-delay-ms",
        "2000",
        "--max-control-ms",
        "2000",
        "--max-handshake-ms",
        "2000",
        "--tool-events",
        "--no-diagnostics-timeline",
        "--visible-observer",
        "--workspace-fanout",
        "--output",
        "concurrency.json",
        "--json",
      ]),
    ).toMatchObject({
      agentCount: 12,
      cadenceMs: 50,
      concurrency: 12,
      cpuProfDir: "/tmp/gateway-cpu-profiles",
      heapProfDir: "/tmp/gateway-heap-profiles",
      diagnosticsTimeline: false,
      json: true,
      historyBurst: 5,
      historyClients: 6,
      historyMessages: 20,
      historyMessageChars: 8192,
      controlPlane: true,
      maxControlMs: 2_000,
      maxHandshakeMs: 2_000,
      output: "concurrency.json",
      pluginCount: 50,
      probeRounds: 20,
      runs: 2,
      sessionCount: 120,
      sessionUpdateClients: 8,
      sessionUpdates: 500,
      streamChunkDelayMs: 2_000,
      subscribers: 4,
      timeoutMs: 90_000,
      toolEvents: true,
      turnsPerSession: 8,
      visibleObserver: true,
      warmup: 0,
      workspaceFanout: true,
    });
    expect(() => testing.parseOptions(["--concurrency", "65"])).toThrow(
      "--concurrency must be at most 64",
    );
    expect(testing.parseOptions([]).turnsPerSession).toBe(1);
    expect(testing.parseOptions([]).agentCount).toBe(1);
    expect(
      testing.parseOptions(["--agent-count", "128", "--session-count", "1000"]).agentCount,
    ).toBe(128);
    for (const value of ["0", "1.5", "129"]) {
      expect(() => testing.parseOptions(["--agent-count", value])).toThrow("--agent-count");
    }
    expect(() => testing.parseOptions(["--agent-count", "9"])).toThrow(
      "--agent-count must not exceed the total session count",
    );
    expect(
      testing.parseOptions(["--load-cpu-prof-dir", "/tmp/gateway-load-cpu-profiles"])
        .loadCpuProfDir,
    ).toBe("/tmp/gateway-load-cpu-profiles");
    expect(() => testing.parseOptions(["--turns-per-session", "0"])).toThrow("--turns-per-session");
    expect(() => testing.parseOptions(["--turns-per-session", "101"])).toThrow(
      "--turns-per-session must be at most 100",
    );
    expect(() => testing.parseOptions(["--runs", "2", "--runs", "3"])).toThrow(
      "--runs was provided more than once",
    );
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
    expect(() => testing.parseOptions(["--plugin-count", "101"])).toThrow(
      "--plugin-count must be at most 100",
    );
    expect(testing.parseOptions(["--session-count", "10000"]).sessionCount).toBe(10_000);
    expect(() => testing.parseOptions(["--session-count", "10001"])).toThrow(
      "--session-count must be at most 10000",
    );
    expect(() => testing.parseOptions(["--history-burst", "33"])).toThrow(
      "--history-burst must be at most 32",
    );
    expect(() => testing.parseOptions(["--session-updates", "100001"])).toThrow(
      "--session-updates must be at most 100000",
    );
    expect(testing.parseOptions([]).diagnosticsTimeline).toBe(true);
    expect(testing.parseOptions([]).probeRounds).toBeUndefined();
    expect(() => testing.parseOptions(["--probe-rounds", "0"])).toThrow();
    expect(() => testing.parseOptions(["--probe-rounds", "2049"])).toThrow(
      "--probe-rounds must be at most 2048",
    );
    expect(() =>
      testing.parseOptions([
        "--probe-rounds",
        "205",
        "--history-clients",
        "2",
        "--history-burst",
        "5",
      ]),
    ).toThrow("fixed history workload must not exceed 2048 requests per run");
    expect(() =>
      testing.parseOptions(["--session-count", "10000", "--history-messages", "500"]),
    ).toThrow("synthetic history");
    expect(() =>
      testing.parseOptions([
        "--session-count",
        "1000",
        "--history-messages",
        "10",
        "--history-message-chars",
        "65536",
      ]),
    ).toThrow("synthetic history");
  });

  it("rejects overlapping load CPU and heap captures before gateway startup", () => {
    expect(() =>
      testing.parseOptions(["--load-cpu-prof-dir", "/tmp/cpu", "--heap-prof-dir", "/tmp/heap"]),
    ).toThrow("--load-cpu-prof-dir and --heap-prof-dir require separate benchmark runs");
  });

  it("summarizes plugin metadata scans captured after startup warmup", () => {
    expect(
      testing.summarizePluginMetadataScans([
        { durationMs: 18, name: "plugins.metadata.scan" },
        { durationMs: 22, name: "plugins.metadata.scan" },
        { durationMs: 9, name: "plugins.metadata.freeze" },
      ]),
    ).toEqual({
      count: 2,
      durationMs: { count: 2, max: 22, p50: 18, p95: 22, p99: 22 },
      totalDurationMs: 40,
    });
  });

  it("does not report missing or incomplete timeline evidence as zero scans", async () => {
    await withTempDir("openclaw-concurrency-timeline-", async (root) => {
      const file = `${root}/timeline.jsonl`;
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow();
      await writeFile(file, "");
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow();
      await writeFile(file, '{"type":"span.end","name":"plugins.metadata.scan"');
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow();
    });
  });

  it("counts load spans by emission time even when buffered setup spans arrive later", async () => {
    await withTempDir("openclaw-concurrency-timeline-", async (root) => {
      const file = `${root}/timeline.jsonl`;
      const spans = [999, 1_000, 1_500, 2_000, 2_001].map((timestamp) => ({
        schemaVersion: "openclaw.diagnostics.v1",
        type: "span.end",
        name: "plugins.metadata.scan",
        durationMs: 10,
        timestamp: new Date(timestamp).toISOString(),
      }));
      await writeFile(file, spans.map((span) => JSON.stringify(span)).join("\n") + "\n");

      expect(
        testing.summarizePluginMetadataScans(
          testing.readDiagnosticsTimelineSpans(file, { from: 1_000, through: 2_000 }),
        ),
      ).toMatchObject({ count: 3, totalDurationMs: 30 });
      await writeFile(file, JSON.stringify({ ...spans[0], timestamp: "invalid" }) + "\n");
      expect(() => testing.readDiagnosticsTimelineSpans(file)).toThrow("invalid diagnostics");
    });
  });

  it("aggregates plugin metadata scans across measured runs", () => {
    const createRun = (count: number, durations: number[]) =>
      createBenchmarkRun({
        pluginMetadataScans: {
          count,
          durationMs: testing.summarizeNumbers(durations),
          totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
        },
      });

    expect(testing.summarizeRuns([createRun(2, [10, 20]), createRun(1, [30])])).toMatchObject({
      gatewayExternalMb: null,
      gatewayExternalGrowthMb: null,
      gatewayArrayBuffersMb: null,
      gatewayArrayBuffersGrowthMb: null,
      gatewayHeapGrowthMb: { count: 2, max: 20, p50: 20, p95: 20, p99: 20 },
      gatewayPeakRssMb: { count: 2, max: 210, p50: 210, p95: 210, p99: 210 },
      gatewayRssGrowthMb: { count: 2, max: 20, p50: 20, p95: 20, p99: 20 },
      mockRequestIngress: { responses: 2, chatCompletions: 0, embeddings: 0, other: 0 },
      mockResponseSelections: { model: 0, global: 0, automaticTool: 0, automaticText: 2 },
      pluginMetadataScanCount: 3,
      pluginMetadataScanTotalDurationMs: 60,
    });
  });

  it("reports p50, p95, p99, and max with nearest-rank percentiles", () => {
    expect(testing.summarizeNumbers([100, 1, 4, 2, 3])).toEqual({
      count: 5,
      max: 100,
      p50: 3,
      p95: 100,
      p99: 100,
    });
    expect(testing.summarizeNumbers([])).toBeNull();
  });

  it.each([
    ["readyz", "readyz"],
    ["controlUi", "Control UI"],
    ["sessionsList", "sessions.list"],
    ["history", "chat.history"],
    ["messageSubscriptionsDuringLoad", "sessions.messages.subscribe"],
    ["sessionUpdates", "sessions.patch"],
  ] as const)("enforces the control budget for measured %s probes", (field, name) => {
    const options = testing.parseOptions(["--max-control-ms", "2000"]);
    const probe: BenchmarkRun["readyz"][number] = {
      atMs: 0,
      cpuCoreRatio: null,
      degraded: null,
      degradedSinceMs: null,
      delayP99Ms: null,
      delayMaxMs: null,
      error: null,
      latencyMs: 2_000,
      ok: true,
      status: 200,
      utilization: null,
    };
    const run = createBenchmarkRun({ [field]: [probe] });
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([]);

    probe.latencyMs = 2_576;
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      `Gateway ${name} probe exceeded 2000ms: ok=true latencyMs=2576.0 error=none`,
    ]);

    probe.latencyMs = 10;
    probe.ok = false;
    probe.error = "request failed";
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      `Gateway ${name} probe exceeded 2000ms: ok=false latencyMs=10.0 error=request failed`,
    ]);
    expect(testing.summarizeRuns([run]).budgetViolations).toEqual([]);
  });

  it.each(["cron.list", "cron.status"])("enforces the control budget for %s", (method) => {
    const run = createBenchmarkRun({
      controlPlane: [
        {
          method,
          atMs: 0,
          error: null,
          latencyMs: 2001,
          ok: true,
        },
      ],
    });
    const summary = testing.summarizeRuns([run], { maxControlMs: 2000 });
    expect(summary.budgetViolations).toEqual([
      `Gateway ${method} probe exceeded 2000ms: ok=true latencyMs=2001.0 error=none`,
    ]);
    expect(summary.controlPlane[method]).toMatchObject({
      failedSamples: 0,
      latencyMs: { count: 1, max: 2001 },
    });
  });

  it("keeps setup probes outside the control budget and handshakes under their own budget", () => {
    const slowProbe = { atMs: 0, error: null, latencyMs: 5_000, ok: true };
    const slowReady = {
      ...slowProbe,
      cpuCoreRatio: null,
      degraded: null,
      degradedSinceMs: null,
      delayP99Ms: null,
      delayMaxMs: null,
      status: 200,
      utilization: null,
    };
    const run = createBenchmarkRun({
      freshConnection: slowProbe,
      messageSubscriptions: [slowProbe],
      probeWarmup: {
        durationMs: 10_000,
        samples: [{ controlUi: slowReady, readyz: slowReady, sessionsList: slowProbe }],
      },
      sessionSeedDurationMs: 10_000,
      setupDurationMs: 20_000,
      turnsDurationMs: 30_000,
    });
    const options = testing.parseOptions(["--max-control-ms", "2000"]);
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([]);
    options.maxHandshakeMs = 2_000;
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      "fresh Gateway connection exceeded 2000ms: ok=true latencyMs=5000.0 error=none",
    ]);
    run.freshConnection = { error: null, latencyMs: 2_000, ok: true };
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([]);
    run.freshConnection = { error: "unauthorized", latencyMs: 10, ok: false };
    expect(testing.summarizeRuns([run], options).budgetViolations).toEqual([
      "fresh Gateway connection exceeded 2000ms: ok=false latencyMs=10.0 error=unauthorized",
    ]);
  });

  it.each([
    { budgetMs: 2_000, minimumWaitMs: 0 },
    { budgetMs: 120_000, minimumWaitMs: 110_000 },
  ])(
    "bounds an accepted turn wait by its $budgetMs ms benchmark budget",
    async ({ budgetMs, minimumWaitMs }) => {
      const calls: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
      const rpc = async <T>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
        calls.push({ method, params, timeoutMs });
        return (
          method === "agent" ? { runId: "run-1", status: "accepted" } : { status: "timeout" }
        ) as T;
      };

      await expect(testing.runTurn(rpc, 0, performance.now() + budgetMs)).rejects.toThrow(
        "agent 1 did not complete",
      );

      const wait = calls.find((call) => call.method === "agent.wait");
      expect(wait?.params).toMatchObject({ runId: "run-1" });
      const serverTimeoutMs = (wait?.params as { timeoutMs?: unknown } | undefined)?.timeoutMs;
      if (minimumWaitMs === 0) {
        expect(serverTimeoutMs).toBe(0);
      } else {
        expect(serverTimeoutMs).toBeGreaterThanOrEqual(minimumWaitMs);
      }
      expect(wait?.timeoutMs).toEqual(expect.any(Number));
      expect(Number.isInteger(wait?.timeoutMs)).toBe(true);
      expect(wait?.timeoutMs).toBeGreaterThan(serverTimeoutMs as number);
      expect(wait?.timeoutMs).toBeLessThanOrEqual(budgetMs);
    },
  );

  function successfulTerminal(toolEvents: boolean) {
    return {
      runId: "run-1",
      status: "ok",
      terminalReply: {
        disposition: "visible",
        text: toolEvents
          ? "OPENCLAW_E2E_DRAFTPROOF"
          : "OpenClaw gateway concurrency benchmark streaming response.",
      },
      terminalReceipt: {
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        requested: { provider: "openai", model: "gpt-5.6-luna" },
        effective: {
          provider: "openai",
          model: "gpt-5.6-luna",
          responseModel: "gpt-5.6-luna",
        },
        terminalDisposition: "visible",
        successfulToolNames: toolEvents ? ["exec"] : [],
        rerouted: false,
      },
    };
  }

  it.each([
    { initialStatus: "accepted", toolEvents: false },
    { initialStatus: "ok", toolEvents: false },
    { initialStatus: "ok", toolEvents: true },
  ])(
    "verifies terminal evidence after initial $initialStatus (tools: $toolEvents)",
    async ({ initialStatus, toolEvents }) => {
      const methods: string[] = [];
      const accounting = { launched: 0, terminalOk: 0, verified: 0 };
      const rpc = async <T>(method: string): Promise<T> => {
        methods.push(method);
        return (
          method === "agent"
            ? { status: initialStatus, runId: "run-1" }
            : successfulTerminal(toolEvents)
        ) as T;
      };
      await testing.runTurn(rpc, 0, performance.now() + 60_000, toolEvents, { accounting });
      expect(methods).toEqual(["agent", "agent.wait"]);
      expect(accounting).toEqual({ launched: 1, terminalOk: 1, verified: 1 });
    },
  );

  it.each([
    {
      name: "missing receipt",
      terminal: { ...successfulTerminal(true), terminalReceipt: undefined },
    },
    {
      name: "stale run receipt",
      terminal: {
        ...successfulTerminal(true),
        terminalReceipt: { ...successfulTerminal(true).terminalReceipt, runId: "other-run" },
      },
    },
    {
      name: "failed tool",
      terminal: {
        ...successfulTerminal(true),
        terminalReceipt: { ...successfulTerminal(true).terminalReceipt, successfulToolNames: [] },
      },
    },
    {
      name: "wrong final content",
      terminal: {
        ...successfulTerminal(true),
        terminalReply: { disposition: "visible", text: "Checking the workspace before answering." },
      },
    },
    {
      name: "rerouted model",
      terminal: {
        ...successfulTerminal(true),
        terminalReceipt: { ...successfulTerminal(true).terminalReceipt, rerouted: true },
      },
    },
    { name: "yielded turn", terminal: { ...successfulTerminal(true), yielded: true } },
    { name: "pending error", terminal: { ...successfulTerminal(true), pendingError: true } },
  ])("does not count $name as verified work", async ({ terminal }) => {
    const accounting = { launched: 0, terminalOk: 0, verified: 0 };
    const rpc = async <T>(method: string): Promise<T> =>
      (method === "agent" ? { status: "accepted", runId: "run-1" } : terminal) as T;
    await expect(
      testing.runTurn(rpc, 0, performance.now() + 60_000, true, { accounting }),
    ).rejects.toThrow("terminal evidence failed");
    expect(accounting).toEqual({ launched: 1, terminalOk: 1, verified: 0 });
  });

  it("advances parallel sessions independently while serializing their own turns", async () => {
    const starts: Array<{ sessionKey: string; idempotencyKey: string; message: string }> = [];
    const startedSessions: string[] = [];
    const createTurn = () => ({
      issued: createDeferred(),
      completed: createDeferred(),
    });
    const turns = [createTurn(), createTurn(), createTurn(), createTurn()] as const;
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      if (method === "agent") {
        const request = params as (typeof starts)[number];
        starts.push(request);
        return { runId: request.idempotencyKey, status: "accepted" } as T;
      }
      const { runId } = params as { runId: string };
      const index = starts.findIndex((request) => request.idempotencyKey === runId);
      const turn = turns[index];
      if (!turn) {
        throw new Error(`Unexpected agent wait: ${runId}`);
      }
      turn.issued.resolve();
      await turn.completed.promise;
      return {
        runId,
        status: "ok",
        terminalReply: { disposition: "visible", text: "OPENCLAW_E2E_DRAFTPROOF" },
        terminalReceipt: {
          runId,
          sessionId: "session",
          turnId: runId,
          effective: { provider: "openai", model: "gpt-5.6-luna" },
          terminalDisposition: "visible",
          successfulToolNames: ["exec"],
          rerouted: false,
        },
      } as T;
    };
    const [fastSession, slowSession] = ["fast", "slow"].map((sessionKey, index) =>
      testing.runSessionTurns(rpc, index, performance.now() + 60_000, {
        onStarted: () => startedSessions.push(sessionKey),
        sessionKey,
        toolEvents: true,
        turnsPerSession: 2,
      }),
    );
    await Promise.all([turns[0].issued.promise, turns[1].issued.promise]);
    expect(starts.map((request) => request.sessionKey)).toEqual(["fast", "slow"]);

    turns[0].completed.resolve();
    await turns[2].issued.promise;
    expect(starts.map((request) => request.sessionKey)).toEqual(["fast", "slow", "fast"]);
    turns[2].completed.resolve();
    expect(await fastSession).toBe(2);
    expect(startedSessions).toEqual(["fast", "slow"]);

    turns[1].completed.resolve();
    await turns[3].issued.promise;
    turns[3].completed.resolve();
    expect(await slowSession).toBe(2);
    expect(starts.map((request) => request.sessionKey)).toEqual(["fast", "slow", "fast", "slow"]);
    expect(startedSessions).toEqual(["fast", "slow"]);
    expect(new Set(starts.map((request) => request.idempotencyKey)).size).toBe(4);
    expect(new Set(starts.map((request) => request.message)).size).toBe(4);
  });

  it("gives each fixed history client its full request budget despite different response times", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests: string[][] = [[], []];
    const finished: number[] = [];
    try {
      const jobs = requests.map((clientRequests, client) =>
        testing
          .runProbeRounds({
            rounds: 3,
            deadlineAt: performance.now() + 60_000,
            cadenceMs: 10,
            cadenceFrom: "completion",
            runFirst: false,
            shouldContinue: () => false,
            stopped: () => false,
            runRound: async (round) => {
              await Promise.all(
                Array.from({ length: 2 }, async (_, request) => {
                  clientRequests.push(`${round}:${request}`);
                  await new Promise<void>((resolve) => {
                    setTimeout(resolve, client * 50);
                  });
                }),
              );
            },
          })
          .then((count) => {
            finished.push(client);
            return count;
          }),
      );
      await vi.advanceTimersByTimeAsync(35);
      expect(finished).toEqual([0]);
      expect(requests.map((items) => items.length)).toEqual([6, 2]);
      await vi.runAllTimersAsync();
      expect(await Promise.all(jobs)).toEqual([3, 3]);
      expect(requests).toEqual([
        ["0:0", "0:1", "1:0", "1:1", "2:0", "2:1"],
        ["0:0", "0:1", "1:0", "1:1", "2:0", "2:1"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses the next fixed probe round when the load deadline is exhausted", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const issued: number[] = [];
    try {
      await expect(
        testing.runProbeRounds({
          rounds: 2,
          deadlineAt: 10,
          cadenceMs: 100,
          cadenceFrom: "start",
          runFirst: true,
          shouldContinue: () => true,
          stopped: () => false,
          runRound: async (round) => {
            issued.push(round);
            now = 11;
          },
        }),
      ).rejects.toThrow("benchmark timed out while pacing gateway probes");
      expect(issued).toEqual([0]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([true, false])(
    "preserves adaptive first-round behavior (runFirst=%s)",
    async (runFirst) => {
      const issued: number[] = [];
      expect(
        await testing.runProbeRounds({
          deadlineAt: performance.now() + 60_000,
          cadenceMs: 100,
          cadenceFrom: "start",
          runFirst,
          shouldContinue: () => false,
          stopped: () => false,
          runRound: async (round) => {
            issued.push(round);
          },
        }),
      ).toBe(runFirst ? 1 : 0);
      expect(issued).toEqual(runFirst ? [0] : []);
    },
  );

  it("joins an admitted fixed round but issues no further work after teardown starts", async () => {
    const admitted = createDeferred();
    const release = createDeferred();
    let stopped = false;
    const issued: number[] = [];
    const job = testing.runProbeRounds({
      rounds: 10,
      deadlineAt: performance.now() + 60_000,
      cadenceMs: 100,
      cadenceFrom: "completion",
      runFirst: false,
      shouldContinue: () => true,
      stopped: () => stopped,
      runRound: async (round) => {
        issued.push(round);
        admitted.resolve();
        await release.promise;
      },
    });
    await admitted.promise;
    stopped = true;
    release.resolve();
    expect(await job).toBe(1);
    expect(issued).toEqual([0]);
  });

  it("gives every gateway sample a fresh pre-warmup timeout budget", async () => {
    const deadlines: number[] = [];
    const sample = createBenchmarkRun();

    const runs = await testing.runBenchmarkSamples({
      now: (() => {
        const values = [1_000, 9_000];
        return () => values.shift() ?? 9_000;
      })(),
      options: testing.parseOptions([
        "--runs",
        "1",
        "--warmup",
        "1",
        "--timeout-ms",
        "5000",
        "--agent-count",
        "8",
      ]),
      runSample: async ({ deadlineAt, agentCount, concurrency, sessionCount, turnsPerSession }) => {
        expect({ agentCount, concurrency, sessionCount, turnsPerSession }).toEqual({
          agentCount: 8,
          concurrency: 8,
          sessionCount: 0,
          turnsPerSession: 1,
        });
        deadlines.push(deadlineAt);
        return { status: "success", run: sample };
      },
    });

    expect(deadlines).toEqual([6_000, 14_000]);
    expect(runs).toEqual({ runs: [sample], warmupRuns: [sample] });
  });

  it.each(["warmup", "measured"] as const)(
    "retains completed attempts and stops after a failed %s sample",
    async (phase) => {
      const warmup = createBenchmarkRun({ durationMs: 1 });
      const measured = createBenchmarkRun({ durationMs: 2 });
      const failed = {
        status: "failure" as const,
        errors: [{ phase: "diagnostics" as const, error: "timeline was incomplete" }],
        partialRun: createBenchmarkRun({ durationMs: 3 }),
        cleanup: { rootRemoved: true },
      };
      const completed = phase === "warmup" ? [warmup] : [warmup, measured];
      let calls = 0;
      const result = await testing.runBenchmarkSamples({
        options: testing.parseOptions(["--runs", "3", "--warmup", phase === "warmup" ? "2" : "1"]),
        runSample: async () => {
          const run = completed[calls++];
          return run ? { status: "success", run } : failed;
        },
      });
      expect(result).toEqual({
        warmupRuns: [warmup],
        runs: phase === "warmup" ? [] : [measured],
        failedAttempt: { ...failed, phase, index: 2 },
      });
      expect(calls).toBe(completed.length + 1);
    },
  );

  it("preserves HTTP and RPC failures in baseline probe diagnostics", async () => {
    const probeOrder: string[] = [];
    const server = createHttpServer((req, res) => {
      probeOrder.push(req.url ?? "missing-url");
      res.statusCode = req.url === "/readyz" ? 503 : 200;
      res.end(req.url === "/readyz" ? '{"status":"starting"}' : "not html");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected HTTP test server address");
    }
    try {
      const sample = await testing.sampleGateway({
        deadlineAt: performance.now() + 5_000,
        port: address.port,
        rpc: async () => {
          probeOrder.push("sessions.list");
          throw new Error("sessions.list failed: unauthorized");
        },
        runStartedAt: performance.now(),
        serial: true,
      });

      expect(probeOrder).toEqual(["/readyz", "/", "sessions.list"]);
      expect(sample.readyz).toMatchObject({ error: null, ok: false, status: 503 });
      expect(sample.controlUi).toMatchObject({
        error: "response body did not contain <html",
        ok: false,
        status: 200,
      });
      expect(sample.sessionsList).toMatchObject({
        error: "sessions.list failed: unauthorized",
        ok: false,
      });
      const unicodeSample = await testing.sampleGateway({
        deadlineAt: performance.now() + 5_000,
        port: address.port,
        rpc: async () => {
          throw new Error(`${"x".repeat(499)}😀`);
        },
        runStartedAt: performance.now(),
        serial: true,
      });
      expect(unicodeSample.sessionsList.error).toBe("x".repeat(499));
      const failure = testing.formatRunFailure(
        new Error(testing.formatProbeFailure(sample)),
        {
          readOutput: () => "gateway output",
          readStderrTail: () => testing.tailLines("old\nfirst retained\nlast retained\n", 2),
        },
        { readOutput: () => "mock output" },
      );
      expect(failure).toMatch(
        /readyz: ok=false status=503 latencyMs=\d+\.\d error=none\n {2}sessionsList: ok=false status=n\/a latencyMs=\d+\.\d error="sessions\.list failed: unauthorized"\n {2}controlUi: ok=false status=200 latencyMs=\d+\.\d error="response body did not contain <html"/u,
      );
      expect(failure).toContain("gateway stderr tail:\nfirst retained\nlast retained");
      expect(failure).not.toContain("old");

      const healthySlow = {
        controlUi: { ...sample.controlUi, error: null, latencyMs: 200, ok: true },
        readyz: { ...sample.readyz, latencyMs: 200, ok: true, status: 200 },
        sessionsList: { ...sample.sessionsList, error: null, latencyMs: 200, ok: true },
      };
      const healthyFast = {
        controlUi: { ...healthySlow.controlUi, latencyMs: 10 },
        readyz: { ...healthySlow.readyz, degraded: true, latencyMs: 10 },
        sessionsList: { ...healthySlow.sessionsList, latencyMs: 10 },
      };
      const healthySettled = {
        ...healthyFast,
        readyz: { ...healthyFast.readyz, degraded: false },
      };
      const samples = [sample, healthySlow, healthyFast, healthySettled];
      const warmed = await testing.warmGatewayProbes({
        deadlineAt: performance.now() + 5_000,
        retryDelayMs: 0,
        sample: async () => samples.shift() ?? healthyFast,
        targetMs: 100,
      });
      expect(warmed.samples).toHaveLength(4);
    } finally {
      server.close();
    }
  });

  it("bounds trickled response bodies by the benchmark deadline", async () => {
    const sockets = new Set<Socket>();
    let bodyChunksSent = 0;
    let serverEndedResponse = false;
    const server = createRawServer((socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n ",
        );
        bodyChunksSent += 1;
        const interval = setInterval(() => {
          socket.write(" ");
          bodyChunksSent += 1;
        }, 10);
        const endTimer = setTimeout(() => {
          serverEndedResponse = true;
          socket.end();
        }, 500);
        socket.once("close", () => {
          clearInterval(interval);
          clearTimeout(endTimer);
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected raw HTTP test server address");
    }

    const startedAt = performance.now();
    try {
      await expect(
        testing.requestHttp({
          accept: "application/json",
          deadlineAt: startedAt + 150,
          path: "/readyz",
          port: address.port,
        }),
      ).rejects.toThrow("/readyz request timed out");
      expect(bodyChunksSent).toBeGreaterThan(1);
      expect(serverEndedResponse).toBe(false);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("reuses one connection for sequential successful HTTP samples", async () => {
    let connectionCount = 0;
    const server = createHttpServer((request, response) => {
      response.setHeader(
        "content-type",
        request.url === "/readyz" ? "application/json" : "text/html",
      );
      response.end(request.url === "/readyz" ? '{"status":"ok"}' : "<html></html>");
    });
    server.on("connection", () => {
      connectionCount += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected HTTP test server address");
      }
      const deadlineAt = performance.now() + 5_000;

      await testing.requestHttp({
        accept: "application/json",
        deadlineAt,
        path: "/readyz",
        port: address.port,
      });
      await testing.requestHttp({
        accept: "text/html",
        deadlineAt,
        path: "/",
        port: address.port,
      });

      expect(connectionCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.skipIf(process.platform !== "linux").each([
    ["protocol", "gateway/protocol/index.js"],
    ["mock", "ENOENT"],
    ["missing-taskset", "ENOENT"],
    ["non-executable-taskset", "EACCES"],
    ["gateway-exit", "gateway did not become ready"],
    ["live-gateway-exit", "gateway did not become ready"],
  ])("cleans up the real sample after %s startup failure", async (fault, expectedError) => {
    await withTempDir("gateway-startup-failure-", async (dir) => {
      const runtime = `${dir}/runtime`;
      const bin = `${dir}/bin`;
      const entry = `${dir}/entry.mjs`;
      const recordPath = `${dir}/mock.json`;
      const preload = `${dir}/capture-spawn.mjs`;
      const liveFailure = fault === "live-gateway-exit";
      const output = `${dir}/result.json`;
      const configProofPath = `${dir}/emitted-config.json`;
      await mkdir(`${dir}/gateway/protocol`, { recursive: true });
      await mkdir(runtime);
      await mkdir(bin);
      if (fault !== "protocol") {
        await writeFile(`${dir}/gateway/protocol/index.js`, "exports.PROTOCOL_VERSION = 3;\n");
      }
      await writeFile(
        entry,
        `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(configProofPath)}, readFileSync(process.env.OPENCLAW_CONFIG_PATH));
${liveFailure ? "console.error(process.env.OPENAI_API_KEY);" : ""}process.exit(23);\n`,
      );
      if (fault === "non-executable-taskset") {
        await writeFile(`${bin}/taskset`, "not executable\n", { mode: 0o600 });
      }
      // Keep real OS children and Node's error/exitCode ordering. Only the mock
      // sibling failure substitutes a missing executable at the spawn boundary.
      await writeFile(
        preload,
        `import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const mock = args[0] === "scripts/e2e/mock-openai-server.mjs";
  const child = spawn(mock && ${JSON.stringify(fault === "mock")} ? ${JSON.stringify(`${bin}/missing-node`)} : command, args, options);
  if (mock) writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ pid: child.pid ?? null }));
  return child;
};
syncBuiltinESMExports();\n`,
      );
      let mockPid: number | null = null;
      const mockAlive = () => {
        if (mockPid === null) {
          return false;
        }
        try {
          process.kill(-mockPid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
          }
          throw error;
        }
      };
      try {
        const result = spawnSync(
          testNodeExecPath,
          [
            "--import",
            preload,
            "scripts/bench-gateway-concurrency.ts",
            "--entry",
            entry,
            "--concurrency",
            "1",
            "--runs",
            "1",
            "--warmup",
            "0",
            "--output",
            output,
            "--json",
            ...(liveFailure ? ["--provider", "openai"] : []),
            ...(fault.includes("taskset") ? ["--gateway-cpus", "0"] : []),
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PATH: bin,
              TMPDIR: runtime,
              TMP: runtime,
              TEMP: runtime,
              ...(liveFailure ? { OPENAI_API_KEY: "synthetic-live-startup-secret" } : {}),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        if (liveFailure || fault === "protocol") {
          await expect(readFile(recordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          mockPid = (JSON.parse(await readFile(recordPath, "utf8")) as { pid: number | null }).pid;
        }
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(expectedError);
        if (liveFailure) {
          const sidecar = await readFile(`${output}.failure.json`, "utf8");
          expect(JSON.parse(sidecar)).toMatchObject({
            mode: "live-openai-agent",
            status: "failed",
            liveProof: { requestedTurns: 1, turns: [] },
          });
          expect(sidecar).not.toContain("synthetic-live-startup-secret");
        }
        const written = await readFile(output, "utf8");
        const report = JSON.parse(written);
        expect(JSON.parse(result.stdout)).toEqual(report);
        expect(report).toMatchObject({
          mode: liveFailure ? "live-openai-agent" : "mock-streaming-agent",
          runs: [],
          warmupRuns: [],
          failedAttempt: {
            status: "failure",
            phase: "measured",
            index: 1,
            cleanup: { rootRemoved: true },
            errors: expect.arrayContaining([
              { phase: "workload", error: expect.stringContaining(expectedError) },
            ]),
          },
        });
        if (liveFailure) {
          expect(report.failedAttempt.partialRun.liveProof).toMatchObject({
            requestedTurns: 1,
            turns: [],
          });
          expect(`${written}${result.stdout}${result.stderr}`).not.toContain(
            "synthetic-live-startup-secret",
          );
        }
        if (fault === "protocol") {
          expect(report.failedAttempt.partialRun).toMatchObject({
            readyz: [],
            sessionsList: [],
            freshConnection: null,
            cpuUsage: null,
            memory: { before: null, after: null, peakRssMb: null },
            probeWarmup: { durationMs: null, samples: [] },
          });
          expect(report.failedAttempt.partialRun.gatewayProcess?.pid).toBeUndefined();
          expect(report.failedAttempt.mockProviderProcess?.pid).toBeUndefined();
        }
        if (fault === "gateway-exit" || liveFailure) {
          const config = JSON.parse(await readFile(configProofPath, "utf8"));
          expect(config.plugins.entries["memory-core"]).toEqual({
            config: { dreaming: { enabled: false } },
          });
          expect(config.agents.defaults.maxConcurrent).toBe(1);
          expect(config.agents.defaults.heartbeat).toEqual({ every: "0m" });
          if (liveFailure) {
            expect(config.agents.list.map((agent: { id: string }) => agent.id)).toEqual(["main"]);
            expect(config.models.providers.openai.apiKey).toEqual({
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            });
            expect(config.models.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
            expect(config.agents.defaults.model.primary).toBe(LIVE_GATEWAY_MODEL);
            expect(config.agents.defaults.utilityModel).toBe(LIVE_GATEWAY_MODEL);
            expect(config.agents.defaults.thinkingDefault).toBe("off");
            expect(config.agents.defaults.models[LIVE_GATEWAY_MODEL].params.maxTokens).toBe(128);
            expect(config.tools).toEqual({ deny: ["*"] });
          } else {
            expect(config.models.providers.openai.baseUrl).toMatch(
              /^http:\/\/127\.0\.0\.1:\d+\/v1$/u,
            );
            expect(config.agents.defaults.model.primary).toBe("openai/gpt-5.6-luna");
          }
        }
        expect(result.stderr).not.toContain("Unhandled 'error' event");
        expect(result.stderr.trim().split("\n").at(-1)).toBe(
          "[bench-gateway-concurrency] FAILED (exit 1)",
        );
        expect(mockAlive()).toBe(false);
        expect(await readdir(runtime)).toEqual([]);
      } finally {
        // The failing baseline may leave its own detached mock behind.
        if (mockAlive()) {
          process.kill(-mockPid!, "SIGKILL");
          await vi.waitFor(() => expect(mockAlive()).toBe(false));
        }
      }
    });
  });

  it("loads through native Node TypeScript stripping", () => {
    const result = spawnSync(testNodeExecPath, ["scripts/bench-gateway-concurrency.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway concurrency benchmark");
  });

  it("ends CLI failures with the required wrapper marker", () => {
    const result = spawnSync(testNodeExecPath, ["scripts/bench-gateway-concurrency.ts", "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-gateway-concurrency] FAILED (exit 1)",
    );
  });
});
