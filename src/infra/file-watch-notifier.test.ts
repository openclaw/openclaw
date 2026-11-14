import { Writable } from "node:stream";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createFileWatchNotifier } from "./file-watch-notifier.js";

function fixture(onWrite?: () => void) {
  const entered = createDeferred();
  const drain = createDeferred<Error | undefined>();
  const lines: string[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as string);
      void drain.promise.then(done);
      entered.resolve();
      onWrite?.();
    },
  });
  const failed = vi.fn();
  const writer = createFileWatchNotifier(output, failed);
  const resume = () => drain.resolve(undefined);
  onTestFinished(async () => {
    resume();
    await writer.close().catch(() => {}); // Every test asserts its close outcome before cleanup.
    output.destroy();
  });
  return { writer, output, entered, lines, failed, resume, fail: drain.resolve };
}

it("bounds blocked notification bursts and preserves the last availability ordering", async () => {
  const f = fixture();
  f.writer.send("change");
  await f.entered.promise;
  for (let i = 0; i < 1000; i++) {
    f.writer.send("unavailable");
    f.writer.send("available");
    f.writer.send("change");
  }
  const settled = vi.fn();
  const closed = f.writer.close().then(settled);
  expect(f.writer.close()).toBe(f.writer.close());
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  f.writer.send("unavailable"); // Retired producers cannot append more work.
  f.resume();
  await closed;
  expect(f.lines).toEqual(["change", "unavailable", "available", "change"]);
  expect(f.failed).not.toHaveBeenCalled();
  expect(["error", "close"].map((event) => f.output.listenerCount(event))).toEqual([0, 0]);
});

it.each(["callback", "close", "error"] as const)("retires after %s failure", async (kind) => {
  const f = fixture();
  const failure = new Error("output failed");
  f.writer.send("change");
  await f.entered.promise;
  const rejected = expect(f.writer.close()).rejects.toThrow(
    kind === "close" ? "closed before notification retirement" : "output failed",
  );
  if (kind === "callback") {
    f.fail(failure);
  } else {
    f.output.destroy(kind === "error" ? failure : undefined);
  }
  await rejected;
  expect(f.failed).toHaveBeenCalledOnce();
  await expect(f.writer.close()).rejects.toThrow();
  expect(f.output.listenerCount("error")).toBe(0);
});

it("publishes a stable close join before output-write shutdown reentry", async () => {
  let reentered: Promise<void> | undefined;
  const f = fixture(() => {
    reentered = f.writer.close();
  });
  f.writer.send("change");
  await f.entered.promise;
  expect(reentered).toBe(f.writer.close());
  f.writer.send("available");
  f.resume();
  await reentered;
  expect(f.lines).toEqual(["change"]);
  expect(f.failed).not.toHaveBeenCalled();
  expect(f.output.listenerCount("finish")).toBe(0);
});
