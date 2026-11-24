import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { readConfiguredLogTail } from "./log-tail.js";

const tempDirs = createTempDirTracker();
const pemBegin = "-----BEGIN PRIVATE KEY-----\n";
const pemEnd = "-----END PRIVATE KEY-----\n";
const masked = ["…redacted…"];
let file: string;
async function seed(
  content: string,
  logging: { redactSensitive?: "tools"; redactPatterns?: string[] } = { redactSensitive: "tools" },
) {
  const dir = tempDirs.make("openclaw-log-tail-");
  file = path.join(dir, "configured.log");
  const config = path.join(dir, "openclaw.json");
  await fs.writeFile(config, JSON.stringify({ logging }));
  await fs.writeFile(file, content);
  setLoggerOverride({ file });
  vi.stubEnv("OPENCLAW_CONFIG_PATH", config);
}
async function tail(
  lines: string[],
  params?: Parameters<typeof readConfiguredLogTail>[0],
  filter?: Parameters<typeof readConfiguredLogTail>[1],
) {
  const result = await readConfiguredLogTail(params, filter);
  expect(result.lines).toEqual(lines);
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLogger();
  tempDirs.cleanup();
});

it("redacts raw auth headers before returning log lines", async () => {
  const headers = [
    ["Authorization: Basic c2VjcmV0OnBhc3M=", "Authorization: Basic ***"],
    ["X-OpenClaw-Token: supersecretgatewaytoken1234567890", "X-OpenClaw-Token: supers…7890"],
    [
      "x-pomerium-jwt-assertion: eyJheaderabcd.eyJpayloadabcd.signatureabcd123456",
      "x-pomerium-jwt-assertion: eyJhea…3456",
    ],
    ["normal diagnostic line", "normal diagnostic line"],
  ] as const;
  await seed(headers.map(([raw]) => raw).join("\n") + "\n");
  await tail(
    headers.map(([, redacted]) => redacted),
    { limit: 10 },
  );
});

it("redacts raw JSON credentials and default tokens with custom tail patterns", async () => {
  const raw =
    JSON.stringify({
      password: 1234,
      apiKey: false,
      signature: "short-signature",
      nested: { "x-pomerium-jwt-assertion": "opaque-header" },
      message: "sk-syntheticcredential123456 CUSTOM_VALUE",
      ordinary: "request completed",
    }) + "\n";
  await seed(raw, { redactPatterns: ["CUSTOM_VALUE"] });
  const result = await readConfiguredLogTail();
  assert(result.lines[0] !== undefined);
  expect(JSON.parse(result.lines[0])).toMatchObject({
    password: "***",
    apiKey: "***",
    signature: "***",
    nested: { "x-pomerium-jwt-assertion": "***" },
    ordinary: "request completed",
    message: expect.stringMatching(/^(?!.*(?:sk-syntheticcredential123456|CUSTOM_VALUE)).*$/su),
  });
  expect(result.cursor).toBe(Buffer.byteLength(raw));
  expect(await fs.readFile(file, "utf8")).toBe(raw);
});

it.each([false, true])("keeps cold and incremental PEM context (closed=%s)", async (closed) => {
  const prefix = pemBegin + "earlier body\n" + (closed ? pemEnd : "");
  await seed(prefix + "older line\n".repeat(2000) + "cold line\n");
  const cold = await tail(closed ? ["cold line"] : masked, { limit: 1, maxBytes: 64 });
  await fs.appendFile(file, "incremental line\n");
  const incremental = await tail(closed ? ["incremental line"] : masked, {
    cursor: cold.cursor,
    maxBytes: 64,
  });
  expect(incremental.cursor).toBe((await fs.stat(file)).size);
});

it("tracks filtered openers and closes between the anchor and selection", async () => {
  await seed("ordinary line\n");
  const initial = await readConfiguredLogTail();
  await fs.appendFile(file, pemBegin + "hidden body\n");
  const hidden = await tail([], { cursor: initial.cursor }, () => false);
  await fs.appendFile(file, "visible body\n");
  const body = await tail(masked, { cursor: hidden.cursor });
  await fs.appendFile(file, pemEnd + "ordinary after close\n");
  const closed = await tail(["ordinary after close"], { cursor: body.cursor, limit: 1 });
  await fs.appendFile(file, "still ordinary\n");
  await tail(["still ordinary"], { cursor: closed.cursor });
});

it("waits for complete records before caching partial PEM delimiters", async () => {
  const complete = "ordinary line 🦞\n";
  await seed(complete + "-----BEGIN PRI");
  const initial = await tail(["ordinary line 🦞"]);
  expect(initial.cursor).toBe(Buffer.byteLength(complete));
  await fs.appendFile(file, "VATE KEY-----\nfirst body\n");
  const opened = await tail(masked, { cursor: initial.cursor, limit: 1 });
  await fs.appendFile(file, "next body\n-----END PRI");
  const partialClose = await tail(masked, { cursor: opened.cursor });
  await fs.appendFile(file, "VATE KEY-----\nordinary again\n");
  await tail(["ordinary again"], { cursor: partialClose.cursor, limit: 1 });
});

it.each(["rotation", "truncation", "empty poll"] as const)(
  "discards PEM state after %s",
  async (change) => {
    await seed("old ordinary line\n".repeat(1000));
    const initial = await readConfiguredLogTail({ limit: 1 });
    if (change === "rotation") {
      await fs.rename(file, `${file}.retired`);
    } else if (change === "empty poll") {
      await fs.truncate(file, 0);
      expect(await tail([], { cursor: initial.cursor })).toMatchObject({ cursor: 0, reset: true });
    }
    // Rotation/regrowth exceeds the old offset; truncation stays below it.
    await fs.writeFile(
      file,
      pemBegin + "new body line\n".repeat(change === "truncation" ? 100 : 2000),
    );
    const replacement = await tail(masked, { limit: 1, maxBytes: 64 });
    await fs.appendFile(file, pemEnd + "ordinary replacement\n");
    await tail(["ordinary replacement"], { cursor: replacement.cursor, limit: 1 });
  },
);

it("does not carry an open PEM block into another configured file", async () => {
  await seed(pemBegin + "private body\n");
  await tail(masked, { limit: 1 });
  const otherFile = `${file}.other`;
  await fs.writeFile(otherFile, "ordinary line\n".repeat(100));
  setLoggerOverride({ file: otherFile });
  await tail(["ordinary line"], { limit: 1, maxBytes: 64 });
});

it("uses the opened inode when rotation follows metadata sampling", async () => {
  await seed("old ordinary line\n".repeat(1000));
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
  await tail(masked, { cursor: initial.cursor, limit: 1 });
  expect(rotated).toBe(true);
});
