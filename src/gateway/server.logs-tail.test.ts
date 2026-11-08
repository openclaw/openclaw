import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { LogTailPayload } from "../logging/log-tail.js";
import { applyLoggingConfig, setLoggerOverride } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let file: string;
function resetLogFile() {
  file = path.join(tempDirs.make("openclaw-gateway-log-tail-"), "stored.log");
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
}
beforeEach(resetLogFile);
afterEach(() => {
  applyLoggingConfig(undefined);
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
});
const pem = [
  "-----BEGIN PRIVATE KEY-----",
  "ABCDEF1234567890",
  "-----END PRIVATE KEY-----",
] as const;
const record = (message: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ message, ...fields });

async function readTail(
  params: { cursor?: number; limit?: number; maxBytes?: number },
  stored?: string,
) {
  const response = await rpcReq<LogTailPayload>(ws, "logs.tail", params);
  expect(response.ok).toBe(true);
  assert(response.payload);
  if (stored !== undefined) {
    expect(response.payload.cursor).toBe(Buffer.byteLength(stored));
    expect(await fs.readFile(file, "utf8")).toBe(stored);
  }
  return response.payload;
}

it("logs.tail masks complete stored batches while preserving JSON records and byte cursors", async () => {
  const cases = [
    pem.map((message) => record(message)),
    [record(pem.join("\n"))],
    pem,
    [record(pem[0]), pem[1], record(pem[2])],
    [record(pem[0]), pem[1], pem[1], pem[1], record(pem[2])],
    pem.map((message, index) => record(message, { ordinary: `keep-${index}`, sequence: index })),
    [record("Authorization: Basic c2VjcmV0OnBhc3M=")],
    ["before", "[[],[],[]]", "Authorization: Basic c2VjcmV0OnBhc3M="],
    [record("token=synthetic-credential-123456")],
  ];
  for (const lines of cases) {
    const stored = `${lines.join("\n")}\n`;
    await fs.writeFile(file, stored);
    const tail = await readTail({ limit: 100 }, stored);
    expect(tail.size).toBe(Buffer.byteLength(stored));
    expect(tail.lines).toHaveLength(lines.length);
    for (const secret of [pem[1], "c2VjcmV0OnBhc3M=", "synthetic-credential-123456"]) {
      expect(tail.lines.join("\n")).not.toContain(secret);
    }
    for (const [index, originalLine] of lines.entries()) {
      if (!originalLine.startsWith("{") && !originalLine.startsWith("[")) {
        continue;
      }
      const line = tail.lines[index];
      assert(line !== undefined);
      const masked = JSON.parse(line);
      const original = JSON.parse(originalLine);
      if (!Array.isArray(original)) {
        expect(Object.keys(masked)).toEqual(Object.keys(original));
        expect(masked.message).toEqual(expect.any(String));
        expect(masked.message.trim()).not.toBe("");
        if (original.message === pem[0] || original.message === pem[2]) {
          expect(masked.message).toBe(original.message);
        }
      }
    }
    const next = await readTail({ cursor: tail.cursor });
    expect(next.lines).toEqual([]);
  }
});

it("logs.tail applies current ordered patterns and secrets registered after the file was written", async () => {
  const fresh = '{ "message": "already ***", "ordinary": 42 }';
  const stored = [record("MASKME PRIVATE_STORED", { numeric: 73928164 }), fresh].join("\n") + "\n";
  await fs.writeFile(file, stored);
  applyLoggingConfig({ redactPatterns: ["MASKME", String.raw`/\*\*\* (PRIVATE_[A-Z]+)/g`] });
  registerSecretValueForRedaction("73928164");
  const response = await readTail({ limit: 100 }, stored);
  expect(response.lines.map((line) => JSON.parse(line))).toEqual([
    { message: "*** ***", numeric: "***" },
    { message: "already ***", ordinary: 42 },
  ]);
  expect(response.lines[1]).toBe(fresh);

  const containers = '[[],[]]\n{ "message": [[],[]] }\n{"message":"[[],[]]"}\n';
  await fs.writeFile(file, containers);
  registerSecretValueForRedaction("[[],[]]");
  const containerResponse = await readTail({ limit: 100 }, containers);
  expect(containerResponse.lines).toHaveLength(3);
  for (const line of containerResponse.lines) {
    expect(line).not.toContain("[[],[]]");
    expect(() => JSON.parse(line)).not.toThrow();
  }
  const [, containerObject, containerString] = containerResponse.lines;
  assert(containerObject !== undefined && containerString !== undefined);
  expect(JSON.parse(containerObject).message).toBeDefined();
  expect(JSON.parse(containerString).message).toBe("***");

  const ordered = "123456\nsuperprivate\n";
  await fs.writeFile(file, ordered);
  applyLoggingConfig({ redactPatterns: ["123456", String.raw`\*\*\*\n(superprivate)`] });
  const orderedResponse = await readTail({ limit: 100 }, ordered);
  expect(orderedResponse.lines).toEqual(['"***"', "***"]);
});

