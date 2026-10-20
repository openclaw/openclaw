import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfiguredLogTail } from "./log-tail.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  setLoggerOverride(null);
  resetLogger();
  tempDirs.cleanup();
});

describe("readConfiguredLogTail redaction", () => {
  it("redacts raw auth headers before returning log lines", async () => {
    const basicSecret = "c2VjcmV0OnBhc3M=";
    const openClawToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";

    const text = await withLog(
      [
        `Authorization: Basic ${basicSecret}`,
        `X-OpenClaw-Token: ${openClawToken}`,
        `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
        "normal diagnostic line",
      ].join("\n") + "\n",
      async () => (await readConfiguredLogTail({ limit: 10 })).lines.join("\n"),
    );

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
  const record = {
    password: 1234,
    apiKey: false,
    signature: "short-signature",
    nested: { "x-pomerium-jwt-assertion": "opaque-header" },
    message: "sk-syntheticcredential123456 CUSTOM_VALUE",
    ordinary: "request completed",
  };
  const raw = `${JSON.stringify(record)}\n`;
  const tail = await withLog(
    raw,
    async (file) => {
      const result = await readConfiguredLogTail();
      expect(await fs.readFile(file, "utf8")).toBe(raw);
      return result;
    },
    { redactPatterns: ["CUSTOM_VALUE"] },
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
});

async function withLog<T>(
  content: string,
  run: (file: string) => Promise<T>,
  logging: { redactSensitive?: "tools"; redactPatterns?: string[] } = { redactSensitive: "tools" },
) {
  const dir = tempDirs.make("openclaw-log-tail-pem-");
  const file = path.join(dir, "configured.log");
  const config = path.join(dir, "openclaw.json");
  await fs.writeFile(config, JSON.stringify({ logging }));
  await fs.writeFile(file, content);
  setLoggerOverride({ file });
  return withEnvAsync({ OPENCLAW_CONFIG_PATH: config }, () => run(file));
}

const pemBegin = "-----BEGIN PRIVATE KEY-----\n";
const pemEnd = "-----END PRIVATE KEY-----\n";

describe("PEM tail context", () => {
  it.each([false, true])(
    "preserves a block's state before cold and incremental windows (closed=%s)",
    async (closed) => {
      const prefix = pemBegin + "earlier body\n" + (closed ? pemEnd : "");
      await withLog(prefix + "older line\n".repeat(2000) + "cold line\n", async (file) => {
        const cold = await readConfiguredLogTail({ limit: 1, maxBytes: 64 });
        expect(cold.lines).toEqual([closed ? "cold line" : "…redacted…"]);

        await fs.appendFile(file, "incremental line\n");
        const incremental = await readConfiguredLogTail({ cursor: cold.cursor, maxBytes: 64 });
        expect(incremental.lines).toEqual([closed ? "incremental line" : "…redacted…"]);
        expect(incremental.cursor).toBe((await fs.stat(file)).size);
      });
    },
  );

  it("advances across filtered openers and resolves a closer between the anchor and selection", async () => {
    await withLog("ordinary line\n", async (file) => {
      const initial = await readConfiguredLogTail();
      await fs.appendFile(file, pemBegin + "hidden body\n");
      const hidden = await readConfiguredLogTail({ cursor: initial.cursor }, () => false);
      expect(hidden.lines).toEqual([]);

      await fs.appendFile(file, "visible body\n");
      const body = await readConfiguredLogTail({ cursor: hidden.cursor });
      expect(body.lines).toEqual(["…redacted…"]);

      await fs.appendFile(file, pemEnd + "ordinary after close\n");
      const closed = await readConfiguredLogTail({ cursor: body.cursor, limit: 1 });
      expect(closed.lines).toEqual(["ordinary after close"]);
      await fs.appendFile(file, "still ordinary\n");
      expect((await readConfiguredLogTail({ cursor: closed.cursor })).lines).toEqual([
        "still ordinary",
      ]);
    });
  });

  it("keeps partial delimiters out of cached state until their record is complete", async () => {
    const complete = "ordinary line 🦞\n";
    await withLog(complete + "-----BEGIN PRI", async (file) => {
      const initial = await readConfiguredLogTail();
      expect(initial).toMatchObject({
        lines: ["ordinary line 🦞"],
        cursor: Buffer.byteLength(complete),
      });
      await fs.appendFile(file, "VATE KEY-----\nfirst body\n");
      const opened = await readConfiguredLogTail({ cursor: initial.cursor, limit: 1 });
      expect(opened.lines).toEqual(["…redacted…"]);

      await fs.appendFile(file, "next body\n-----END PRI");
      const partialClose = await readConfiguredLogTail({ cursor: opened.cursor });
      expect(partialClose.lines).toEqual(["…redacted…"]);
      await fs.appendFile(file, "VATE KEY-----\nordinary again\n");
      expect(
        (await readConfiguredLogTail({ cursor: partialClose.cursor, limit: 1 })).lines,
      ).toEqual(["ordinary again"]);
    });
  });

  it.each(["rotation", "truncation", "empty poll"] as const)(
    "discards cached state after %s",
    async (change) => {
      await withLog("old ordinary line\n".repeat(1000), async (file) => {
        const initial = await readConfiguredLogTail({ limit: 1 });
        if (change === "rotation") {
          await fs.rename(file, `${file}.retired`);
        } else if (change === "empty poll") {
          await fs.truncate(file, 0);
          expect(await readConfiguredLogTail({ cursor: initial.cursor })).toMatchObject({
            lines: [],
            cursor: 0,
            reset: true,
          });
        }
        // Rotation/regrowth exceeds the old offset; truncation stays below it.
        const bodyLines = change === "truncation" ? 100 : 2000;
        await fs.writeFile(file, pemBegin + "new body line\n".repeat(bodyLines));
        const replacement = await readConfiguredLogTail({ limit: 1, maxBytes: 64 });
        expect(replacement.lines).toEqual(["…redacted…"]);

        await fs.appendFile(file, pemEnd + "ordinary replacement\n");
        const closed = await readConfiguredLogTail({ cursor: replacement.cursor, limit: 1 });
        expect(closed.lines).toEqual(["ordinary replacement"]);
      });
    },
  );

  it("does not carry an open block into another configured file", async () => {
    await withLog(pemBegin + "private body\n", async (file) => {
      expect((await readConfiguredLogTail({ limit: 1 })).lines).toEqual(["…redacted…"]);
      const otherFile = `${file}.other`;
      await fs.writeFile(otherFile, "ordinary line\n".repeat(100));
      setLoggerOverride({ file: otherFile });
      expect((await readConfiguredLogTail({ limit: 1, maxBytes: 64 })).lines).toEqual([
        "ordinary line",
      ]);
    });
  });

  it("uses the opened inode when rotation replaces the path after metadata sampling", async () => {
    await withLog("old ordinary line\n".repeat(1000), async (file) => {
      const initial = await readConfiguredLogTail({ limit: 1 });
      await fs.appendFile(file, "old pending line\n".repeat(100));
      const realOpen = fs.open.bind(fs);
      let rotated = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (!rotated && String(args[0]) === file && args[1] === "r") {
          rotated = true;
          await fs.rename(file, `${file}.retired`);
          await fs.writeFile(file, pemBegin + "new body line\n".repeat(2000));
        }
        return realOpen(...args);
      });
      const replacement = await readConfiguredLogTail({ cursor: initial.cursor, limit: 1 });
      expect(rotated).toBe(true);
      expect(replacement.lines).toEqual(["…redacted…"]);
    });
  });
});
