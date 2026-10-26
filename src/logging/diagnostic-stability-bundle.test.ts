import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { runFatalErrorHooks } from "../infra/fatal-error-hooks.js";
import {
  installDiagnosticStabilityFatalHook,
  MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES,
  readDiagnosticStabilityBundleFileSync,
  readLatestDiagnosticStabilityBundleSync,
  uninstallDiagnosticStabilityFatalHook,
  writeDiagnosticStabilityBundleForFailureSync,
  type DiagnosticStabilityBundle,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";

describe("diagnostic stability bundles", () => {
  let tempDir: string;

  function resetStabilityBundleTestState(): void {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    uninstallDiagnosticStabilityFatalHook();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stability-bundle-"));
    resetStabilityBundleTestState();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetStabilityBundleTestState();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBundle(
    reason: string,
    error?: unknown,
    options: Parameters<typeof writeDiagnosticStabilityBundleForFailureSync>[2] = {},
  ) {
    const result = writeDiagnosticStabilityBundleForFailureSync(reason, error, {
      stateDir: tempDir,
      ...options,
    });
    expect(result.status).toBe("written");
    if (result.status !== "written") {
      throw new Error("Expected written stability bundle");
    }
    return result;
  }

  function readBundle(file: string): DiagnosticStabilityBundle {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DiagnosticStabilityBundle;
  }

  function readSanitizedBundle(file: string) {
    const result = readDiagnosticStabilityBundleFileSync(file);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("Expected readable stability bundle");
    }
    return result.bundle;
  }

  function createImportedBundle(): Record<string, unknown> {
    return {
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "gateway.restart_startup_failed",
      process: {
        pid: 123,
        platform: "darwin",
        arch: "arm64",
        node: "24.14.1",
        uptimeMs: 1000,
      },
      host: { hostname: "<redacted-hostname>" },
      snapshot: {
        generatedAt: "2026-04-22T12:00:00.000Z",
        capacity: 1000,
        count: 1,
        dropped: 0,
        events: [{ seq: 1, ts: 1, type: "webhook.received" }],
        summary: { byType: { "webhook.received": 1 } },
      },
    };
  }

  it("writes redacted failure stacks even when the recorder snapshot is empty", () => {
    const secret = "sk-1234567890abcdef";
    const error = Object.assign(
      new Error("raw startup config payload at google/web-search-contract-api.js"),
      {
        code: "ERR_CONFIG_PARSE",
        stack: `Error: OPENAI_API_KEY=${secret}\n    at finishPosixAuthority (relay-host.js:12:3)`,
      },
    );
    const result = writeBundle("gateway.restart_startup_failed", error, {
      now: new Date("2026-04-22T12:00:00.000Z"),
    });

    const bundle = readBundle(result.path);
    const raw = fs.readFileSync(result.path, "utf8");
    expect(bundle.reason).toBe("gateway.restart_startup_failed");
    expect(bundle.error).toEqual({
      name: "Error",
      code: "ERR_CONFIG_PARSE",
      message: "raw startup config payload at google/web-search-contract-api.js",
      stack: expect.stringContaining("\n    at finishPosixAuthority (relay-host.js:12:3)"),
    });
    expect(bundle.snapshot.count).toBe(0);
    expect(bundle.snapshot.events).toEqual([]);
    expect(raw).not.toContain(secret);
    const readback = readDiagnosticStabilityBundleFileSync(result.path);
    expect(readback.status).toBe("found");
    if (readback.status === "found") {
      expect(readback.bundle.error?.stack).toContain(
        "\n    at finishPosixAuthority (relay-host.js:12:3)",
      );
      expect(readback.bundle.error?.stack).not.toContain(secret);
    }
  });

  it("keeps bounded failure messages and stacks UTF-16 safe", () => {
    const prefix = "a".repeat(499);
    const stackPrefix = "a".repeat(7_999);
    const result = writeBundle(
      "gateway.restart_startup_failed",
      Object.assign(new Error(`${prefix}😀${"b".repeat(500)}`), {
        stack: `${stackPrefix}😀${"b".repeat(1_000)}`,
      }),
      {},
    );

    expect(readBundle(result.path).error?.message).toBe(`${prefix}...`);
    expect(readBundle(result.path).error).toHaveProperty("stack", stackPrefix);
  });

  it("preserves redacted shutdown causes and stacks through bundle readback", () => {
    const secret = "sk-1234567890abcdef";
    const cause = new TypeError(`fixture close failed: OPENAI_API_KEY=${secret}`);
    cause.stack = `${cause.name}: ${cause.message}\n    at closeOwner (fixture.js:12:3)`;
    const stepError = new Error("shutdown step failed (gateway lifetime sidecars)", { cause });
    const error = new AggregateError([stepError], "Gateway shutdown did not complete cleanly");
    const result = writeBundle("gateway.restart_close_failed", error, {
      shutdownStep: "gateway-server-close",
    });
    const readback = readSanitizedBundle(result.path);
    expect(readback.evidence?.shutdown).toMatchObject({
      step: "gateway-server-close",
      errors: [
        { name: "AggregateError", message: "Gateway shutdown did not complete cleanly" },
        { name: "Error", message: "shutdown step failed (gateway lifetime sidecars)" },
        {
          name: "TypeError",
          message: expect.stringContaining("fixture close failed"),
          stack: expect.stringContaining("at closeOwner (fixture.js:12:3)"),
        },
      ],
    });
    expect(fs.readFileSync(result.path, "utf8")).not.toContain(secret);
    expect(JSON.stringify(readback)).not.toContain(secret);
  });

  it("bounds cyclic shutdown error graphs and stack text without losing non-Error throws", () => {
    const error = new AggregateError(
      Array.from({ length: 100 }, (_, index) => new Error(`failure ${index}`)),
      "shutdown failures",
    );
    error.cause = error;
    error.stack = "a".repeat(7_999) + "😀" + "b".repeat(1_000);
    const result = writeBundle("gateway.stop_close_failed", error, {
      shutdownStep: "gateway-server-close",
    });
    expect(readBundle(result.path).evidence?.shutdown?.errors.length).toBeLessThanOrEqual(32);
    expect(readBundle(result.path).evidence?.shutdown?.errors[0]?.stack).toBe("a".repeat(7_999));
    const nonError = writeBundle("gateway.stop_close_failed", "fixture string failure", {
      shutdownStep: "startup-operations",
    });
    expect(readBundle(nonError.path).evidence?.shutdown).toEqual({
      step: "startup-operations",
      errors: [{ message: "fixture string failure" }],
    });
  });

  it("registers a fatal hook only while installed", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    installDiagnosticStabilityFatalHook({ stateDir: tempDir });

    const messages = runFatalErrorHooks({
      reason: "fatal_unhandled_rejection",
      error: Object.assign(new Error("raw text"), { code: "ERR_OUT_OF_MEMORY" }),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("wrote stability bundle:");
    expect(messages[0]).toContain(tempDir);

    uninstallDiagnosticStabilityFatalHook();
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toStrictEqual([]);

    try {
      const reinstalledDir = path.join(tempDir, "reinstalled");
      installDiagnosticStabilityFatalHook({ stateDir: reinstalledDir });
      installDiagnosticStabilityFatalHook({ stateDir: tempDir });
      const reinstalledMessages = runFatalErrorHooks({ reason: "uncaught_exception" });
      expect(reinstalledMessages).toHaveLength(1);
      expect(reinstalledMessages[0]).toContain("wrote stability bundle:");
      expect(reinstalledMessages[0]).toContain(reinstalledDir);

      uninstallDiagnosticStabilityFatalHook();
      expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
      uninstallDiagnosticStabilityFatalHook();
      expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
    } finally {
      uninstallDiagnosticStabilityFatalHook();
    }
  });

  it("retains only the newest bundle files", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    for (let index = 0; index < 22; index += 1) {
      writeBundle("gateway.restart_respawn_failed", undefined, {
        now: new Date(Date.UTC(2026, 3, 22, 12, 0, index)),
      });
    }

    const bundleDir = path.join(tempDir, "logs", "stability");
    const files = fs.readdirSync(bundleDir).toSorted();
    expect(files).toHaveLength(20);
    expect(files[0]).toContain("12-00-02");
    expect(files[19]).toContain("12-00-21");
    const latest = readLatestDiagnosticStabilityBundleSync({ stateDir: tempDir });
    expect(latest.status).toBe("found");
    expect(latest.status === "found" ? path.basename(latest.path) : "").toBe(files[19]);
    expect(latest.status === "found" ? latest.bundle.reason : "").toBe(
      "gateway.restart_respawn_failed",
    );
  });

  it("keeps the published bundle within retention despite future mtimes", () => {
    for (let index = 0; index < 20; index++) {
      const older = writeBundle("gateway.startup_failed", undefined, {
        now: new Date(Date.UTC(2026, 3, 22, 12, 0, index)),
      });
      const future = new Date(Date.UTC(2036, 3, 22, 12, 0, index));
      fs.utimesSync(older.path, future, future);
    }

    const current = writeBundle("gateway.restart_respawn_failed", undefined, {
      now: new Date("2026-04-22T12:01:00.000Z"),
    });
    expect(current.message).toContain(current.path);
    expect(fs.existsSync(current.path)).toBe(true);
    expect(readDiagnosticStabilityBundleFileSync(current.path).status).toBe("found");
    expect(fs.readdirSync(path.dirname(current.path))).toHaveLength(20);
  });

  it("preserves OS and worker memory attribution and unavailable samples in exported bundles", () => {
    startDiagnosticStabilityRecorder();
    const pressure = {
      type: "diagnostic.memory.pressure",
      level: "critical",
      reason: "worker_heap_threshold",
      usedBytes: 1024,
      limitBytes: 1100,
      thresholdBytes: 990,
      workerThreadId: 2,
      memory: {
        rssBytes: 4096,
        anonymousRssBytes: 3072,
        anonymousSwapBytes: 0,
        heapSizeLimitBytes: 4096,
        oldGenerationAfterGcBytes: 256,
        heapTotalBytes: 1024,
        heapUsedBytes: 512,
        externalBytes: 32,
        arrayBuffersBytes: 16,
        workerMemoryScope: "direct",
        workerMemoryCoverage: "partial",
        workerHeaps: [
          {
            script: "prepared-model-catalog.worker.js",
            threadId: 2,
            heapUsed: 1024,
            heapSizeLimitBytes: 1100,
            heapTotal: 2048,
            sampleAgeMs: 20,
            retainedData: [
              {
                structure: "catalog-source",
                entries: 100,
                approximateBytes: 512,
                truncated: true,
              },
            ],
          },
        ],
        workerMemoryMissing: [
          { script: "/private/secret-worker.js", threadId: 3, reason: "stale" },
        ],
      },
    } satisfies Parameters<typeof emitDiagnosticEvent>[0];
    const expectedMemory = structuredClone(pressure.memory);
    emitDiagnosticEvent(pressure);
    const written = writeBundle("uncaught_exception");
    const readback = readSanitizedBundle(written.path);
    expect(readback.snapshot.events[0]).toMatchObject({
      type: "diagnostic.memory.pressure",
      level: "critical",
      reason: "worker_heap_threshold",
      usedBytes: 1024,
      limitBytes: 1100,
      thresholdBytes: 990,
      workerThreadId: 2,
    });
    expect(readback.snapshot.events[0]?.memory).toMatchObject({
      ...expectedMemory,
      workerMemoryMissing: [{ script: "other", threadId: 3, reason: "stale" }],
    });
    expect(JSON.stringify(readback)).not.toContain("secret-worker");
  });

  it("sanitizes imported bundles before returning them", () => {
    const file = path.join(tempDir, "imported.json");
    const bundle = createImportedBundle();
    const safeRetained = {
      structure: "catalog-config",
      entries: 1,
      approximateBytes: 256,
      stringBytes: 128,
      objects: 2,
      providers: 2,
      accounts: 3,
      truncated: false,
    };
    const runtimeEvidence = {
      heapStatistics: {
        heapSizeLimitBytes: 8192,
        usedHeapSizeBytes: 1536,
        totalHeapSizeBytes: 1536.75,
      },
      heapSpaces: [
        {
          spaceName: "old_space",
          spaceSizeBytes: 2048,
          spaceUsedBytes: 1536,
          spaceAvailableBytes: 512,
          physicalSpaceSizeBytes: 2048,
        },
      ],
      cgroup: {
        version: "v2",
        values: { current: 4096, max: "max" },
        events: { high: 2, "events.local.oom": 1 },
      },
      activeResources: { total: 3, byType: { Timeout: 2, PipeWrap: 1 } },
    };
    const safeEvents = [
      { seq: 1, ts: 1, type: "webhook.error", channel: "telegram" },
      {
        seq: 2,
        ts: 2,
        type: "exec.approval.followup_suppressed",
        approvalId: "approval-imported-123",
        reason: "session_rebound",
        phase: "gateway_preflight",
      },
      { seq: 3, ts: 3, type: "model.usage", durationMs: 0, costUsd: 0, usage: {}, context: {} },
      {
        seq: 4,
        ts: 4,
        type: "model.call.error",
        failureKind: "aborted",
        durationMs: 130,
        providerProcessingMs: 20.25,
        providerWaitEstimateMs: 109.75,
      },
    ];
    const byType = Object.fromEntries(safeEvents.map((event) => [event.type, 1]));
    Object.assign(bundle, {
      reason: "private reason token=secret",
      privateTopLevel: "top-level-secret",
      process: {
        ...(bundle.process as Record<string, unknown>),
        command: "process-command-secret",
      },
      host: { hostname: "private-hostname", fqdn: "host-extra-secret" },
      error: {
        name: "private error name",
        code: "ERR_TEST",
        message: "OPENAI_API_KEY=sk-1234567890abcdef",
      },
      evidence: {
        memoryPressure: {
          ...runtimeEvidence,
          level: "critical",
          reason: "rss_threshold",
          thresholdBytes: 0,
          rssGrowthBytes: -1,
          windowMs: 0.5,
          memory: {
            rssBytes: 4096,
            heapTotalBytes: 2048,
            heapUsedBytes: 1536,
            externalBytes: 128,
            arrayBuffersBytes: 64,
            workerHeaps: [
              {
                script: "prepared-model-catalog.worker.js",
                heapUsed: 512,
                heapTotal: 1024,
                retainedData: [
                  {
                    ...safeRetained,
                    credentials: "catalog-credential-secret",
                    modelKeys: ["private-model-key"],
                  },
                  { structure: "private-provider-name", entries: 1, approximateBytes: 100 },
                ],
              },
            ],
          },
          topSessionFiles: [
            {
              relativePath: "agents/main/sessions/raw-secret-session.jsonl",
              sizeBytes: 4096,
              mtimeMs: 1,
            },
          ],
        },
      },
      snapshot: {
        ...(bundle.snapshot as Record<string, unknown>),
        count: 4,
        privateSnapshot: "snapshot-secret",
        events: [
          {
            ...safeEvents[0],
            reason: "private event reason",
            chatId: "chat-id-secret",
            error: "event-error-secret",
          },
          { ...safeEvents[1], command: "raw command secret" },
          safeEvents[2],
          safeEvents[3],
        ],
        summary: {
          byType: { ...byType, "private summary type": 1 },
          privateSummary: "summary-secret",
        },
      },
    });
    fs.writeFileSync(file, JSON.stringify(bundle), "utf8");
    const result = readSanitizedBundle(file);
    const sanitized = result;
    expect(sanitized.reason).toBe("unknown");
    expect(sanitized.host).toEqual({ hostname: "<redacted-hostname>" });
    expect(sanitized.error).toMatchObject({
      code: "ERR_TEST",
      message: expect.stringContaining("OPENAI_API_KEY="),
    });
    expect(sanitized.error).not.toHaveProperty("stack");
    expect(sanitized.evidence?.memoryPressure).toMatchObject({
      ...runtimeEvidence,
      heapStatistics: { ...runtimeEvidence.heapStatistics, totalHeapSizeBytes: 1536 },
      thresholdBytes: 0,
      rssGrowthBytes: -1,
      windowMs: 0.5,
      topSessionFiles: [{ relativePath: "agents/<agent>/sessions/<session>.jsonl" }],
      memory: { workerHeaps: [{ retainedData: [safeRetained] }] },
    });
    expect(sanitized.evidence?.memoryPressure?.memory?.workerHeaps?.[0]?.retainedData).toEqual([
      safeRetained,
    ]);
    expect(sanitized.snapshot.events).toEqual(safeEvents);
    expect(sanitized.snapshot.summary.byType).toEqual(byType);
    for (const secret of [
      "catalog-credential-secret",
      "private-model-key",
      "private-provider-name",
      "private reason",
      "top-level-secret",
      "private error name",
      "sk-1234567890abcdef",
      "process-command-secret",
      "private-hostname",
      "host-extra-secret",
      "snapshot-secret",
      "private event reason",
      "raw-secret-session",
      "chat-id-secret",
      "event-error-secret",
      "raw command secret",
      "private summary type",
      "summary-secret",
    ]) {
      expect(JSON.stringify(sanitized)).not.toContain(secret);
    }
  });

  it("rejects malformed bundle files", () => {
    const file = path.join(tempDir, "invalid.json");
    fs.writeFileSync(file, "{}\n", "utf8");

    const result = readDiagnosticStabilityBundleFileSync(file);

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? String(result.error) : "").toContain(
      "Unsupported stability bundle version",
    );
  });

  it.each([
    ["legacy", {}, true],
    [
      "safe",
      { openclawVersion: "2026.4.22-beta.1+fixture", buildId: "b".repeat(96), commit: "abcdef0" },
      true,
    ],
    [
      "unsafe",
      { openclawVersion: "version\nsecret", buildId: "/private/build", commit: "not-a-commit" },
      false,
    ],
    [
      "overlong",
      { openclawVersion: "v".repeat(257), buildId: "b".repeat(97), commit: "a".repeat(41) },
      false,
    ],
  ] as const)("preserves only recorded safe build identity: %s", (_name, identity, accepted) => {
    const file = path.join(tempDir, "imported.json");
    const bundle = createImportedBundle();
    const originalProcess = bundle.process as Record<string, unknown>;
    bundle.process = { ...originalProcess, ...identity };
    fs.writeFileSync(file, JSON.stringify(bundle), "utf8");

    const result = readSanitizedBundle(file);
    expect(result.process).toEqual({ ...originalProcess, ...(accepted ? identity : {}) });
  });

  it("rejects oversized bundle files before reading them", () => {
    const file = path.join(tempDir, "oversized.json");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES + 1);

    const result = readDiagnosticStabilityBundleFileSync(file);

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? String(result.error) : "").toContain(
      "Stability bundle is too large",
    );
  });

  it("rejects malformed bundle snapshots before returning them", () => {
    const baseBundle = createImportedBundle();
    const cases = [
      {
        name: "malformed-event",
        snapshot: { events: [{ type: "webhook.received", ts: 1 }] },
        error: "snapshot.events[0].seq",
      },
      {
        name: "out-of-range-event-timestamp",
        snapshot: { events: [{ seq: 1, ts: 9e15, type: "webhook.received" }] },
        error: "snapshot.events[0].ts",
      },
      { name: "null-summary", snapshot: { summary: null }, error: "snapshot.summary" },
      {
        name: "optional-code-before-number",
        snapshot: {
          events: [{ seq: 1, ts: 1, type: "model.usage", channel: null, durationMs: null }],
        },
        error: "snapshot.events[0].channel",
      },
      {
        name: "optional-usage-before-context",
        snapshot: {
          events: [{ seq: 1, ts: 1, type: "model.usage", usage: { input: null }, context: false }],
        },
        error: "snapshot.events[0].usage.input",
      },
      {
        name: "heap-statistics-before-required-memory",
        evidence: {
          memoryPressure: {
            level: "critical",
            reason: "rss_threshold",
            heapStatistics: { totalHeapSizeBytes: null },
            memory: null,
          },
        },
        error: "evidence.memoryPressure.heapStatistics.totalHeapSizeBytes",
      },
    ];

    for (const testCase of cases) {
      const file = path.join(tempDir, `${testCase.name}.json`);
      const bundle = {
        ...baseBundle,
        snapshot: { ...(baseBundle.snapshot as Record<string, unknown>), ...testCase.snapshot },
        ...(testCase.evidence ? { evidence: testCase.evidence } : {}),
      };
      fs.writeFileSync(file, JSON.stringify(bundle), "utf8");

      const result = readDiagnosticStabilityBundleFileSync(file);

      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? String(result.error) : "").toContain(testCase.error);
    }
  });
});
