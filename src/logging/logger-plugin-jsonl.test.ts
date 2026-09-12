import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSubsystemLogger, getChildLogger } from "../plugin-sdk/logging-core.js";
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
function registerPlugin(logger: ReturnType<typeof createSubsystemLogger>, id: string) {
  const host = createPluginRegistry({
    logger,
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id,
    source: import.meta.url,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  host.registry.plugins.push(record);
  return { api: host.createApi(record, { config: {} }), registry: host.registry };
}

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

const patternCases = [
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
];

it.each(patternCases)(
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
    const { api, registry } = registerPlugin(logger, "jsonl-proof");
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
    const services = await startPluginServices({ registry, config: {} });
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
  const { api, registry } = registerPlugin(createSubsystemLogger("plugins"), "overflow-proof");
  api.registerService({
    id: "overflow-proof",
    start() {
      api.logger.info("first");
      api.logger.info("second");
    },
  });
  const services = await startPluginServices({ registry, config: {} });
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

it.each(patternCases)(
  "Gateway plugin service masks complete long strings, secret fields, and derived messages ($name)",
  async ({ patterns }) => {
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    applyLoggingConfig({
      level: "info",
      file,
      consoleStyle: "json",
      consoleLevel: "info",
      ...(patterns ? { redactPatterns: patterns } : {}),
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("complete-record");
    const rawLogger = getChildLogger({ subsystem: "complete-record" });
    const { api, registry } = registerPlugin(logger, "complete-record");
    const prefix = `${"x".repeat(16_380)} `;
    const suffix = ` ${"y".repeat(20_000)}`;
    const long = `${prefix}token=${token}${suffix}`;
    const maskedLong = `${prefix}token=synthe…3456${suffix}`;
    const partial = "sk-abcdefghijklmnopqrstuvwxyz0123456789:OPAQUE_REMAINDER";
    let conversions = 0;
    const converted = new (class {
      toJSON() {
        conversions += 1;
        return { token: "OPAQUE_CONVERT_TOKEN", text: message };
      }
    })();
    api.registerService({
      id: "complete-record",
      start() {
        logger.info(long, { scenario: "long", payload: long });
        logger.info("partial fields", {
          scenario: "partial",
          password: partial,
          token: partial,
          Authorization: partial,
          clientSecret: "CUSTOM_ONLY_VALUE OPAQUE_REMAINDER",
          TOKEN: "${TOKEN:-literal-default-secret}",
          session: "$WORKSPACE_DIR/session.jsonl",
        });
        rawLogger.info(undefined, "derived class", converted);
        rawLogger.info(
          new (class {
            toJSON() {
              return { scenario: "first-class", note: "abcd-efgh-ijkl-mnop" };
            }
          })(),
        );
        logger.info("converted console", {
          scenario: "class-console",
          converted: new (class {
            toJSON() {
              return { text: message, token: partial };
            }
          })(),
        });
      },
    });
    const services = await startPluginServices({ registry, config: {} });
    await services.stop();
    await flushLogger();
    const text = fs.readFileSync(file, "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toHaveLength(5);
    expect(consoleRecords).toHaveLength(3);
    expect(records[0][1].payload).toBe(maskedLong);
    expect(records[0][2]).toBe(maskedLong);
    expect(consoleRecords[0]).toMatchObject({ message: maskedLong, payload: maskedLong });
    const maskedFields = {
      password: "sk-abc…NDER",
      token: "sk-abc…NDER",
      Authorization: "sk-abc…NDER",
      clientSecret: "CUSTOM…NDER",
      TOKEN: "${TOKEN:-***}",
      session: "$WORKSPACE_DIR/session.jsonl",
    };
    expect(records[1][1]).toMatchObject(maskedFields);
    expect(consoleRecords[1]).toMatchObject(maskedFields);
    expect(conversions).toBe(1);
    expect(records[2].message).toBe(
      `derived class ${JSON.stringify({ token: "OPAQUE…OKEN", text: '--token "synthe…3456"' })}`,
    );
    expect(records[3].message).toBe('{"scenario":"first-class","note":"abcd-e…mnop"}');
    expect(consoleRecords[2].converted).toEqual({
      text: '--token "synthe…3456"',
      token: "sk-abc…NDER",
    });
    const tail = await readConfiguredLogTail({ maxBytes: 500_000 });
    expect(tail.lines.map((line) => JSON.parse(line))).toHaveLength(5);
    for (const serialized of [text, JSON.stringify(consoleRecords), tail.lines.join("\n")]) {
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("OPAQUE_REMAINDER");
      expect(serialized).not.toContain("OPAQUE_CONVERT_TOKEN");
      expect(serialized).not.toContain("abcd-efgh-ijkl-mnop");
    }
  },
);
