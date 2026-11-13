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
  redactPatterns?: string[],
  write?: (logger: ReturnType<typeof getChildLogger>, file: string) => void,
) {
  const file = paths.nextPath();
  applyLoggingConfig({
    level: "info",
    file,
    consoleStyle: "json",
    consoleLevel: "info",
    redactPatterns,
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
        return write(getChildLogger({ subsystem: record.id }), file);
      }
      if (meta) {
        return logger.info(message, meta);
      }
      api.logger.info(message);
    },
  });
  const services = await startPluginServices({ registry: host.registry, config: {} });
  await services.stop();
  await flushLogger();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return {
    raw: lines.map((line) => JSON.parse(line))[0],
    console: output.mock.calls.map(([line]) => JSON.parse(String(line))),
  };
}

async function expectMetadata(
  result: Awaited<ReturnType<typeof logFromPlugin>>,
  raw: Record<string, unknown>,
  redacted: Record<string, unknown>,
) {
  expect(result.raw["1"]).toEqual(raw);
  expect(result.console[0]).toMatchObject(redacted);
  const tail = await readTail();
  expect(tail.record["1"]).toEqual(redacted);
  return tail;
}

async function readTail(limit?: number) {
  const { lines } = await readConfiguredLogTail({ limit });
  assert(lines[0] !== undefined);
  return { record: JSON.parse(lines[0]), text: lines.join("\n") };
}

it("keeps files raw and redacts console/tail independently", async () => {
  const secret = "sk-syntheticcredential123456";
  const meta = { password: "synthetic-password", count: 3 };
  const result = await logFromPlugin(`request failed token=${secret}`, structuredClone(meta));
  const tail = await expectMetadata(result, meta, { password: "***", count: 3 });
  expect(result.raw.message).toContain(secret);
  expect(JSON.stringify(result.console)).not.toContain(secret);
  expect(tail.text).not.toContain(secret);
});

it.each([
  { value: "private-value", pattern: "^private-value$" },
  { value: 42, pattern: '"value":(42)' },
  { value: true, pattern: '"value":(true)' },
  { value: null, pattern: '"value":(null)' },
])("redacts custom scalar at console/tail: $value", async ({ value, pattern }) => {
  const result = await logFromPlugin("custom rules", { value }, [pattern]);
  await expectMetadata(result, { value }, { value: "***" });
});

it("refreshes registry/custom policies without rewriting files", async () => {
  registerSecretValueForRedaction("987654321");
  const meta = { value: 987654321, nested: [987654321] };
  const result = await logFromPlugin("registry proof", structuredClone(meta));
  await expectMetadata(result, meta, { value: "***", nested: ["***"] });
  const reloaded = await logFromPlugin("reload proof", { value: "reload-private" }, [
    "^reload-private$",
  ]);
  await expectMetadata(reloaded, { value: "reload-private" }, { value: "***" });
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
  expect(result.raw).toMatchObject({ dropped: 1, hostname });
  const tail = await readTail(5_000);
  expect(tail.record.dropped).toBe(1);
  expect(tail.text).not.toContain("synthetic-credential-123456");
});

it("serializes native values once, preserving cycles, bigints and text", async () => {
  const toJSON = vi.fn(() => ({ token: "raw-native-token", count: 7 }));
  const circular: Record<string, unknown> = { count: 9n };
  circular.self = circular;
  const result = await logFromPlugin("native values", undefined, undefined, (logger) => {
    logger.info("native value", { toJSON }, circular, Number.NaN);
  });
  expect(toJSON).toHaveBeenCalledTimes(1);
  expect([result.raw["2"], result.raw["3"], result.raw.message]).toEqual([
    { token: "raw-native-token", count: 7 },
    { count: "9", self: "[Circular]" },
    'native value {"token":"raw-native-token","count":7} {"count":"9","self":"[Circular]"} NaN',
  ]);
  expect((await readTail()).text).not.toContain("raw-native-token");
});

it.each([
  { value: "private-value", pattern: "^private-value$" },
  { value: `private-value${"x".repeat(6000)}`, pattern: "^private-valuex+$" },
])("redacts complete and truncated display copies", async ({ value, pattern }) => {
  const result = await logFromPlugin("display projection", undefined, [pattern], (logger) => {
    logger.info("native value", { value, key: "opaque-key", password: 1234 });
  });
  expect(result.raw.message).toContain("private-value");
  const tail = await readTail();
  expect(tail.text).not.toContain("private-value");
  expect(tail.text).not.toContain("opaque-key");
  expect(tail.record["2"].password).toBe("***");
  expect(tail.record.message).not.toContain("1234");
});
