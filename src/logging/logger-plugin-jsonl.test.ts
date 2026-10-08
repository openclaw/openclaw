import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSubsystemLogger, getChildLogger } from "../plugin-sdk/logging-core.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { startPluginServices } from "../plugins/services.test-support.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import type { RedactPattern } from "./redact-pattern-runtime.js";
import { getDefaultRedactPatterns } from "./redact.js";
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
  testApi.resetFileLogTransportForTests();
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
  write?: (logger: ReturnType<typeof getChildLogger>) => void,
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
        write(getChildLogger({ subsystem: record.id }));
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

it.each([
  { message: '--token "synthetic-credential-123456"', expected: "--token ***", tail: true },
  { message: "abcd-efgh-ijkl-mnop", expected: "abcd-efgh-ijkl-mnop", consoleOnly: true },
  ...[":", "="].map((separator) => ({
    message: `x-pomerium-jwt-assertion${separator} opaque7\nfollowing-diagnostic-line`,
    contains: `x-pomerium-jwt-assertion${separator} ***`,
    absent: "opaque",
  })),
])("registered plugin logger preserves redacted JSON messages: $message", async (row) => {
  const result = await logFromPlugin(row.message);
  expect(result.records).toHaveLength(1);
  expect(result.console).toHaveLength(1);
  const records = "consoleOnly" in row ? result.console : [...result.records, ...result.console];
  for (const record of records) {
    if ("expected" in row) {
      expect(record.message).toBe(row.expected);
    } else {
      expect(record.message).toContain(row.contains);
      expect(record.message).not.toContain(row.absent);
    }
  }
  if ("tail" in row) {
    expect((await readConfiguredLogTail()).lines).toEqual(result.lines);
  }
});

type ScalarCase = {
  name: string;
  value: unknown;
  patterns: readonly RedactPattern[];
  expected?: string;
  absent?: string;
  registered?: string;
  message?: string;
  expectedMessage?: string;
};
const firstSecret = "FIRST_PRIVATE_VALUE_1234567890";
const secondSecret = "SECOND_PRIVATE_VALUE";
const hintValue = `${firstSecret} ${secondSecret}`;
const hintResult = "FIRST_…7890 SECOND…ALUE";
it.each<ScalarCase>([
  ...[
    { name: "anchored", patterns: ["^private-value$"], value: "private-value", expected: "***" },
    {
      name: "contextual",
      patterns: ['"value":"(private-value)"'],
      value: "private-value",
      expected: "***",
    },
    { name: "numeric", patterns: ['"value":(42)'], value: 42, expected: "***" },
    { name: "boolean", patterns: ['"value":(true)'], value: true, expected: "***" },
    { name: "null", patterns: ['"value":(null)'], value: null, expected: "***" },
  ].map((row) =>
    Object.assign(row, { patterns: [...getDefaultRedactPatterns(), ...row.patterns] }),
  ),
  {
    name: "ordered hints",
    value: hintValue,
    patterns: [...getDefaultRedactPatterns(), firstSecret, "/FIRST_…7890 (SECOND_PRIVATE_VALUE)/g"],
    expected: hintResult,
    message: `HUNT hints ${hintValue}`,
    expectedMessage: `HUNT hints ${hintResult}`,
  },
  {
    name: "encoded hints",
    value: "AA\nBCDEFGHIJKLMNOPQRSTUVWXYZ1234 SECOND_PRIVATE_VALUE",
    patterns: [
      String.raw`/"value":"(AA\\nBCDEFGHIJKLMNOPQRSTUVWXYZ1234)/g`,
      String.raw`/AA\\nBC…1234 (SECOND_PRIVATE_VALUE)/g`,
    ],
    expected: "AA\nBC…1234 SECOND…ALUE",
  },
  {
    name: "registered hints",
    value: hintValue,
    registered: firstSecret,
    patterns: ["/FIRST_…7890 (SECOND_PRIVATE_VALUE)/g"],
    expected: hintResult,
  },
  {
    name: "URL hints",
    value: `https://example.invalid/?token=${hintValue}`,
    patterns: ["/token=FIRST_…7890 (SECOND_PRIVATE_VALUE)/g"],
    absent: secondSecret,
  },
  {
    name: "zero-width rule",
    value: hintValue,
    patterns: ["/^FIRST_PRIVATE_VALUE_1234567890/g", "/(?<=^FIRST_…7890 )/g"],
    expected: "FIRST_…7890 ***SECOND_PRIVATE_VALUE",
  },
])("registered plugin logger preserves $name masking in file and console scalars", async (row) => {
  if (row.registered) {
    registerSecretValueForRedaction(row.registered);
  }
  const result = await logFromPlugin(row.message ?? row.name, { value: row.value }, row.patterns);
  for (const record of [result.records[0]["1"], result.console[0]]) {
    if (row.expected !== undefined) {
      expect(record.value).toBe(row.expected);
    }
    if (row.absent) {
      expect(record.value).not.toContain(row.absent);
    }
  }
  if (row.expectedMessage) {
    expect(result.records[0].message).toBe(row.expectedMessage);
    expect(result.console[0].message).toBe(row.expectedMessage);
  }
});

