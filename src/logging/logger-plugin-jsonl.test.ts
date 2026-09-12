import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { startPluginServices } from "../plugins/services.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { getDefaultRedactPatterns } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

const paths = createSuiteLogPathTracker("openclaw-plugin-jsonl-");
const token = "synthetic-credential-123456";
const message = `--token "${token}"`;
const headers = Object.fromEntries(
  [
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "SetCookie",
    "set_cookie",
    "X-Api-Key",
    "X-Auth-Token",
    "X-Goog-Api-Key",
    "Api-Key",
    "apikey",
    "X-Api-Token",
    "X-Access-Token",
    "X-OpenClaw-Token",
    "x-pomerium-jwt-assertion",
  ].map((key) => [key, "opaque-value"]),
);
const maskedHeaders = Object.fromEntries(Object.keys(headers).map((key) => [key, "***"]));
let rawConsole: typeof loggingState.rawConsole;
beforeAll(async () => await paths.setup());
beforeEach(() => {
  rawConsole = loggingState.rawConsole;
});
afterEach(async () => {
  await flushLogger();
  testApi.resetFileLogTransportForTests();
  resetLogger();
  resetSecretRedactionRegistryForTest();
  loggingState.rawConsole = rawConsole;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => await paths.cleanup());

it.each([
  { name: "default", custom: false, patterns: undefined },
  {
    name: "custom-only",
    custom: true,
    patterns: ["CUSTOM_ONLY_[A-Z]+", "synthetic-credential-[0-9]+"],
  },
  {
    name: "extended-defaults",
    custom: true,
    patterns: [...getDefaultRedactPatterns(), "CUSTOM_ONLY_[A-Z]+"],
  },
  { name: "copied-defaults", custom: false, patterns: getDefaultRedactPatterns() },
])(
  "Gateway plugin service logger preserves JSONL, credential headers, and pattern reload ($name)",
  async ({ custom, patterns }) => {
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    const config = { level: "info", file, consoleStyle: "json", consoleLevel: "info" } as const;
    applyLoggingConfig({
      ...config,
      ...(patterns ? { redactPatterns: patterns } : {}),
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("plugins");
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
    const keySecret = "registered-property-name-123456";
    registerSecretValueForRedaction(keySecret);
    let accessorReads = 0;
    const accessor = {
      get toJSON() {
        accessorReads += 1;
        if (accessorReads > 1) {
          throw new Error("toJSON getter read twice");
        }
        return () => ({ message });
      },
    };
    api.registerService({
      id: "jsonl-proof",
      start() {
        api.logger.info(message);
        api.runtime.logging.getChildLogger({ subsystem: "jsonl-proof" }).info(message, {
          nested: [{ message, token: 123456789 }],
          serialized: new (class {
            toJSON() {
              return { message };
            }
          })(),
          boxed: Object.assign(Object(false), { valueOf: () => true }),
          callable: Object.assign(() => undefined, { toJSON: () => message }),
          accessor,
          omitted: Object.fromEntries([["__proto__", () => undefined]]),
          unchanged: 42,
        });
        logger.info("abcd-efgh-ijkl-mnop", {
          token: "opaque-value",
          [keySecret]: true,
          "Proxy-Authorization": "Basic dXNlcjpwYXNz",
          headers,
        });
        api.logger.info("CUSTOM_ONLY_VALUE");
        applyLoggingConfig({ ...config, redactPatterns: ["RELOADED_[A-Z]+"] });
        api.logger.info("CUSTOM_ONLY_VALUE RELOADED_VALUE");
      },
    });
    const services = await startPluginServices({ registry: host.registry, config: {} });
    await services.stop();
    await flushLogger();
    const raw = fs.readFileSync(file, "utf8");
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      "1": '--token "synthe…3456"',
      message: '--token "synthe…3456"',
    });
    expect(records[1][1]).toEqual({
      nested: [{ message: '--token "synthe…3456"', token: "***" }],
      serialized: { message: '--token "synthe…3456"' },
      boxed: false,
      callable: '--token "synthe…3456"',
      accessor: { message: '--token "synthe…3456"' },
      omitted: {},
      unchanged: 42,
    });
    expect(records[2][1]).toMatchObject({
      "Proxy-Authorization": "Basic …YXNz",
      headers: maskedHeaders,
    });
    expect(accessorReads).toBe(1);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(keySecret);
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(consoleRecords[0].message).toBe('--token "synthe…3456"');
    expect(consoleRecords[1]).toMatchObject({
      token: "***",
      message: "abcd-e…mnop",
      "Proxy-Authorization": "Basic …YXNz",
      headers: maskedHeaders,
    });
    expect(JSON.stringify(consoleRecords)).not.toContain(keySecret);
    expect(consoleRecords[2].message).toBe(custom ? "***" : "CUSTOM_ONLY_VALUE");
    expect(consoleRecords[3].message).toBe("CUSTOM_ONLY_VALUE ***");
    expect(records.at(-1).message).toBe("CUSTOM_ONLY_VALUE ***");
    const tail = await readConfiguredLogTail();
    expect(tail.lines.map((line) => JSON.parse(line))).toEqual(
      records.with(2, {
        ...records[2],
        "1": { ...records[2][1], "Proxy-Authorization": "***" },
      }),
    );
  },
);

it("Gateway plugin service logger overflow marker preserves quoted hostname JSONL", async () => {
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  const file = paths.nextPath();
  applyLoggingConfig({ level: "info", file, consoleLevel: "silent" });
  testApi.setHostnameResolverForTests(() => message);
  testApi.setFileLogQueueMaxRecordsForTests(1);
  const host = createPluginRegistry({
    logger: createSubsystemLogger("plugins"),
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "overflow-proof",
    source: import.meta.url,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  host.registry.plugins.push(record);
  const api = host.createApi(record, { config: {} });
  api.registerService({
    id: "overflow-proof",
    start() {
      api.logger.info("first");
      api.logger.info("second");
    },
  });
  const services = await startPluginServices({ registry: host.registry, config: {} });
  await services.stop();
  await flushLogger();
  const records = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    dropped: 1,
    hostname: '--token "synthe…3456"',
    message: "[openclaw] file log queue overflow; dropped 1 oldest record",
  });
  expect(records[1].message).toBe("second");
});
