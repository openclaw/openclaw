import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createManagedChildStdin } from "./child-stdin.js";

it("delivers remote EOF once when shutdown callers overlap", () => {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const end = vi.fn();
  const stdin = createManagedChildStdin(stream, end)!;
  try {
    stdin.end();
    stdin.end();
    expect(end).toHaveBeenCalledOnce();
  } finally {
    stream.destroy();
  }
});

it("reports a closed write separately from the queued stream failure", async () => {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const onError = vi.fn();
  const stdin = createManagedChildStdin(stream, undefined, onError)!;
  const onWrite = vi.fn();
  const closed = new Promise<void>((resolve) => {
    stream.once("close", resolve);
  });

  stdin.destroy!();
  stdin.write("late input", onWrite);
  await closed;

  expect(onWrite).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "EPIPE" }));
  expect(onError).toHaveBeenCalledTimes(2);
  expect(onError.mock.calls[0]?.[0]).toBe(onWrite.mock.calls[0]?.[0]);
  expect(onError).toHaveBeenNthCalledWith(2, expect.objectContaining({ code: "EPIPE" }));
});

it.each(["ECANCELED", "ERR_STREAM_DESTROYED", "EIO"])(
  "preserves remote pipe closure when buffered writes fail with %s",
  async (code) => {
    const failure = Object.assign(new Error("buffered write failed"), { code });
    let completeWrite: (error?: Error | null) => void = () => {};
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
      destroy(error, callback) {
        completeWrite(failure);
        callback(error);
      },
    });
    const notifications: string[] = [];
    const onError = vi.fn(() => notifications.push("error"));
    const stdin = createManagedChildStdin(stream, undefined, onError)!;
    const onWrite = vi.fn(() => notifications.push("write"));
    stdin.write("pending", onWrite);
    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stdin.destroy!();
    await closed;

    expect(onWrite).toHaveBeenCalledWith(
      code === "EIO" ? failure : expect.objectContaining({ code: "EPIPE" }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EPIPE" }));
    expect(notifications).toEqual(["write", "error"]);
  },
);
