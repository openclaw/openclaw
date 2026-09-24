import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { LogTailPayload } from "../logging/log-tail.js";
import {
  applyLoggingConfig,
  flushLogger,
  getChildLogger,
  setLoggerOverride,
} from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pem = [
  "-----BEGIN PRIVATE KEY-----",
  "ABCDEF1234567890",
  "-----END PRIVATE KEY-----",
] as const;
const record = (message: string) => JSON.stringify({ message });

it("logs.tail masks complete stored batches while preserving JSON records and byte cursors", async () => {
  const dir = tempDirs.make("openclaw-gateway-log-batch-");
  const file = path.join(dir, "stored.log");
  const cases = [
    { lines: pem.map(record), json: [0, 1, 2] },
    { lines: [record(pem.join("\n"))], json: [0] },
    { lines: pem, json: [] },
    { lines: [record(pem[0]), pem[1], record(pem[2])], json: [0, 2] },
    { lines: [record(pem[0]), pem[1], pem[1], pem[1], record(pem[2])], json: [0, 4] },
    {
      lines: pem.map((message, index) =>
        JSON.stringify({ message, ordinary: `keep-${index}`, sequence: index }),
      ),
      json: [0, 1, 2],
    },
    { lines: [record("Authorization: Basic c2VjcmV0OnBhc3M=")], json: [0] },
    { lines: ["before", "[[],[],[]]", "Authorization: Basic c2VjcmV0OnBhc3M="], json: [1] },
    { lines: [record("token=synthetic-credential-123456")], json: [0] },
  ];
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  try {
    for (const { lines, json } of cases) {
      const stored = `${lines.join("\n")}\n`;
      await fs.writeFile(file, stored);
      const response = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
      expect(response.ok).toBe(true);
      assert(response.payload);
      const tail = response.payload;
      expect(tail.cursor).toBe(Buffer.byteLength(stored));
      expect(tail.size).toBe(Buffer.byteLength(stored));
      expect(tail.lines).toHaveLength(lines.length);
      expect(tail.lines.join("\n")).not.toContain(pem[1]);
      expect(tail.lines.join("\n")).not.toContain("c2VjcmV0OnBhc3M=");
      expect(tail.lines.join("\n")).not.toContain("synthetic-credential-123456");
      for (const index of json) {
        const line = tail.lines[index];
        assert(line !== undefined);
        expect(() => JSON.parse(line)).not.toThrow();
        const originalLine = lines[index];
        assert(originalLine !== undefined);
        const original = JSON.parse(originalLine);
        if (!Array.isArray(original)) {
          const masked = JSON.parse(line);
          expect(Object.keys(masked)).toEqual(Object.keys(original));
          expect(masked.message).toEqual(expect.any(String));
          expect(masked.message.trim()).not.toBe("");
          if (original.message === pem[0] || original.message === pem[2]) {
            expect(masked.message).toBe(original.message);
          }
        }
      }
      expect(await fs.readFile(file, "utf8")).toBe(stored);
      const next = await rpcReq<LogTailPayload>(ws, "logs.tail", { cursor: tail.cursor });
      expect(next.payload?.lines).toEqual([]);
    }
  } finally {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});

it("logs.tail applies current ordered patterns and secrets registered after the file was written", async () => {
  const dir = tempDirs.make("openclaw-gateway-log-policy-");
  const file = path.join(dir, "stored.log");
  const fresh = '{ "message": "already ***", "ordinary": 42 }';
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  try {
    const stored =
      [JSON.stringify({ message: "MASKME PRIVATE_STORED", numeric: 73928164 }), fresh].join("\n") +
      "\n";
    await fs.writeFile(file, stored);
    applyLoggingConfig({ redactPatterns: ["MASKME", String.raw`/\*\*\* (PRIVATE_[A-Z]+)/g`] });
    registerSecretValueForRedaction("73928164");
    const response = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
    expect(response.ok).toBe(true);
    expect(response.payload?.lines.map((line) => JSON.parse(line))).toEqual([
      { message: "*** ***", numeric: "***" },
      { message: "already ***", ordinary: 42 },
    ]);
    expect(response.payload?.lines[1]).toBe(fresh);
    expect(response.payload?.cursor).toBe(Buffer.byteLength(stored));
    expect(await fs.readFile(file, "utf8")).toBe(stored);

    const containers = '[[],[]]\n{ "message": [[],[]] }\n{"message":"[[],[]]"}\n';
    await fs.writeFile(file, containers);
    registerSecretValueForRedaction("[[],[]]");
    const containerResponse = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
    expect(containerResponse.ok).toBe(true);
    assert(containerResponse.payload);
    expect(containerResponse.payload.lines).toHaveLength(3);
    for (const line of containerResponse.payload.lines) {
      expect(line).not.toContain("[[],[]]");
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const [, containerObject, containerString] = containerResponse.payload.lines;
    assert(containerObject !== undefined && containerString !== undefined);
    expect(JSON.parse(containerObject).message).toBeDefined();
    expect(JSON.parse(containerString).message).toBe("***");
    expect(containerResponse.payload.cursor).toBe(Buffer.byteLength(containers));
    expect(await fs.readFile(file, "utf8")).toBe(containers);

    const ordered = "123456\nsuperprivate\n";
    await fs.writeFile(file, ordered);
    applyLoggingConfig({ redactPatterns: ["123456", String.raw`\*\*\*\n(superprivate)`] });
    const orderedResponse = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
    expect(orderedResponse.ok).toBe(true);
    expect(orderedResponse.payload?.lines).toEqual(['"***"', "***"]);
    expect(orderedResponse.payload?.cursor).toBe(Buffer.byteLength(ordered));
    expect(await fs.readFile(file, "utf8")).toBe(ordered);
  } finally {
    applyLoggingConfig(undefined);
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});

it("logs.tail masks late secrets and confined pattern captures inside JSON property names", async () => {
  const dir = tempDirs.make("openclaw-gateway-log-keys-");
  const file = path.join(dir, "stored.log");
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
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  try {
    const response = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
    expect(response.ok).toBe(true);
    assert(response.payload);
    expect(response.payload.lines.join("\n")).not.toContain(secret);
    const [keyRecord, valueRecord, patternKey, patternValue] = response.payload.lines.map((line) =>
      JSON.parse(line),
    );
    expect(keyRecord).toEqual({ [valueRecord.ordinary]: "diagnostic" });
    expect(patternKey).toEqual({ 'prefix"***"suffix': "diagnostic" });
    expect(patternValue).toEqual({ message: "***", ordinary: "keep" });
    expect(response.payload.cursor).toBe(Buffer.byteLength(stored));
    expect(await fs.readFile(file, "utf8")).toBe(stored);
  } finally {
    applyLoggingConfig(undefined);
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});

it.each(["raw", "JSON"])(
  "logs.tail masks %s PEM bodies across selection windows and separate cursor polls",
  async (format) => {
    const dir = tempDirs.make("openclaw-gateway-log-pem-context-");
    const file = path.join(dir, "stored.log");
    const lines = format === "JSON" ? pem.map(record) : [...pem];
    const messages = (tail: LogTailPayload) =>
      tail.lines.map((line) => (format === "JSON" ? JSON.parse(line).message : line));
    const stored = `${lines.join("\n")}\n`;
    setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
    try {
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
        const response = await rpcReq<LogTailPayload>(ws, "logs.tail", selection);
        expect(response.ok).toBe(true);
        assert(response.payload);
        expect(response.payload).toMatchObject({
          cursor: Buffer.byteLength(stored),
          size: Buffer.byteLength(stored),
          truncated: true,
          reset: false,
        });
        expect(messages(response.payload)).toEqual([
          expect.stringMatching(/^(?:\*\*\*|…redacted…)$/),
          pem[2],
        ]);
        expect(response.payload.lines.join("\n")).not.toContain(pem[1]);
        expect(await fs.readFile(file, "utf8")).toBe(stored);
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
          const response = await rpcReq<LogTailPayload>(ws, "logs.tail", { cursor });
          expect(response.ok).toBe(true);
          assert(response.payload);
          expect(response.payload).toMatchObject({
            cursor: Buffer.byteLength(written),
            size: Buffer.byteLength(written),
            truncated: false,
            reset: false,
          });
          const expected = chunk.map(() => {
            const message = pem[sourceIndex++];
            return message === pem[1] ? expect.stringMatching(/^(?:\*\*\*|…redacted…)$/) : message;
          });
          expect(messages(response.payload)).toEqual(expected);
          expect(response.payload.lines.join("\n")).not.toContain(pem[1]);
          expect(await fs.readFile(file, "utf8")).toBe(written);
          cursor = response.payload.cursor;
          const repeated = await rpcReq<LogTailPayload>(ws, "logs.tail", { cursor });
          expect(repeated.ok).toBe(true);
          expect(repeated.payload?.lines).toEqual([]);
          expect(repeated.payload?.cursor).toBe(cursor);
        }
      }
    } finally {
      setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    }
  },
);

it("logs.tail preserves ambiguous and long PEM prefix context at a byte cursor", async () => {
  const dir = tempDirs.make("openclaw-gateway-log-prefix-");
  const file = path.join(dir, "stored.log");
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  try {
    for (const inherited of [false, true]) {
      const prefix =
        (inherited ? `${pem[0]}\n` : "") +
        "ordinary padding\n".repeat(500) +
        `${pem[0]}${pem[2]}\n`;
      await fs.writeFile(file, `${prefix}following value\n`);
      const response = await rpcReq<LogTailPayload>(ws, "logs.tail", {
        cursor: Buffer.byteLength(prefix),
      });
      expect(response.ok).toBe(true);
      expect(response.payload?.lines).toEqual([inherited ? "following value" : "…redacted…"]);
    }
    const prefix = `-----BEGIN ${"A".repeat(300_000)} PRIVATE KEY-----\n`;
    await fs.writeFile(file, `${prefix}long body\n`);
    const response = await rpcReq<LogTailPayload>(ws, "logs.tail", {
      cursor: Buffer.byteLength(prefix),
    });
    expect(response.ok).toBe(true);
    expect(response.payload?.lines).toEqual(["…redacted…"]);
    expect(response.payload?.cursor).toBe(Buffer.byteLength(`${prefix}long body\n`));
  } finally {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});

it("tails configured rolling placeholders through authenticated Gateway RPC", async () => {
  const tempDir = tempDirs.make("openclaw-gateway-log-tail-");
  setLoggerOverride({
    file: path.join(tempDir, "openclaw-YYYY-MM-DD.log"),
    level: "info",
    consoleLevel: "silent",
  });
  try {
    getChildLogger({ module: "log-tail" }).warn({ reason: "disabled" }, "rolling RPC record");
    await flushLogger();

    const response = await rpcReq<{ file: string; lines: string[] }>(ws, "logs.tail", {
      limit: 200,
      maxBytes: 256_000,
    });

    expect(response.ok).toBe(true);
    expect(response.payload?.lines).toEqual(
      expect.arrayContaining([expect.stringContaining("rolling RPC record")]),
    );
    expect(path.dirname(response.payload?.file ?? "")).toBe(tempDir);
    expect(path.basename(response.payload?.file ?? "")).toMatch(
      /^openclaw-\d{4}-\d{2}-\d{2}\.log$/,
    );
  } finally {
    await flushLogger();
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});