it("logs.tail masks late secrets and confined pattern captures inside JSON property names", async () => {
  const secret = "opaque-registered-key-987654321";
  const stored =
    [
      JSON.stringify({ [secret]: "diagnostic" }),
      JSON.stringify({ ordinary: secret }),
      JSON.stringify({ 'prefix"MASKME"suffix': "diagnostic" }),
      JSON.stringify({ message: "VALUE_ONLY", ordinary: "keep" }),
    ].join("\n") + "\n";
  await fs.writeFile(file, stored);
  registerSecretValueForRedaction(secret);
  applyLoggingConfig({
    redactPatterns: [String.raw`"prefix\\"(MASKME)\\"suffix":`, "VALUE_ONLY"],
  });
  const response = await readTail({ limit: 100 }, stored);
  expect(response.lines.join("\n")).not.toContain(secret);
  const [keyRecord, valueRecord, patternKey, patternValue] = response.lines.map((line) =>
    JSON.parse(line),
  );
  expect(keyRecord).toEqual({ [valueRecord.ordinary]: "diagnostic" });
  expect(patternKey).toEqual({ 'prefix"***"suffix': "diagnostic" });
  expect(patternValue).toEqual({ message: "***", ordinary: "keep" });
});

it.each(["raw", "JSON"])(
  "logs.tail masks %s PEM bodies across selection windows and separate cursor polls",
  async (format) => {
    const lines = format === "JSON" ? pem.map((message) => record(message)) : [...pem];
    const messages = (tail: LogTailPayload) =>
      tail.lines.map((line) => (format === "JSON" ? JSON.parse(line).message : line));
    const stored = `${lines.join("\n")}\n`;
    await fs.writeFile(file, stored);
    const bodyAndFooterBytes = Buffer.byteLength(`${lines.slice(1).join("\n")}\n`);
    const header = lines[0];
    assert(header !== undefined);
    const middleOfHeader = header.indexOf("PRIVATE") + 3;
    for (const selection of [
      { limit: 2 },
      { maxBytes: bodyAndFooterBytes },
      { maxBytes: Buffer.byteLength(stored) - middleOfHeader },
    ]) {
      const response = await readTail(selection, stored);
      expect(response).toMatchObject({
        size: Buffer.byteLength(stored),
        truncated: true,
        reset: false,
      });
      expect(messages(response)).toEqual([
        expect.stringMatching(/^(?:\*\*\*|…redacted…)$/),
        pem[2],
      ]);
      expect(response.lines.join("\n")).not.toContain(pem[1]);
    }

    for (const chunks of [[lines.slice(0, 2), lines.slice(2)], lines.map((line) => [line])]) {
      let cursor = 0;
      let written = "";
      let sourceIndex = 0;
      await fs.writeFile(file, "");
      for (const chunk of chunks) {
        const appended = `${chunk.join("\n")}\n`;
        written += appended;
        await fs.appendFile(file, appended);
        const response = await readTail({ cursor }, written);
        expect(response).toMatchObject({
          size: Buffer.byteLength(written),
          truncated: false,
          reset: false,
        });
        const expected = chunk.map(() => {
          const message = pem[sourceIndex++];
          return message === pem[1] ? expect.stringMatching(/^(?:\*\*\*|…redacted…)$/) : message;
        });
        expect(messages(response)).toEqual(expected);
        expect(response.lines.join("\n")).not.toContain(pem[1]);
        cursor = response.cursor;
        const repeated = await readTail({ cursor });
        expect(repeated).toMatchObject({ lines: [], cursor });
      }
    }
  },
);

it("logs.tail preserves ambiguous and long PEM prefix context at a byte cursor", async () => {
  for (const inherited of [false, true]) {
    resetLogFile();
    const prefix =
      (inherited ? `${pem[0]}\n` : "") + "ordinary padding\n".repeat(500) + `${pem[0]}${pem[2]}\n`;
    await fs.writeFile(file, `${prefix}following value\n`);
    const response = await readTail({
      cursor: Buffer.byteLength(prefix),
    });
    expect(response.lines).toEqual([inherited ? "following value" : "…redacted…"]);
  }
  resetLogFile();
  const prefix = `-----BEGIN ${"A".repeat(300_000)} PRIVATE KEY-----\n`;
  await fs.writeFile(file, `${prefix}long body\n`);
  const response = await readTail({
    cursor: Buffer.byteLength(prefix),
  });
  expect(response.lines).toEqual(["…redacted…"]);
  expect(response.cursor).toBe(Buffer.byteLength(`${prefix}long body\n`));
});
