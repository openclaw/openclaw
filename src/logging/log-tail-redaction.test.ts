// Log tail redaction tests cover scrubbing sensitive data from tailed logs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfiguredLogTail } from "./log-tail.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  setLoggerOverride(null);
  resetLogger();
  tempDirs.cleanup();
});

describe("readConfiguredLogTail redaction", () => {
  it("redacts raw auth headers before returning log lines", async () => {
    const dir = tempDirs.make("openclaw-log-tail-redaction-");
    const logFile = path.join(dir, "openclaw.log");
    const configFile = path.join(dir, "openclaw.json");
    const basicSecret = "c2VjcmV0OnBhc3M=";
    const openClawToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";

    await fs.writeFile(
      configFile,
      JSON.stringify({ logging: { redactSensitive: "tools" } }),
      "utf8",
    );
    await fs.writeFile(
      logFile,
      [
        `Authorization: Basic ${basicSecret}`,
        `X-OpenClaw-Token: ${openClawToken}`,
        `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
        "normal diagnostic line",
      ].join("\n") + "\n",
      "utf8",
    );
    setLoggerOverride({ file: logFile });

    const payload = await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: configFile },
      async () => await readConfiguredLogTail({ limit: 10 }),
    );
    const text = payload.lines.join("\n");

    expect(text).toContain("Authorization: Basic ***");
    expect(text).toContain("X-OpenClaw-Token: supers…7890");
    expect(text).toContain("x-pomerium-jwt-assertion: eyJhea…3456");
    expect(text).toContain("normal diagnostic line");
    expect(text).not.toContain(basicSecret);
    expect(text).not.toContain(openClawToken);
    expect(text).not.toContain(pomeriumJwt);
  });
});

it("redacts raw JSON credentials and default tokens with custom tail patterns", async () => {
  const dir = tempDirs.make("openclaw-raw-log-tail-");
  const logFile = path.join(dir, "openclaw.log");
  const configFile = path.join(dir, "openclaw.json");
  await fs.writeFile(configFile, JSON.stringify({ logging: { redactPatterns: ["CUSTOM_VALUE"] } }));
  const record = {
    password: 1234,
    apiKey: false,
    signature: "short-signature",
    nested: { "x-pomerium-jwt-assertion": "opaque-header" },
    message: "sk-syntheticcredential123456 CUSTOM_VALUE",
    ordinary: "request completed",
  };
  const raw = `${JSON.stringify(record)}\n`;
  await fs.writeFile(logFile, raw);
  setLoggerOverride({ file: logFile });
  const tail = await withEnvAsync({ OPENCLAW_CONFIG_PATH: configFile }, () =>
    readConfiguredLogTail(),
  );
  assert(tail.lines[0] !== undefined);
  const redacted = JSON.parse(tail.lines[0]);
  expect(redacted).toMatchObject({
    password: "***",
    apiKey: "***",
    signature: "***",
    nested: { "x-pomerium-jwt-assertion": "***" },
    ordinary: "request completed",
  });
  expect(redacted.message).not.toContain("sk-syntheticcredential123456");
  expect(redacted.message).not.toContain("CUSTOM_VALUE");
  expect(tail.cursor).toBe(Buffer.byteLength(raw));
  expect(await fs.readFile(logFile, "utf8")).toBe(raw);
});
