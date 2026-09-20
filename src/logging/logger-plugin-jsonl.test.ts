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
  testApi.setHostnameResolverForTests();
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
  patterns?: string[],
  write?: (logger: ReturnType<typeof getChildLogger>) => void,
) {
  const file = paths.nextPath();
  applyLoggingConfig({
    level: "info",
    file,
    consoleStyle: "json",
    consoleLevel: "info",
    redactPatterns: patterns,
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

it("registered plugin logger writes quoted credentials as valid file and console JSON", async () => {
  const result = await logFromPlugin('--token "synthetic-credential-123456"');
  expect(result.records).toHaveLength(1);
  expect(result.console).toHaveLength(1);
  for (const record of [...result.records, ...result.console]) {
    expect(record.message).toBe("--token ***");
  }
  expect((await readConfiguredLogTail()).lines).toEqual(result.lines);
});

it.each([
  { name: "anchored", patterns: ["^private-value$"], value: "private-value", expected: "***" },
  {
    name: "contextual",
    patterns: ['"value":"(private-value)"'],
    value: "private-value",
    expected: "***",
  },
  {
    name: "ordered",
    patterns: ["MASKME", String.raw`/\*\*\* (PRIVATE_[A-Z]+)/g`],
    value: "MASKME PRIVATE_VALUE",
    expected: "*** ***",
  },
  { name: "numeric", patterns: ['"value":(42)'], value: 42, expected: "***" },
  { name: "boolean", patterns: ['"value":(true)'], value: true, expected: "***" },
  { name: "null", patterns: ['"value":(null)'], value: null, expected: "***" },
])(
  "registered plugin service logger preserves $name masking on JSON scalar tokens",
  async ({ patterns, value, expected }) => {
    const result = await logFromPlugin("scalar proof", { value }, [
      ...getDefaultRedactPatterns(),
      ...patterns,
    ]);
    expect(result.records[0]["1"].value).toBe(expected);
    expect(result.console[0].value).toBe(expected);
  },
);

it("registered plugin service logger applies explicit rules to preserved references", async () => {
  const result = await logFromPlugin(
    "reference proof",
    { session: "$WORKSPACE_DIR/private-value.jsonl", TOKEN: "$TOKEN", safe: "$SAFE" },
    [...getDefaultRedactPatterns(), "private-value", String.raw`\$TOKEN`],
  );
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record).toMatchObject({
      session: "$WORKSPACE_DIR/***.jsonl",
      TOKEN: "***",
      safe: "$SAFE",
    });
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
  testApi.setHostnameResolverForTests(() => '--token "synthetic-credential-123456"');
  const result = await logFromPlugin("overflow", undefined, undefined, (logger) => {
    logger.info("first");
    logger.info("second");
  });
  expect(result.records[0].dropped).toBe(1);
  expect(result.records[0].hostname).not.toContain("synthetic-credential-123456");
});

it("registered plugin service logger projects ordered native argument masks into its display message", async () => {
  let conversions = 0;
  const fields = { stage: "MASKME", account: 123456, next: "PRIVATE_VALUE", ordinary: "visible" };
  const patterns = [
    ...getDefaultRedactPatterns(),
    "MASKME",
    String.raw`/"account":(123456)/g`,
    String.raw`/"account":"\*\*\*","next":"(PRIVATE_[A-Z]+)"/g`,
  ];
  const result = await logFromPlugin("native", undefined, patterns, (logger) => {
    logger.info(
      "derived ordered",
      new (class {
        toJSON() {
          conversions += 1;
          return fields;
        }
      })(),
    );
  });
  expect(conversions).toBe(1);
  expect(result.records).toHaveLength(1);
  expect(result.records[0].message).toBe(
    'derived ordered {"stage":"***","account":"***","next":"***","ordinary":"visible"}',
  );
  expect(JSON.stringify(result.records)).not.toContain("PRIVATE_VALUE");
});

it("registered plugin service logger preserves default credential and benign field handling", async () => {
  const result = await logFromPlugin("header proof", {
    "x-pomerium-jwt-assertion": "opaque-value",
    bare: "zQ7mL2rV9aN4cT6xH8pS1dF3kJ5uW0yB7eG2nR9i",
    ordinary: "worker finished normally",
  });
  expect(result.records).toHaveLength(1);
  expect(result.console).toHaveLength(1);
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record).toMatchObject({
      "x-pomerium-jwt-assertion": "***",
      bare: "zQ7mL2…nR9i",
      ordinary: "worker finished normally",
    });
  }
  expect(JSON.stringify(result.records)).not.toContain("opaque-value");
  expect(JSON.stringify(result.console)).not.toContain("opaque-value");
});

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

