import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOG_DIR,
  getLogger,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
  type LoggerSettings,
} from "./logger.js";

function expectedRollingFileFor(dir: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return path.join(dir, `openclaw-${year}-${month}-${day}.log`);
}

function mockLoggerFileSystem() {
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "readdirSync").mockReturnValue([]);
  return vi.spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  setLoggerOverride(null);
  resetLogger();
});

describe("logger directory resolution", () => {
  it("writes to DEFAULT_LOG_DIR when dir is not specified", () => {
    const appendSpy = mockLoggerFileSystem();
    setLoggerOverride({ level: "info" });

    const resolved = getResolvedLoggerSettings();
    getLogger().info("default-dir");

    expect(resolved.file).toBe(expectedRollingFileFor(DEFAULT_LOG_DIR));
    expect(appendSpy).toHaveBeenCalled();
    expect(appendSpy.mock.calls[0]?.[0]).toBe(expectedRollingFileFor(DEFAULT_LOG_DIR));
  });

  it("writes to configured directory when dir is specified", () => {
    const customDir = path.join(process.cwd(), ".tmp-logger-test");
    const appendSpy = mockLoggerFileSystem();
    const settings: LoggerSettings = { level: "info", dir: customDir };
    setLoggerOverride(settings);

    const resolved = getResolvedLoggerSettings();
    getLogger().info("custom-dir");

    expect(resolved.file).toBe(expectedRollingFileFor(customDir));
    expect(appendSpy).toHaveBeenCalled();
    expect(appendSpy.mock.calls[0]?.[0]).toBe(expectedRollingFileFor(customDir));
  });
});
