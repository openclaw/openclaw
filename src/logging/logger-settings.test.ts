// Logger settings tests cover file-backed logger settings behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let logging: typeof import("../logging.js");
let loggingConfig: typeof import("./config.js");
let applyLoggingConfig: typeof import("./logger.js").applyLoggingConfig;

beforeAll(async () => {
  // Bind the observer and both settings consumers to the same module generation.
  vi.resetModules();
  loggingConfig = await import("./config.js");
  ({ applyLoggingConfig } = await import("./logger.js"));
  logging = await import("../logging.js");
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", undefined);
  vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  logging.resetLogger();
  logging.setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("getResolvedLoggerSettings", () => {
  it.each(["true", "false"])(
    "keeps cold and reloaded default loggers off synchronous fs (Vitest=%s)",
    (vitest) => {
      vi.stubEnv("VITEST", vitest);
      applyLoggingConfig(undefined);
      const calls: Record<string, number> = {};
      const restore: Array<() => void> = [];
      try {
        for (const name of Object.keys(fs).filter((key) => key.endsWith("Sync"))) {
          const descriptor = Object.getOwnPropertyDescriptor(fs, name)!;
          if (typeof descriptor.value !== "function") {
            continue;
          }
          Object.defineProperty(fs, name, {
            ...descriptor,
            value: new Proxy(descriptor.value, {
              apply(fn, receiver, args) {
                calls[name] = (calls[name] ?? 0) + 1;
                return Reflect.apply(fn, receiver, args);
              },
            }),
          });
          restore.push(() => Object.defineProperty(fs, name, descriptor));
        }
        const native = Object.getOwnPropertyDescriptor(fs.realpathSync, "native")!;
        Object.defineProperty(fs.realpathSync, "native", {
          ...native,
          value: new Proxy(native.value, {
            apply(fn, receiver, args) {
              calls["realpathSync.native"] = (calls["realpathSync.native"] ?? 0) + 1;
              return Reflect.apply(fn, receiver, args);
            },
          }),
        });
        restore.push(() => Object.defineProperty(fs.realpathSync, "native", native));
        logging.getChildLogger({ subsystem: "session-sqlite" });
        applyLoggingConfig(undefined);
        logging.getChildLogger({ subsystem: "session-sqlite" });
      } finally {
        restore.toReversed().forEach((undo) => undo());
      }
      expect(calls).toEqual({});
    },
  );

  it("uses a silent fast path in default Vitest mode without config reads", async () => {
    const readLoggingConfig = vi.spyOn(loggingConfig, "readLoggingConfig");

    const settings = await logging.getResolvedLoggerSettings();

    expect(settings.level).toBe("silent");
    expect(readLoggingConfig).not.toHaveBeenCalled();
  });

  it("reads logging config when test file logging is explicitly enabled", async () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    const readLoggingConfig = vi.spyOn(loggingConfig, "readLoggingConfig");
    applyLoggingConfig({
      level: "debug",
      file: "/tmp/openclaw-configured.log",
      maxFileBytes: 2048,
    });

    const settings = await logging.getResolvedLoggerSettings();

    expect(readLoggingConfig).toHaveBeenCalledOnce();
    expect(settings.level).toBe("debug");
    expect(settings.file).toBe("/tmp/openclaw-configured.log");
    expect(settings.maxFileBytes).toBe(2048);
  });

  it("uses defaults when no logging config is available", async () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    applyLoggingConfig(undefined);

    const settings = await logging.getResolvedLoggerSettings();

    expect(settings.level).toBe("info");
    expect(settings.file).toContain(path.join(".artifacts", "test-logs"));
    expect(path.basename(settings.file)).toMatch(/^openclaw-vitest-\d+-\d{4}-\d{2}-\d{2}\.log$/);
    expect(settings.file).not.toBe(
      `/tmp/openclaw/openclaw-${new Date().toISOString().slice(0, 10)}.log`,
    );
  });
});