it.each([
  {
    name: "explicit rules on preserved references",
    fields: { session: "$WORKSPACE_DIR/private-value.jsonl", TOKEN: "$TOKEN", safe: "$SAFE" },
    patterns: [...getDefaultRedactPatterns(), "private-value", String.raw`\$TOKEN`],
    expected: { session: "$WORKSPACE_DIR/***.jsonl", TOKEN: "***", safe: "$SAFE" },
  },
  {
    name: "default credentials and benign fields",
    fields: {
      "x-pomerium-jwt-assertion": "opaque-value",
      bare: "zQ7mL2rV9aN4cT6xH8pS1dF3kJ5uW0yB7eG2nR9i",
      ordinary: "worker finished normally",
    },
    patterns: undefined,
    expected: {
      "x-pomerium-jwt-assertion": "***",
      bare: "zQ7mL2…nR9i",
      ordinary: "worker finished normally",
    },
    absent: "opaque-value",
  },
])("registered plugin logger preserves $name", async (row) => {
  const result = await logFromPlugin(row.name, row.fields, row.patterns);
  expect(result.records).toHaveLength(1);
  expect(result.console).toHaveLength(1);
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record).toMatchObject(row.expected);
  }
  if (row.absent) {
    expect(JSON.stringify(result.records)).not.toContain(row.absent);
    expect(JSON.stringify(result.console)).not.toContain(row.absent);
  }
});

it("registered plugin service logger masks registered numeric secrets and reloads policy", async () => {
  registerSecretValueForRedaction("987654321");
  const result = await logFromPlugin("registry proof", { value: 987654321, nested: [987654321] });
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record).toMatchObject({ value: "***", nested: ["***"] });
  }
  const reloaded = await logFromPlugin("reload proof", { value: "reload-private" }, [
    "^reload-private$",
  ]);
  expect(reloaded.records[0]["1"].value).toBe("***");
  expect(reloaded.console[0].value).toBe("***");
});

it("registered plugin logger keeps built-in file protection with custom-only rules", async () => {
  const result = await logFromPlugin(
    "sk-syntheticcredential123456 CUSTOM_ONLY_VALUE",
    { "Proxy-Authorization": "Digest username=OPAQUE_USER, response=OPAQUE_RESPONSE" },
    ["CUSTOM_ONLY_[A-Z]+"],
  );
  expect(result.records[0].message).not.toContain("sk-syntheticcredential123456");
  expect(result.records[0].message).not.toContain("CUSTOM_ONLY_VALUE");
  expect(result.console[0].message).not.toContain("CUSTOM_ONLY_VALUE");
  expect(result.records[0]["1"]["Proxy-Authorization"]).toContain("***");
  expect(result.console[0]["Proxy-Authorization"]).toContain("***");
  expect(JSON.stringify(result.records)).not.toContain("OPAQUE_RESPONSE");
  expect(JSON.stringify(result.console)).not.toContain("OPAQUE_RESPONSE");
});

