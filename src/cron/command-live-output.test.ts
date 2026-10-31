import { afterEach, describe, expect, it } from "vitest";
import { beginCronCommandLiveOutput, readCronCommandLiveOutput } from "./command-live-output.js";
import { runCronCommandJob } from "./command-runner.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";

// Mirrors the documented 256 KiB cap.
const MAX_BYTES = 256 * 1024;
const open: Array<() => void> = [];
function begin(maxBytes?: number, runAtMs = 1000) {
  const live = beginCronCommandLiveOutput({ jobId: "job", runAtMs, outputMaxBytes: maxBytes });
  open.push(() => live.end());
  return live;
}
const bytes = (text: string) => Buffer.from(text);
afterEach(() => open.splice(0).forEach((end) => end()));

describe("cron command live output buffer", () => {
  it("reports inactive jobs without a buffer", () => {
    expect(readCronCommandLiveOutput("missing")).toEqual({ active: false, cursor: 0, text: "" });
  });

  it("follows by cursor without losing or repeating lines across reads", () => {
    const live = begin();
    live.append(bytes("one\ntwo\npart"));
    const first = readCronCommandLiveOutput("job");
    expect(first).toMatchObject({ active: true, runAtMs: 1000, text: "one\ntwo\n", reset: true });
    // The partial line stays pending until its newline arrives.
    live.append(bytes("ial\nthree\n"));
    const second = readCronCommandLiveOutput("job", { cursor: first.cursor, runAtMs: 1000 });
    expect(second.text).toBe("partial\nthree\n");
    expect(second.reset).toBeUndefined();
    // A reconnect that resends the older cursor gets the same text, not a gap or a duplicate.
    expect(readCronCommandLiveOutput("job", { cursor: first.cursor, runAtMs: 1000 })).toEqual(
      second,
    );
    expect(
      readCronCommandLiveOutput("job", { cursor: second.cursor, runAtMs: 1000 }),
    ).toMatchObject({ text: "", cursor: second.cursor });
  });

  it("drops the oldest bytes at the cap and resets a cursor that fell behind", () => {
    const live = begin(32);
    live.append(bytes("aaaaaaaa\n"));
    const first = readCronCommandLiveOutput("job");
    for (let i = 0; i < 10; i += 1) {
      live.append(bytes(`line-${i}\n`));
    }
    const behind = readCronCommandLiveOutput("job", { cursor: first.cursor, runAtMs: 1000 });
    expect(behind.reset).toBe(true);
    expect(behind.truncated).toBe(true);
    expect(Buffer.byteLength(behind.text)).toBeLessThanOrEqual(32);
    expect(behind.text.endsWith("line-9\n")).toBe(true);
    expect(behind.text).not.toContain("aaaa");
  });

  it("never retains more than the shared cap even for one huge chunk", () => {
    const live = begin();
    live.append(Buffer.alloc(MAX_BYTES * 3, "x\n"));
    const read = readCronCommandLiveOutput("job");
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(MAX_BYTES);
    expect(read.truncated).toBe(true);
  });

  it("honors a smaller payload outputMaxBytes", () => {
    const live = begin(10);
    live.append(bytes("0123456789abcdef\n"));
    expect(Buffer.byteLength(readCronCommandLiveOutput("job").text)).toBeLessThanOrEqual(10);
  });

  it("does not split a multi-byte character when the head is trimmed", () => {
    const live = begin(7);
    live.append(bytes("\u00e9\u00e9\u00e9\u00e9\n"));
    const read = readCronCommandLiveOutput("job");
    expect(read.text).not.toContain("\ufffd");
    expect(read.text.endsWith("\n")).toBe(true);
  });

  it("flushes an overlong partial line without cutting a character", () => {
    const live = begin();
    live.append(bytes("\u00e9".repeat(3000)));
    live.append(Buffer.from([0xc3]));
    const read = readCronCommandLiveOutput("job");
    expect(read.text).toBe("\u00e9".repeat(3000));
    expect(read.text).not.toContain("\ufffd");
    live.append(Buffer.from([0xa9, 0x0a]));
    expect(readCronCommandLiveOutput("job", { cursor: read.cursor, runAtMs: 1000 }).text).toBe(
      "\u00e9\n",
    );
  });

  it("treats a different run as a reset", () => {
    begin(undefined, 2000).append(bytes("new run\n"));
    const read = readCronCommandLiveOutput("job", { cursor: 3, runAtMs: 1000 });
    expect(read).toMatchObject({ active: true, runAtMs: 2000, reset: true, text: "new run\n" });
  });

  it("redacts secrets and strips terminal escapes and controls on read", () => {
    const live = begin();
    live.append(
      bytes(
        "\u001b[31mred\u001b[0m\rprogress\u0007\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789\n",
      ),
    );
    const { text } = readCronCommandLiveOutput("job");
    expect(text).toContain("red\nprogress\n");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });

  it("masks a private key across reads, including one whose opener was trimmed", () => {
    const live = begin();
    live.append(bytes("-----BEGIN PRIVATE KEY-----\nline1Z9Z9\n"));
    const first = readCronCommandLiveOutput("job");
    live.append(bytes("line2Z9Z9\n-----END PRIVATE KEY-----\nafter\n"));
    const second = readCronCommandLiveOutput("job", { cursor: first.cursor, runAtMs: 1000 });
    expect(first.text + second.text).not.toContain("Z9Z9");
    expect(second.text).toContain("after");

    const trimmed = begin(64);
    trimmed.append(
      bytes(
        "-----BEGIN PRIVATE KEY-----\nline1Z9Z9\nline2Z9Z9\nline3Z9Z9\n-----END PRIVATE KEY-----\nok\n",
      ),
    );
    const tail = readCronCommandLiveOutput("job");
    expect(tail.truncated).toBe(true);
    expect(tail.text).not.toContain("Z9Z9");
    expect(tail.text).toContain("ok");
  });

  it("keeps masking a key whose opener left the ring, even one the trim split", () => {
    const live = begin(64);
    live.append(bytes(`-----BEGIN PRIVATE KEY-----\n${"keyZ9Z9\n".repeat(8)}`));
    const first = readCronCommandLiveOutput("job");
    expect(first.truncated).toBe(true);
    expect(first.text).not.toContain("Z9Z9");
    live.append(bytes("lastZ9Z9\n-----END PRIVATE KEY-----\nafter\n"));
    const second = readCronCommandLiveOutput("job", { cursor: first.cursor, runAtMs: 1000 });
    expect(second.text).not.toContain("Z9Z9");
    expect(second.text).toContain("after");

    const split = begin(40);
    split.append(bytes("-----BEGIN PRIVATE KEY-----\nk1Z9Z9\nk2Z9Z9\n"));
    expect(readCronCommandLiveOutput("job").text).not.toContain("Z9Z9");
  });

  it("holds no more than the cap however many large chunks pass through", () => {
    const live = begin();
    const chunk = Buffer.alloc(64 * 1024, "x\n");
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 500; i += 1) {
      live.append(chunk);
    }
    // Keeping dropped chunks alive would hold about 32 MiB here.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(4 * 1024 * 1024);
  });

  it("discards the buffer on end and ignores a stale owner", () => {
    const stale = begin();
    stale.append(bytes("old\n"));
    const current = beginCronCommandLiveOutput({ jobId: "job", runAtMs: 5 });
    stale.end();
    expect(readCronCommandLiveOutput("job").runAtMs).toBe(5);
    current.end();
    expect(readCronCommandLiveOutput("job").active).toBe(false);
  });
});

