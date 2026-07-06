// Tests root logger formatting and file output behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { theme } from "../packages/terminal-core/src/theme.js";
import { isVerbose, isYes, logVerbose, setVerbose, setYes } from "./globals.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "./infra/diagnostic-events.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import {
  resetLogger,
  setLoggerOverride,
  stripRedundantSubsystemPrefixForConsole,
} from "./logging.js";
import type { RuntimeEnv } from "./runtime.js";
import { withTempDir, withTempDirSync } from "./test-helpers/temp-dir.js";

describe("logger helpers", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride(null);
    setVerbose(false);
    setYes(false);
  });

  it("formats messages through runtime log/error", () => {
    const log = vi.fn();
    const error = vi.fn();
    const runtime: RuntimeEnv = { log, error, exit: vi.fn() };

    logInfo("info", runtime);
    logWarn("warn", runtime);
    logSuccess("ok", runtime);
    logError("bad", runtime);

    expect(log).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("emits root helper semantics only to diagnostic log records", async () => {
    await withTempDir({ prefix: "openclaw-log-test-" }, async (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "log.record") {
          received.push(event);
        }
      });
      const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      try {
        setLoggerOverride({ level: "debug", file: logPath });
        logInfo("root info", runtime);
        logWarn("root warn", runtime);
        logSuccess("root success", runtime);
        logError("root error", runtime);
        logDebug("root debug");
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(received.map((event) => event.event)).toEqual([
        "cli.output.info",
        "cli.output",
        "cli.output",
        "cli.output",
        "cli.debug",
      ]);
      expect(received.map((event) => event.category)).toEqual([
        "cli.output",
        "cli.output",
        "cli.output",
        "cli.output",
        "cli",
      ]);
      expect(received.map((event) => event.outcome)).toEqual([
        "success",
        "warning",
        "success",
        "failure",
        "success",
      ]);
      expect(received.map((event) => event.reason)).toEqual([
        "operator_output",
        "operator_output",
        "operator_output",
        "operator_output",
        "debug",
      ]);

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("root info");
      expect(content).toContain("root debug");
      expect(content).not.toContain("__openclawDiagnosticLogSemantics");
      expect(content).not.toContain("operator_output");
      expect(content).not.toContain("cli.output.info");
    });
  });

  it("preserves root helper semantics when subsystem prefixes route through subsystem logs", async () => {
    await withTempDir({ prefix: "openclaw-log-test-" }, async (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "log.record") {
          received.push(event);
        }
      });

      try {
        setLoggerOverride({ level: "debug", file: logPath });
        logInfo("exec: command output");
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        event: "cli.output.info",
        category: "cli.output",
        outcome: "success",
        reason: "operator_output",
      });
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("command output");
      expect(content).not.toContain("__openclawDiagnosticLogSemantics");
      expect(content).not.toContain("operator_output");
    });
  });

  it("only logs debug when verbose is enabled", () => {
    const logVerboseLocal = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logDebug("quiet");
    expect(logVerboseLocal).not.toHaveBeenCalled();

    setVerbose(true);
    logVerboseLocal.mockClear();
    logDebug("loud");
    expect(logVerboseLocal).toHaveBeenCalled();
    logVerboseLocal.mockRestore();
  });

  it("writes to configured log file at configured level", () => {
    withTempDirSync({ prefix: "openclaw-log-test-" }, (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      setLoggerOverride({ level: "info", file: logPath });
      fs.writeFileSync(logPath, "");
      logInfo("hello");
      logDebug("debug-only"); // may be filtered depending on level mapping
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  it("filters messages below configured level", () => {
    withTempDirSync({ prefix: "openclaw-log-test-" }, (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      setLoggerOverride({ level: "warn", file: logPath });
      logInfo("info-only");
      logWarn("warn-only");
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("warn-only");
    });
  });

  it("uses daily rolling log files and prunes old ones", () => {
    withTempDirSync({ prefix: "openclaw-log-test-" }, (dir) => {
      resetLogger();
      const today = localDateString(new Date());
      const todayPath = path.join(dir, `openclaw-${today}.log`);
      setLoggerOverride({ level: "info", file: todayPath });

      // create an old file to be pruned
      const oldPath = path.join(dir, "openclaw-2000-01-01.log");
      fs.writeFileSync(oldPath, "old");
      fs.utimesSync(oldPath, new Date(0), new Date(0));

      logInfo("roll-me");

      expect(fs.existsSync(todayPath)).toBe(true);
      expect(fs.readFileSync(todayPath, "utf-8")).toContain("roll-me");
      expect(fs.existsSync(oldPath)).toBe(false);
    });
  });
});

describe("globals", () => {
  afterEach(() => {
    setVerbose(false);
    setYes(false);
    vi.restoreAllMocks();
  });

  it("toggles verbose flag and logs when enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logVerbose("hidden");
    expect(logSpy).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose("shown");
    expect(isVerbose()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(theme.muted("shown"));
  });

  it("stores yes flag", () => {
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });
});

describe("stripRedundantSubsystemPrefixForConsole", () => {
  it.each([
    { input: "discord: hello", subsystem: "discord", expected: "hello" },
    { input: "WhatsApp: hello", subsystem: "whatsapp", expected: "hello" },
    { input: "discord gateway: closed", subsystem: "discord", expected: "gateway: closed" },
    {
      input: "[discord] connection stalled",
      subsystem: "discord",
      expected: "connection stalled",
    },
  ] as const)("drops known subsystem prefix for $input", ({ input, subsystem, expected }) => {
    expect(stripRedundantSubsystemPrefixForConsole(input, subsystem)).toBe(expected);
  });

  it("keeps messages that do not start with the subsystem", () => {
    expect(stripRedundantSubsystemPrefixForConsole("discordant: hello", "discord")).toBe(
      "discordant: hello",
    );
  });
});

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