it("registered plugin logger produces valid overflow JSON with a quoted hostname", async () => {
  testApi.setFileLogQueueMaxRecordsForTests(1);
  vi.spyOn(os, "hostname").mockReturnValue('--token "synthetic-credential-123456"');
  const result = await logFromPlugin("overflow", undefined, undefined, (logger) => {
    logger.info("first");
    logger.info("second");
  });
  expect(result.records[0].dropped).toBe(1);
  expect(result.records[0].hostname).not.toContain("synthetic-credential-123456");
});

it.each([
  {
    name: "derived ordered",
    fields: { stage: "MASKME", account: 123456, next: "PRIVATE_VALUE", ordinary: "visible" },
    patterns: [
      ...getDefaultRedactPatterns(),
      "MASKME",
      String.raw`/"account":(123456)/g`,
      String.raw`/"account":"\*\*\*","next":"(PRIVATE_[A-Z]+)"/g`,
    ],
    expected: 'derived ordered {"stage":"***","account":"***","next":"***","ordinary":"visible"}',
    absent: "PRIVATE_VALUE",
  },
  {
    name: "class conversion",
    fields: {
      token: "OPAQUE_CONVERT_TOKEN",
      text: '--token "synthetic-credential-123456"',
      after: "still-visible",
    },
    patterns: undefined,
    expected: 'class conversion {"token":"***","text":"--token ***","after":"still-visible"}',
    absent: "synthetic-credential-123456",
  },
  {
    name: "header receiver",
    fields: undefined,
    patterns: undefined,
    expected: 'header receiver {"value":"***"}',
    absent: "opaque-value",
  },
])(
  "registered plugin logger converts $name once and projects masks into its message",
  async (row) => {
    let conversions = 0;
    const receiver = row.fields
      ? new (class {
          toJSON() {
            conversions += 1;
            return row.fields;
          }
        })()
      : {
          value: {
            "x-pomerium-jwt-assertion": "opaque-value",
            toJSON() {
              conversions += 1;
              return this["x-pomerium-jwt-assertion"];
            },
          },
        };
    const result = await logFromPlugin(row.name, undefined, row.patterns, (logger) => {
      logger.info(row.name, receiver);
    });
    expect(conversions).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].message).toBe(row.expected);
    expect(JSON.stringify(result.records)).not.toContain(row.absent);
    if (!row.fields) {
      expect(result.records[0]["2"].value).toBe("***");
    }
  },
);

it.each([
  { key: "Kam_abcdefghij", expected: "K***", registered: undefined, masked: "am_abcdefghij" },
  {
    key: "https://abc def:opaque@host.invalid",
    expected: "https://***:***@host.invalid",
    registered: "abc def",
    masked: "opaque",
  },
])("registered plugin logger preserves serialized property-name masks: $key", async (fixture) => {
  if (fixture.registered) {
    registerSecretValueForRedaction(fixture.registered);
  }
  const result = await logFromPlugin("ordinary record", { [fixture.key]: "benign" });
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record[fixture.expected]).toBe("benign");
    expect(Object.hasOwn(record, fixture.key)).toBe(false);
  }
  expect(JSON.stringify(result.records)).not.toContain(fixture.masked);
  expect(JSON.stringify(result.console)).not.toContain(fixture.masked);
});