describe("runCronCommandJob live output", () => {
  const job = (script: string, extra: Record<string, unknown> = {}) =>
    cronTestJob({
      id: "live-job",
      payload: { kind: "command", argv: [process.execPath, "-e", script], ...extra },
      state: { runningAtMs: 4242 },
    });

  it("exposes output while running and discards it when the command finishes", async () => {
    const run = runCronCommandJob({
      job: job(
        "console.log('first'); console.error('warn'); setTimeout(() => console.log('second'), 400);",
      ),
    });
    let seen = "";
    for (let i = 0; i < 100 && !seen.includes("warn"); i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      seen = readCronCommandLiveOutput("live-job").text;
    }
    expect(seen).toContain("first");
    expect(seen).toContain("warn");
    expect(readCronCommandLiveOutput("live-job").runAtMs).toBe(4242);
    const result = await run;
    expect(result.status).toBe("ok");
    expect(readCronCommandLiveOutput("live-job").active).toBe(false);
  });

  it("discards the buffer after a timeout, an abort, and a spawn failure", async () => {
    const slow = "console.log('tick'); setInterval(() => {}, 1000);";
    const timedOut = await runCronCommandJob({ job: job(slow, { timeoutSeconds: 1 }) });
    expect(timedOut.status).toBe("error");
    expect(readCronCommandLiveOutput("live-job").active).toBe(false);

    const controller = new AbortController();
    const aborted = runCronCommandJob({ job: job(slow), abortSignal: controller.signal });
    for (let i = 0; i < 100 && !readCronCommandLiveOutput("live-job").text; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    controller.abort();
    expect((await aborted).status).toBe("error");
    expect(readCronCommandLiveOutput("live-job").active).toBe(false);

    const missing = await runCronCommandJob({
      job: cronTestJob({
        id: "live-job",
        payload: { kind: "command", argv: ["/nonexistent/openclaw-live-output-test"] },
      }),
    });
    expect(missing.status).toBe("error");
    expect(readCronCommandLiveOutput("live-job").active).toBe(false);
  }, 30_000);

  it("keeps the recorded summary the same as before the live tail existed", async () => {
    const result = await runCronCommandJob({ job: job("console.log('done')") });
    expect(result).toMatchObject({ status: "ok", summary: "done" });
  });
});
