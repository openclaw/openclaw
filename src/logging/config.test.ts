// Logging config tests cover config file loading and defaults.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { readLoggingConfig } from "./config.js";
import { applyLoggingConfig, resetLogger } from "./logger.js";

let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-logging-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

describe("readLoggingConfig", () => {
  afterEach(() => {
    resetLogger();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
    tempDirs = [];
  });

  it("returns the applied runtime snapshot without bootstrap filesystem work", () => {
    const existsSync = vi.spyOn(fs, "existsSync");
    applyLoggingConfig({ level: "debug", consoleStyle: "json" });

    expect(readLoggingConfig()).toEqual({ level: "debug", consoleStyle: "json" });
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("does not cache a partial style while environment-backed fields are unresolved", () => {
    const configPath = writeConfig(`{
      logging: {
        consoleStyle: "json",
        file: "\${OPENCLAW_TEST_LOG_FILE}",
        level: "debug",
      },
    }`);

    withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_LOG_FILE: undefined,
      },
      () => {
        expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json" });
      },
    );

    withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_LOG_FILE: "/tmp/openclaw-env-backed.log",
      },
      () => {
        expect(readLoggingConfig()).toStrictEqual({
          consoleStyle: "json",
          file: "/tmp/openclaw-env-backed.log",
          level: "debug",
        });
      },
    );
  });

  it("preserves custom redaction patterns while another logging field is unresolved", () => {
    const configPath = writeConfig(`{
      logging: {
        consoleStyle: "json",
        redactPatterns: ["/custom-only-secret/g"],
        file: "\${MISSING_LOG_FILE}",
      },
    }`);

    withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        MISSING_LOG_FILE: undefined,
      },
      () => {
        expect(readLoggingConfig()).toStrictEqual({
          consoleStyle: "json",
          redactPatterns: ["/custom-only-secret/g"],
        });
      },
    );
  });

  it("returns undefined for missing or malformed config files", () => {
    withEnv(
      { OPENCLAW_CONFIG_PATH: path.join(os.tmpdir(), "openclaw-missing-config.json") },
      () => {
        expect(readLoggingConfig()).toBeUndefined();
      },
    );

    const configPath = writeConfig(`{ logging: `);
    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toBeUndefined();
    });
  });
});
