import fs from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { sanitizeSupportLogRecord } from "../logging/diagnostic-support-log-redaction.js";
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi as loggerTest } from "../logging/logger.test-support.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { withPluginRetentionOwner } from "../plugins/plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createPluginReloadCleanup,
  PluginAdmittedWorkTimeoutError,
} from "./server-plugin-reload-cleanup.js";

const logPaths = createSuiteLogPathTracker("plugin-reload-retention-");
beforeAll(() => logPaths.setup());
afterAll(() => logPaths.cleanup());
afterEach(async () => {
  vi.useRealTimers();
  await loggerTest.flushFileLogQueueForTests();
  resetLogger();
  resetDiagnosticEventsForTest();
  loggingState.rawConsole = null;
});

it.each(["release", "timeout"] as const)(
  "logs acquisition owners through %s without releasing work, with redaction at egress",
  async (outcome) => {
    vi.useFakeTimers();
    const registry = createEmptyPluginRegistry();
    const pluginRecord = createPluginRecord({ id: "fixture", status: "loaded" });
    registry.plugins.push(pluginRecord);
    const instance = new PluginInstance(pluginRecord.id, { record: pluginRecord, registry });
    const acquisitionOwner = {
      sessionKey: "private-session",
      runId: "private-run",
      serviceId: "private-service",
      agentId: "sk-syntheticcredential1234567890",
    };
    const release = withPluginRetentionOwner(acquisitionOwner, () =>
      instance.retainWork("prepared-generation-lease"),
    );
    const referenceId = instance.retentionSnapshot().references[0]!.referenceId;
    const file = logPaths.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "warn", consoleStyle: "compact", file });
    const diagnostic = createDiagnosticLogRecordCapture();
    const warn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const signal = new AbortController().signal;
    const cleanup = createPluginReloadCleanup({
      previousRegistry: registry,
      changedPluginIds: new Set([pluginRecord.id]),
      port: 0,
      pluginWorkspaceDir: undefined,
      getCron: () => {
        throw new Error("cron must not be called by observation");
      },
      abortSignal: signal,
      log: createSubsystemLogger("test/retention"),
      recordCleanup: vi.fn(),
      recordWarning: vi.fn(),
      retainRetirement: vi.fn(),
    });
    const status = vi.fn();
    const observation = cleanup.drainRetainedWork(new Set([pluginRecord.id]), signal, status, {
      includeConsumers: true,
      includeCalls: true,
    });
    const observed = observation.catch((error: unknown) => error);
    expect(instance.retainedWorkCount).toBe(1);
    expect(instance.disposing).toBe(false);
    if (outcome === "timeout") {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await observed).toBeInstanceOf(PluginAdmittedWorkTimeoutError);
      expect(instance.retainedWorkCount).toBe(1);
      expect(instance.acceptingCalls).toBe(true);
      expect(instance.retentionSnapshot().references[0]!.referenceId).toBe(referenceId);
    }
    release();
    if (outcome === "release") {
      await expect(observation).resolves.toBeUndefined();
    }
    await observed;
    expect(instance.retentionSnapshot().total).toBe(0);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await loggerTest.flushFileLogQueueForTests();
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes("Plugin retained references"));
    expect(lines).toHaveLength(outcome === "timeout" ? 2 : 1);
    for (const line of lines) {
      const record = JSON.parse(line);
      expect(record).toMatchObject({
        "1": {
          instances: [{ references: [{ referenceId, owner: acquisitionOwner }] }],
        },
      });
      expect(record.message).toContain("a turn awaiting its own retained work cannot drain");
      const support = JSON.stringify(sanitizeSupportLogRecord(line, { env: {}, stateDir: "" }));
      expect(support).not.toMatch(
        /private-session|private-run|private-service|syntheticcredential/,
      );
    }
    const tail = (await readConfiguredLogTail()).lines.join("\n");
    expect(tail).toContain("private-run");
    expect(tail).toContain("private-service");
    expect(tail).not.toContain(acquisitionOwner.agentId);
    await diagnostic.flush();
    expect(
      diagnostic.records.filter((record) => record.message.includes("Plugin retained references")),
    ).toHaveLength(lines.length);
    expect(JSON.stringify(diagnostic.records)).not.toContain(acquisitionOwner.agentId);
    if (outcome === "timeout") {
      expect(warn).toHaveBeenCalledOnce();
      const consoleLine = String(warn.mock.calls[0]![0]);
      expect(consoleLine).toContain(referenceId);
      expect(consoleLine).toContain("private-run");
      expect(consoleLine).toContain("private-service");
      expect(consoleLine).not.toContain(acquisitionOwner.agentId);
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  },
);
