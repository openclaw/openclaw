import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./runtime.js";
import { isVerbose, isYes, logVerbose, setVerbose, setYes } from "./globals.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import {
  DEFAULT_LOG_DIR,
  resetLogger,
  setLoggerOverride,
  stripRedundantSubsystemPrefixForConsole,
} from "./logging.js";

describe("logger helpers", () => {
  afterEach(() => {
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

  it("only logs debug when verbose is enabled", () => {
    const logVerbose = vi.spyOn(console, "log");
    setVerbose(false);
    logDebug("quiet");
    expect(logVerbose).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose.mockClear();
    logDebug("loud");
    expect(logVerbose).toHaveBeenCalled();
    logVerbose.mockRestore();
  });

  it("writes to configured log file at configured level", () => {
    const logPath = pathForTest();
    cleanup(logPath);
    setLoggerOverride({ level: "info", file: logPath });
    fs.writeFileSync(logPath, "");
    logInfo("hello");
    logDebug("debug-only"); // may be filtered depending on level mapping
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    cleanup(logPath);
  });

  it("filters messages below configured level", () => {
    const logPath = pathForTest();
    cleanup(logPath);
    setLoggerOverride({ level: "warn", file: logPath });
    logInfo("info-only");
    logWarn("warn-only");
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("warn-only");
    cleanup(logPath);
  });

  it("uses daily rolling default log file and prunes old ones", () => {
    resetLogger();
    setLoggerOverride({ level: "info" }); // force default file path with enabled file logging
    const today = localDateString(new Date());
    const todayPath = path.join(DEFAULT_LOG_DIR, `openclaw-${today}.log`);

    // create an old file to be pruned
    const oldPath = path.join(DEFAULT_LOG_DIR, "openclaw-2000-01-01.log");
    fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
    fs.writeFileSync(oldPath, "old");
    fs.utimesSync(oldPath, new Date(0), new Date(0));
    cleanup(todayPath);

    logInfo("roll-me");

    expect(fs.existsSync(todayPath)).toBe(true);
    expect(fs.readFileSync(todayPath, "utf-8")).toContain("roll-me");
    expect(fs.existsSync(oldPath)).toBe(false);

    cleanup(todayPath);
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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("shown"));
  });

  it("stores yes flag", () => {
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });
});

describe("stripRedundantSubsystemPrefixForConsole", () => {
  it("drops '<subsystem>:' prefix", () => {
    expect(stripRedundantSubsystemPrefixForConsole("discord: hello", "discord")).toBe("hello");
  });

  it("drops '<Subsystem>:' prefix case-insensitively", () => {
    expect(stripRedundantSubsystemPrefixForConsole("WhatsApp: hello", "whatsapp")).toBe("hello");
  });

  it("drops '<subsystem> ' prefix", () => {
    expect(stripRedundantSubsystemPrefixForConsole("discord gateway: closed", "discord")).toBe(
      "gateway: closed",
    );
  });

  it("drops '[subsystem]' prefix", () => {
    expect(stripRedundantSubsystemPrefixForConsole("[discord] connection stalled", "discord")).toBe(
      "connection stalled",
    );
  });

  it("keeps messages that do not start with the subsystem", () => {
    expect(stripRedundantSubsystemPrefixForConsole("discordant: hello", "discord")).toBe(
      "discordant: hello",
    );
  });
});

function pathForTest() {
  const file = path.join(os.tmpdir(), `openclaw-log-${crypto.randomUUID()}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function cleanup(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
