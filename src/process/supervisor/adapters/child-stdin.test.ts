import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createManagedChildStdin } from "./child-stdin.js";

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