it.each([":", "="])(
  "registered plugin logger masks line-separated JWT header diagnostics (%s)",
  async (separator) => {
    const result = await logFromPlugin(
      `x-pomerium-jwt-assertion${separator} opaque7\nfollowing-diagnostic-line`,
    );
    expect(result.records).toHaveLength(1);
    expect(result.console).toHaveLength(1);
    for (const record of [...result.records, ...result.console]) {
      expect(record.message).not.toContain("opaque");
      expect(record.message).toContain(`x-pomerium-jwt-assertion${separator} ***`);
    }
  },
);

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

it("registered plugin service logger protects a credential-header receiver before one file conversion", async () => {
  let conversions = 0;
  const receiver = {
    "x-pomerium-jwt-assertion": "opaque-value",
    toJSON() {
      conversions += 1;
      return this["x-pomerium-jwt-assertion"];
    },
  };
  const result = await logFromPlugin("header receiver", undefined, undefined, (logger) => {
    logger.info("header receiver", { value: receiver });
  });
  expect(conversions).toBe(1);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]["2"].value).toBe("***");
  expect(result.records[0].message).toBe('header receiver {"value":"***"}');
  expect(JSON.stringify(result.records)).not.toContain("opaque-value");
});

it.each(["opaque-value", 123456])(
  "registered plugin service logger retains header context until configured rules run: %s",
  async (value) => {
    const result = await logFromPlugin(
      "header context",
      { "x-pomerium-jwt-assertion": value, next: "SECOND_PRIVATE_VALUE" },
      [`/"x-pomerium-jwt-assertion":${JSON.stringify(value)},"next":"(SECOND_PRIVATE_VALUE)"/g`],
    );
    expect(result.records[0]["1"]).toEqual({
      "x-pomerium-jwt-assertion": "***",
      next: "SECOND…ALUE",
    });
  },
);

it("registered plugin service logger preserves class display punctuation after quoted credentials", async () => {
  let conversions = 0;
  const result = await logFromPlugin("class conversion", undefined, undefined, (logger) => {
    logger.info(
      "class conversion",
      new (class {
        toJSON() {
          conversions += 1;
          return {
            token: "OPAQUE_CONVERT_TOKEN",
            text: '--token "synthetic-credential-123456"',
            after: "still-visible",
          };
        }
      })(),
    );
  });
  expect(conversions).toBe(1);
  expect(result.records[0].message).toBe(
    'class conversion {"token":"***","text":"--token ***","after":"still-visible"}',
  );
  expect(JSON.stringify(result.records)).not.toContain("synthetic-credential-123456");
});

it("registered plugin service logger preserves hints required by later rules", async () => {
  const value = "FIRST_PRIVATE_VALUE_1234567890 SECOND_PRIVATE_VALUE";
  const result = await logFromPlugin(`HUNT hints ${value}`, { value }, [
    ...getDefaultRedactPatterns(),
    "FIRST_PRIVATE_VALUE_1234567890",
    "/FIRST_…7890 (SECOND_PRIVATE_VALUE)/g",
  ]);
  expect(result.records[0]["1"].value).toBe("FIRST_…7890 SECOND…ALUE");
  expect(result.records[0].message).toBe("HUNT hints FIRST_…7890 SECOND…ALUE");
  expect(result.console[0]).toMatchObject({
    value: "FIRST_…7890 SECOND…ALUE",
    message: "HUNT hints FIRST_…7890 SECOND…ALUE",
  });
});

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

it.each([Number.NaN, Infinity, -Infinity])(
  "registered plugin service logger retains non-finite diagnostic text for %s",
  async (value) => {
    const result = await logFromPlugin("native values", undefined, undefined, (logger) => {
      logger.info("HUNT value", value);
      logger.log(3, "INFO", value);
    });
    expect(result.records.map((record) => record.message)).toEqual([
      `HUNT value ${String(value)}`,
      String(value),
    ]);
  },
);

it("registered plugin service logger preserves unselected console diagnostic text", async () => {
  const result = await logFromPlugin("abcd-efgh-ijkl-mnop");
  expect(result.console[0].message).toBe("abcd-efgh-ijkl-mnop");
});

it("registered plugin service logger preserves encoded hints required by serialized rules", async () => {
  const value = "AA\nBCDEFGHIJKLMNOPQRSTUVWXYZ1234 SECOND_PRIVATE_VALUE";
  const result = await logFromPlugin("encoded hints", { value }, [
    String.raw`/"value":"(AA\\nBCDEFGHIJKLMNOPQRSTUVWXYZ1234)/g`,
    String.raw`/AA\\nBC…1234 (SECOND_PRIVATE_VALUE)/g`,
  ]);
  expect(result.records[0]["1"].value).toBe("AA\nBC…1234 SECOND…ALUE");
  expect(result.console[0].value).toBe("AA\nBC…1234 SECOND…ALUE");
});

