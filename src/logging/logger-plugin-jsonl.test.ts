import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, assert, expect, it, vi } from "vitest";
import { createSubsystemLogger, getChildLogger } from "../plugin-sdk/logging-core.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { startPluginServices } from "../plugins/services.test-support.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { fileLogTransport } from "./logger-file-transport.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "./logger.js";
import type { RedactPattern } from "./redact-pattern-runtime.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";
import { loggingState } from "./state.js";

const paths = createSuiteLogPathTracker("openclaw-plugin-jsonl-");
let rawConsole: typeof loggingState.rawConsole;
beforeAll(async () => await paths.setup());
beforeEach(() => {
  rawConsole = loggingState.rawConsole;
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
});
afterEach(async () => {
  await flushLogger();
  resetLogger();
  resetSecretRedactionRegistryForTest();
  loggingState.rawConsole = rawConsole;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => await paths.cleanup());

async function logFromPlugin(
  message: string,
  meta?: Record<string, unknown>,
  patterns?: readonly RedactPattern[],
  write?: (logger: ReturnType<typeof getChildLogger>, file: string) => void,
) {
  const file = paths.nextPath();
  applyLoggingConfig({
    level: "info",
    file,
    consoleStyle: "json",
    consoleLevel: "info",
    // Logging config carries pattern text only; the default policy's matchers are not configurable.
    redactPatterns: patterns?.filter((pattern): pattern is string => typeof pattern === "string"),
  });
  const output = vi.fn();
  loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
  const logger = createSubsystemLogger("jsonl-proof");
  const host = createPluginRegistry({
    logger,
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "jsonl-proof",
    source: import.meta.url,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  host.registry.plugins.push(record);
  const api = host.createApi(record, { config: {} });
  api.registerService({
    id: record.id,
    start() {
      if (write) {
        write(getChildLogger({ subsystem: record.id }), file);
      } else if (meta) {
        logger.info(message, meta);
      } else {
        api.logger.info(message);
      }
    },
  });
  const services = await startPluginServices({ registry: host.registry, config: {} });
  await services.stop();
  await flushLogger();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return {
    lines,
    records: lines.map((line) => JSON.parse(line)),
    console: output.mock.calls.map(([line]) => JSON.parse(String(line))),
  };
}

it("keeps plugin file records raw while console and tail redact independently", async () => {
  const secret = "sk-syntheticcredential123456";
  const result = await logFromPlugin(`request failed token=${secret}`, {
    password: "synthetic-password",
    count: 3,
  });
  expect(result.records[0]["1"]).toEqual({ password: "synthetic-password", count: 3 });
  expect(result.records[0].message).toContain(secret);
  expect(result.console[0]).toMatchObject({ password: "***", count: 3 });
  expect(JSON.stringify(result.console)).not.toContain(secret);
  const tail = await readConfiguredLogTail();
  assert(tail.lines[0] !== undefined);
  expect(JSON.parse(tail.lines[0])["1"]).toEqual({ password: "***", count: 3 });
  expect(tail.lines.join("\n")).not.toContain(secret);
});

it.each([
  { value: "private-value", pattern: "^private-value$" },
  { value: 42, pattern: '"value":(42)' },
  { value: true, pattern: '"value":(true)' },
  { value: null, pattern: '"value":(null)' },
])("applies custom scalar rules at console and tail egress: $value", async ({ value, pattern }) => {
  const result = await logFromPlugin("custom rules", { value }, [pattern]);
  expect(result.records[0]["1"].value).toBe(value);
  expect(result.console[0].value).toBe("***");
  const tail = await readConfiguredLogTail();
  assert(tail.lines[0] !== undefined);
  expect(JSON.parse(tail.lines[0])["1"].value).toBe("***");
});

it("refreshes exact-secret and custom egress policies without rewriting raw files", async () => {
  registerSecretValueForRedaction("987654321");
  const result = await logFromPlugin("registry proof", { value: 987654321, nested: [987654321] });
  expect(result.records[0]["1"]).toEqual({ value: 987654321, nested: [987654321] });
  expect(result.console[0]).toMatchObject({ value: "***", nested: ["***"] });
  const initialTail = await readConfiguredLogTail();
  assert(initialTail.lines[0] !== undefined);
  expect(JSON.parse(initialTail.lines[0])["1"]).toEqual({
    value: "***",
    nested: ["***"],
  });
  const reloaded = await logFromPlugin("reload proof", { value: "reload-private" }, [
    "^reload-private$",
  ]);
  expect(reloaded.records[0]["1"].value).toBe("reload-private");
  expect(reloaded.console[0].value).toBe("***");
  const reloadedTail = await readConfiguredLogTail();
  assert(reloadedTail.lines[0] !== undefined);
  expect(JSON.parse(reloadedTail.lines[0])["1"].value).toBe("***");
});

it("writes valid raw overflow metadata and masks it when tailed", async () => {
  const hostname = '--token "synthetic-credential-123456"';
  vi.spyOn(os, "hostname").mockReturnValue(hostname);
  const result = await logFromPlugin("overflow", undefined, undefined, (logger, file) => {
    logger.info("first");
    for (let index = 0; index < 4_095; index += 1) {
      fileLogTransport.enqueue({ file, hostname, maxFileBytes: 1024 * 1024, payload: "{}\n" });
    }
    logger.info("second");
  });
  expect(result.records[0].dropped).toBe(1);
  expect(result.records[0].hostname).toBe(hostname);
  const tail = await readConfiguredLogTail({ limit: 5_000 });
  assert(tail.lines[0] !== undefined);
  expect(JSON.parse(tail.lines[0]).dropped).toBe(1);
  expect(tail.lines.join("\n")).not.toContain("synthetic-credential-123456");
});

it("materializes native values once and retains cycles, bigints, and diagnostic text", async () => {
  let conversions = 0;
  const receiver = {
    toJSON() {
      conversions++;
      return { token: "raw-native-token", count: 7 };
    },
  };
  const circular: Record<string, unknown> = { count: 9n };
  circular.self = circular;
  const result = await logFromPlugin("native values", undefined, undefined, (logger) => {
    logger.info("native value", receiver, circular, Number.NaN);
  });
  expect(conversions).toBe(1);
  expect(result.records[0]["2"]).toEqual({ token: "raw-native-token", count: 7 });
  expect(result.records[0]["3"]).toEqual({ count: "9", self: "[Circular]" });
  expect(result.records[0].message).toBe(
    'native value {"token":"raw-native-token","count":7} {"count":"9","self":"[Circular]"} NaN',
  );
  expect((await readConfiguredLogTail()).lines.join("\n")).not.toContain("raw-native-token");
});

it.each([
  { value: "private-value", pattern: "^private-value$" },
  { value: `private-value${"x".repeat(6000)}`, pattern: "^private-valuex+$" },
])(
  "redacts scalar-protected copies in complete and truncated display messages",
  async ({ value, pattern }) => {
    const result = await logFromPlugin("display projection", undefined, [pattern], (logger) => {
      logger.info("native value", { value, key: "opaque-key", password: 1234 });
    });
    expect(result.records[0].message).toContain("private-value");
    const tail = await readConfiguredLogTail();
    expect(tail.lines.join("\n")).not.toContain("private-value");
    expect(tail.lines.join("\n")).not.toContain("opaque-key");
    assert(tail.lines[0] !== undefined);
    const record = JSON.parse(tail.lines[0]);
    expect(record["2"].password).toBe("***");
    expect(record.message).not.toContain("1234");
  },
);
