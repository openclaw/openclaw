import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createFileWatchNotifier } from "./file-watch-notifier.js";

function fixture(onWrite?: () => void) {
  const entered = createDeferred();
  const lines: string[] = [];
  let blocked = true;
  let callback: ((error?: Error | null) => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as string);
      callback = done;
      entered.resolve();
      onWrite?.();
      if (!blocked) {
        callback = undefined;
        done();
      }
    },
  });
  const failed = vi.fn();
  const writer = createFileWatchNotifier(output, failed);
  const resume = () => {
    blocked = false;
    const done = callback;
    callback = undefined;
    done?.();
  };
  return {
    writer,
    output,
    entered,
    lines,
    failed,
    resume,
    fail: (error: Error) => {
      const done = callback;
      callback = undefined;
      done?.(error);
    },
  };
}

it("bounds blocked notification bursts and preserves the last availability ordering", async () => {
  const f = fixture();
  try {
    f.writer.send("change");
    await f.entered.promise;
    for (let i = 0; i < 1000; i++) {
      f.writer.send("unavailable");
      f.writer.send("available");
      f.writer.send("change");
    }
    expect(f.output.writableNeedDrain).toBe(true);
    expect(f.output.writableLength).toBe(Buffer.byteLength('"change"\n'));
    let done = false;
    const closed = f.writer.close().then(() => {
      done = true;
    });
    expect(f.writer.close()).toBe(f.writer.close());
    await Promise.resolve();
    expect(done).toBe(false);
    f.writer.send("unavailable"); // Retired producers cannot append more work.
    f.resume();
    await closed;
    expect(f.lines).toEqual(["change", "unavailable", "available", "change"]);
    expect(f.output.writableLength).toBe(0);
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.output.listenerCount("error")).toBe(0);
    expect(f.output.listenerCount("close")).toBe(0);
  } finally {
    f.resume();
    await f.writer.close();
    f.output.destroy();
  }
});

it.each(["callback", "close", "error"] as const)(
  "retains %s output failure and completes retirement",
  async (kind) => {
    const f = fixture();
    const failure = new Error("output failed");
    try {
      f.writer.send("change");
      await f.entered.promise;
      const closing = f.writer.close();
      const rejected = expect(closing).rejects.toThrow(
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
    } finally {
      f.resume();
      await f.writer.close().catch(() => {});
      f.output.destroy();
    }
  },
);

it("publishes a stable close join before output-write shutdown reentry", async () => {
  let reentered: Promise<void> | undefined;
  const f = fixture(() => {
    reentered = f.writer.close();
  });
  try {
    f.writer.send("change");
    await f.entered.promise;
    expect(reentered).toBe(f.writer.close());
    f.writer.send("available");
    f.resume();
    await reentered;
    expect(f.lines).toEqual(["change"]);
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.output.listenerCount("finish")).toBe(0);
  } finally {
    f.resume();
    await f.writer.close();
    f.output.destroy();
  }
});