it("registered plugin service logger preserves registered hints required by later rules", async () => {
  registerSecretValueForRedaction("FIRST_PRIVATE_VALUE_1234567890");
  const value = "FIRST_PRIVATE_VALUE_1234567890 SECOND_PRIVATE_VALUE";
  const result = await logFromPlugin("registered hints", { value }, [
    "/FIRST_…7890 (SECOND_PRIVATE_VALUE)/g",
  ]);
  expect(result.records[0]["1"].value).toBe("FIRST_…7890 SECOND…ALUE");
  expect(result.console[0].value).toBe("FIRST_…7890 SECOND…ALUE");
});

it.each([
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
])(
  "registered plugin service logger preserves field hints for serialized rules: $patterns",
  async ({ fields, patterns }) => {
    const result = await logFromPlugin("field hints", fields, patterns);
    expect(result.records[0]["1"].next).toBe("SECOND…ALUE");
    if ("password" in fields) {
      expect(result.records[0]["1"].password).toBe("***");
    }
  },
);

it.each([12345678901234567890n, Number.NaN, Infinity, -Infinity, false])(
  "registered plugin service logger retains primitive field masks during conversion: %s",
  async (value) => {
    const result = await logFromPlugin(
      "primitive field",
      { password: value, next: "SECOND_PRIVATE_VALUE" },
      [String.raw`/"password":"\*\*\*","next":"(SECOND_PRIVATE_VALUE)"/g`],
    );
    expect(result.records[0]["1"]).toEqual({ password: "***", next: "SECOND…ALUE" });
  },
);

it.each([123456, false])(
  "registered plugin service logger retains primitive share masks: %s",
  async (value) => {
    const result = await logFromPlugin(
      "primitive share",
      { publicShare: { id: value }, next: "SECOND_PRIVATE_VALUE" },
      [String.raw`/"publicShare":\{"id":"\*\*\*"\},"next":"(SECOND_PRIVATE_VALUE)"/g`],
    );
    expect(result.records[0]["1"].next).toBe("SECOND…ALUE");
  },
);

it("registered plugin service logger protects a plain toJSON receiver before conversion", async () => {
  const receiver = {
    password: "FIRST_PRIVATE_VALUE_1234567890",
    toJSON() {
      return this.password;
    },
  };
  const result = await logFromPlugin("plain receiver", { value: receiver });
  expect(result.records[0]["1"].value).toBe("FIRST_…7890");
  expect(JSON.stringify(result.records)).not.toContain("FIRST_PRIVATE_VALUE_1234567890");
});

it("registered plugin service logger applies anchored rules before plain toJSON composition", async () => {
  const receiver = {
    content: "FIRST_PRIVATE_VALUE_1234567890",
    toJSON() {
      return `prefix ${this.content}`;
    },
  };
  const result = await logFromPlugin("composed receiver", { value: receiver }, [
    "^FIRST_PRIVATE_VALUE_1234567890$",
  ]);
  expect(result.records[0]["1"].value).toBe("prefix FIRST_…7890");
});

it("registered plugin service logger preserves URL hints required by configured rules", async () => {
  const value =
    "https://example.invalid/?token=FIRST_PRIVATE_VALUE_1234567890 SECOND_PRIVATE_VALUE";
  const result = await logFromPlugin("URL hints", { value }, [
    "/token=FIRST_…7890 (SECOND_PRIVATE_VALUE)/g",
  ]);
  expect(result.records[0]["1"].value).not.toContain("SECOND_PRIVATE_VALUE");
  expect(result.console[0].value).not.toContain("SECOND_PRIVATE_VALUE");
});

it("registered plugin service logger never restores a secret after a zero-width rule", async () => {
  const value = "FIRST_PRIVATE_VALUE_1234567890 SECOND_PRIVATE_VALUE";
  const result = await logFromPlugin("empty-span rule", { value }, [
    "/^FIRST_PRIVATE_VALUE_1234567890/g",
    "/(?<=^FIRST_…7890 )/g",
  ]);
  expect(result.records[0]["1"].value).toBe("FIRST_…7890 ***SECOND_PRIVATE_VALUE");
  expect(result.console[0].value).toBe("FIRST_…7890 ***SECOND_PRIVATE_VALUE");
});