it.each([
  {
    name: "unchanged audit fields",
    fields: { kind: "forwarded", host: "example.invalid", substituted: false },
    patterns: [],
    expected: '{"kind":"forwarded","host":"example.invalid","substituted":false}',
  },
  {
    name: "colliding masked property names",
    fields: { keyA: "first", keyB: "last" },
    patterns: ["/key[AB]/g"],
    expected: '{"***":"last"}',
  },
  {
    name: "masked integer property order",
    fields: { "0": "zero", "1": "one", other: "tail" },
    patterns: ['/"(0)":"zero"/g'],
    expected: '{"1":"one","***":"zero","other":"tail"}',
  },
  {
    name: "a masked surrogate half",
    fields: { value: "😀" },
    patterns: [String.raw`/\uDE00/g`],
    expected: String.raw`{"value":"\ud83d***"}`,
  },
])("registered plugin logger preserves canonical file bytes for $name", async (fixture) => {
  const result = await logFromPlugin("canonical proof", fixture.fields, fixture.patterns);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toContain(`"1":${fixture.expected}`);
  expect(result.records[0]["1"]).toEqual(JSON.parse(fixture.expected));
});

it.each([
  { patterns: [], one: "one" },
  { patterns: ['/"1":"(one)","0":"zero"/g'], one: "***" },
])(
  "registered plugin logger preserves canonical metadata-only native values: $patterns",
  async ({ patterns, one }) => {
    let conversions = 0;
    class NativeValue {
      toJSON() {
        conversions += 1;
        return new Proxy({ 0: "zero", 1: "one" }, { ownKeys: () => ["1", "0"] });
      }
    }
    const result = await logFromPlugin("", undefined, patterns, (logger) => {
      logger.info({ value: new NativeValue() });
    });
    expect(conversions).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].message).toBeUndefined();
    expect(result.records[0]["1"].value).toEqual({ 0: "zero", 1: one });
    expect(result.lines[0]).toContain(`"value":{"0":"zero","1":"${one}"}`);
  },
);

it("registered plugin service logger preserves console severity and time during decoded masking", async () => {
  const year = String(new Date().getFullYear());
  const result = await logFromPlugin("HUNT structural", { value: "info" }, ["^info$", `^${year}`]);
  expect(result.console[0]).toMatchObject({ level: "info", value: "***" });
  expect(result.console[0].time).toMatch(new RegExp(`^${year}-`));
});

it.each([
  String.raw`/"hostname":"[^"]+","message":"(PRIVATE_VALUE)"/g`,
  String.raw`/"message":"(PRIVATE_VALUE)","traceId":/g`,
])(
  "registered plugin service logger preserves serialized display order for %s",
  async (pattern) => {
    const result = await logFromPlugin(
      "PRIVATE_VALUE",
      {
        trace: {
          traceId: "1234567890abcdef1234567890abcdef",
          spanId: "1234567890abcdef",
          traceFlags: "01",
        },
      },
      [...getDefaultRedactPatterns(), pattern],
    );
    expect(result.records[0].message).toBe("***");
  },
);

it("registered plugin service logger retains non-finite diagnostic text", async () => {
  const value = Number.NaN;
  const result = await logFromPlugin("native values", undefined, undefined, (logger) => {
    logger.info("HUNT value", value);
    logger.log(3, "INFO", value);
  });
  expect(result.records.map((record) => record.message)).toEqual([
    `HUNT value ${String(value)}`,
    String(value),
  ]);
});

