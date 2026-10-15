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

  // The canonical read is not schema-validated, so an entry here can be any JSON. A non-string
  // pattern used to reach the redaction matcher loop, where every redacted write then throws.
  it("drops redaction patterns it cannot use and keeps the operator's valid rules", () => {
    const configPath = writeConfig(`{
      logging: {
        consoleStyle: "json",
        redactPatterns: ["customer-secret-[0-9]+", 1],
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toStrictEqual({
        consoleStyle: "json",
        redactPatterns: ["customer-secret-[0-9]+"],
      });
    });
  });

  // A non-list value is not a pattern list; the resolver would otherwise iterate a string's
  // characters as patterns.
  it("drops a redaction pattern value that is not a list", () => {
    const configPath = writeConfig(`{
      logging: {
        consoleStyle: "json",
        redactPatterns: "customer-secret-[0-9]+",
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json" });
    });
  });

  // A blank source compiles to nothing, so it cannot stand in for the default policy.
  it("drops blank redaction pattern sources", () => {
    const configPath = writeConfig(`{
      logging: {
        consoleStyle: "json",
        redactPatterns: ["", 1],
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json", redactPatterns: [] });
    });
  });

  // Applied snapshots can come from a read-only scan that published a config which failed
  // validation, so the producer normalizes them too.
  it("normalizes an applied snapshot that carries unusable patterns", () => {
    applyLoggingConfig({ level: "debug", redactPatterns: [1] } as never);

    expect(readLoggingConfig()).toStrictEqual({ level: "debug", redactPatterns: [] });
  });

  // An unusable list must not become a policy; an empty one falls back to the built-in patterns.
  it("empties a redaction pattern list with no usable entries", () => {
    const configPath = writeConfig(`{
      logging: {
        consoleStyle: "json",
        redactPatterns: [1],
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toStrictEqual({ consoleStyle: "json", redactPatterns: [] });
    });
  });

  it("keeps a redaction pattern list of strings", () => {
    const configPath = writeConfig(`{
      logging: {
        redactPatterns: ["custom-secret-[0-9]+"],
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(readLoggingConfig()).toStrictEqual({ redactPatterns: ["custom-secret-[0-9]+"] });
    });
  });
});
