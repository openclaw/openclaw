import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { hasConfiguredRedactPatterns, readLoggingConfig } from "./config.js";
import { applyLoggingConfig, resetLogger } from "./logger.js";

let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-logging-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

function readConfig(configPath: string, env: Record<string, string | undefined> = {}) {
  return withEnv({ OPENCLAW_CONFIG_PATH: configPath, ...env }, readLoggingConfig);
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

  it("reads logging config directly from the active config path", () => {
    const configPath = writeConfig(`{
      logging: {
        level: "debug",
        file: "/tmp/openclaw-custom.log",
        maxFileBytes: 1234,
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toStrictEqual({
        level: "debug",
        file: "/tmp/openclaw-custom.log",
        maxFileBytes: 1234,
      });
    });
  });

  it("resolves nested includes and environment substitutions for logging style", () => {
    const configPath = writeConfig(`{ logging: { $include: "./logging.json5" } }`);
    fs.writeFileSync(
      path.join(path.dirname(configPath), "logging.json5"),
      `{ consoleStyle: "\${OPENCLAW_TEST_CONSOLE_STYLE}", file: "\${MISSING_LOG_FILE}" }`,
    );

    withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_CONSOLE_STYLE: "json",
        MISSING_LOG_FILE: undefined,
      },
      () => {
        expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json" });
      },
    );
  });

  it("preserves direct logging style when unrelated config resolution fails", () => {
    const configPath = writeConfig(`{
      logging: { consoleStyle: "json", file: "\${MISSING_LOG_FILE}" },
      plugins: { $include: "./missing-plugins.json5" },
      models: { providers: { demo: { apiKey: "\${MISSING_DEMO_KEY}" } } },
    }`);

    withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        MISSING_DEMO_KEY: undefined,
        MISSING_LOG_FILE: undefined,
      },
      () => {
        expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json" });
      },
    );
  });

  it("resolves root-included logging when an unrelated sibling include fails", () => {
    const configPath = writeConfig(`{
      $include: "./base.json5",
      plugins: { $include: "./missing-plugins.json5" },
    }`);
    fs.writeFileSync(
      path.join(path.dirname(configPath), "base.json5"),
      `{ logging: { consoleStyle: "json", file: "\${MISSING_LOG_FILE}" } }`,
    );

    withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        MISSING_LOG_FILE: undefined,
      },
      () => {
        expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json" });
      },
    );
  });

  it("does not cache a partial style while environment-backed fields are unresolved", () => {
    const configPath = writeConfig(`{
      logging: { consoleStyle: "json", file: "\${OPENCLAW_TEST_LOG_FILE}", level: "debug" },
    }`);
    expect(readConfig(configPath, { OPENCLAW_TEST_LOG_FILE: undefined })).toStrictEqual({
      consoleStyle: "json",
    });
    expect(
      readConfig(configPath, { OPENCLAW_TEST_LOG_FILE: "/tmp/openclaw-env-backed.log" }),
    ).toStrictEqual({ consoleStyle: "json", file: "/tmp/openclaw-env-backed.log", level: "debug" });
  });

  it("preserves custom redaction patterns while another logging field is unresolved", () => {
    const configPath = writeConfig(`{ logging: {
      consoleStyle: "json", redactPatterns: ["/custom-only-secret/g"], file: "\${MISSING_LOG_FILE}",
    } }`);
    expect(readConfig(configPath, { MISSING_LOG_FILE: undefined })).toStrictEqual({
      consoleStyle: "json",
      redactPatterns: ["/custom-only-secret/g"],
    });
  });

  it("reports whether configured redaction patterns replace the default string rules", () => {
    // The same reader as the redactor, so the applied runtime snapshot answers; an empty list
    // keeps the default string rules.
    applyLoggingConfig({ redactPatterns: ["/custom-only-secret/g"] });
    expect(hasConfiguredRedactPatterns()).toBe(true);
    applyLoggingConfig({ redactPatterns: [] });
    expect(hasConfiguredRedactPatterns()).toBe(false);
  });

  it("returns undefined for missing or malformed config files", () => {
    expect(readConfig(path.join(os.tmpdir(), "openclaw-missing-config.json"))).toBeUndefined();
    expect(readConfig(writeConfig(`{ logging: `))).toBeUndefined();
  });

  it("caches a missing config until the path selector changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-logging-config-missing-"));
    tempDirs.push(dir);
    const firstPath = path.join(dir, "missing-first.json");
    const secondPath = path.join(dir, "missing-second.json");
    const existsSync = vi.spyOn(fs, "existsSync");

    try {
      withEnv({ OPENCLAW_CONFIG_PATH: firstPath }, () => {
        expect(readLoggingConfig()).toBeUndefined();
        expect(readLoggingConfig()).toBeUndefined();
      });
      withEnv({ OPENCLAW_CONFIG_PATH: secondPath }, () => {
        expect(readLoggingConfig()).toBeUndefined();
      });

      const checksFor = (configPath: string) =>
        existsSync.mock.calls.filter(([candidate]) => candidate === configPath).length;
      expect(checksFor(firstPath)).toBe(1);
      expect(checksFor(secondPath)).toBe(1);
    } finally {
      existsSync.mockRestore();
    }
  });
});