it.each([
  ...[
    {
      fields: { password: "ABCDEFGHIJKLMN1234567890", next: "SECOND_PRIVATE_VALUE" },
      patterns: ['/"password":"ABCDEF…7890","next":"(SECOND_PRIVATE_VALUE)"/g'],
    },
    {
      fields: { password: "FIRST_PRIVATE_VALUE_1234567890", next: "SECOND_PRIVATE_VALUE" },
      patterns: [
        "FIRST_PRIVATE_VALUE_1234567890",
        '/"password":"FIRST_…7890","next":"(SECOND_PRIVATE_VALUE)"/g',
      ],
    },
    {
      fields: { text: "abcd-efgh-ijkl-mnop", next: "SECOND_PRIVATE_VALUE" },
      patterns: ['/"text":"abcd-e…mnop","next":"(SECOND_PRIVATE_VALUE)"/g'],
    },
    {
      fields: {
        alpha: "FIRST_PRIVATE_VALUE_1234567890",
        beta: "OTHER_PRIVATE_VALUE_0987654321",
        next: "SECOND_PRIVATE_VALUE",
      },
      patterns: [
        "FIRST_PRIVATE_VALUE_1234567890",
        "OTHER_PRIVATE_VALUE_0987654321",
        '/"alpha":"FIRST_…7890","beta":"OTHER_…4321","next":"(SECOND_PRIVATE_VALUE)"/g',
      ],
    },
    {
      fields: { publicShare: { id: "ABCDEFGHIJKLMNOPQRSTUVWX" }, next: "SECOND_PRIVATE_VALUE" },
      patterns: ['/"publicShare":\\{"id":"ABCDEF…UVWX"\\},"next":"(SECOND_PRIVATE_VALUE)"/g'],
    },
  ].map((row) =>
    Object.assign(row, {
      exact: false,
      expected: { next: "SECOND…ALUE", ...("password" in row.fields ? { password: "***" } : {}) },
    }),
  ),
  ...["opaque-value", 123456].map((value) => ({
    fields: { "x-pomerium-jwt-assertion": value, next: secondSecret },
    patterns: [
      `/"x-pomerium-jwt-assertion":${JSON.stringify(value)},"next":"(SECOND_PRIVATE_VALUE)"/g`,
    ],
    expected: { "x-pomerium-jwt-assertion": "***", next: "SECOND…ALUE" },
    exact: true,
  })),
  ...[12345678901234567890n, Number.NaN, false].map((value) => ({
    fields: { password: value, next: secondSecret },
    patterns: [String.raw`/"password":"\*\*\*","next":"(SECOND_PRIVATE_VALUE)"/g`],
    expected: { password: "***", next: "SECOND…ALUE" },
    exact: true,
  })),
  ...[123456, false].map((value) => ({
    fields: { publicShare: { id: value }, next: secondSecret },
    patterns: [String.raw`/"publicShare":\{"id":"\*\*\*"\},"next":"(SECOND_PRIVATE_VALUE)"/g`],
    expected: { next: "SECOND…ALUE" },
    exact: false,
  })),
])("registered plugin logger retains field context for ordered rules: $patterns", async (row) => {
  const result = await logFromPlugin("field hints", row.fields, row.patterns);
  if (row.exact) {
    expect(result.records[0]["1"]).toEqual(row.expected);
  } else {
    expect(result.records[0]["1"]).toMatchObject(row.expected);
  }
});

it.each([
  {
    name: "sensitive field",
    patterns: undefined,
    receiver: {
      password: firstSecret,
      toJSON() {
        return this.password;
      },
    },
    expected: "FIRST_…7890",
  },
  {
    name: "anchored rule before composition",
    patterns: ["^FIRST_PRIVATE_VALUE_1234567890$"],
    receiver: {
      content: firstSecret,
      toJSON() {
        return `prefix ${this.content}`;
      },
    },
    expected: "prefix FIRST_…7890",
  },
])("registered plugin logger protects a plain toJSON receiver with $name", async (row) => {
  const result = await logFromPlugin(row.name, { value: row.receiver }, row.patterns);
  expect(result.records[0]["1"].value).toBe(row.expected);
  expect(JSON.stringify(result.records)).not.toContain(firstSecret);
});

it("registered plugin logger projects one capture across scalars before the next rule", async () => {
  const result = await logFromPlugin(
    "cross-scalar capture",
    { alpha: "SYNTHETIC_A", beta: "SYNTHETIC_B", next: "SYNTHETIC_NEXT", safe: "visible" },
    [
      String.raw`/"alpha":"(SYNTHETIC_A","beta":"SYNTHETIC_B)"/g`,
      String.raw`/"alpha":"\*\*\*","\*\*\*":"\*\*\*","next":"(SYNTHETIC_NEXT)"/g`,
    ],
  );
  const expected = { alpha: "***", "***": "***", next: "***", safe: "visible" };
  expect(result.records[0]["1"]).toEqual(expected);
  expect(result.console[0]).toMatchObject(expected);
  expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_(?:A|B|NEXT)/);
});
