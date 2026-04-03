import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSafeStreamWriter } from "./stream-writer.js";

describe("createSafeStreamWriter", () => {
  it("signals broken pipes and closes the writer", () => {
    const onBrokenPipe = vi.fn();
    const writer = createSafeStreamWriter({ onBrokenPipe });
    const stream = {
      write: vi.fn(() => {
        const err = new Error("EPIPE") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        throw err;
      }),
    } as unknown as NodeJS.WriteStream;

    expect(writer.writeLine(stream, "hello")).toBe(false);
    expect(writer.isClosed()).toBe(true);
    expect(onBrokenPipe).toHaveBeenCalledTimes(1);

    onBrokenPipe.mockClear();
    expect(writer.writeLine(stream, "again")).toBe(false);
    expect(onBrokenPipe).toHaveBeenCalledTimes(0);
  });

  it("treats broken pipes from beforeWrite as closed", () => {
    const onBrokenPipe = vi.fn();
    const writer = createSafeStreamWriter({
      onBrokenPipe,
      beforeWrite: () => {
        const err = new Error("EIO") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      },
    });
    const stream = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;

    expect(writer.write(stream, "hi")).toBe(false);
    expect(writer.isClosed()).toBe(true);
    expect(onBrokenPipe).toHaveBeenCalledTimes(1);
  });

  describe("writeAsync / writeLineAsync (backpressure)", () => {
    it("resolves immediately when stream.write returns true (buffer not full)", async () => {
      const writer = createSafeStreamWriter();
      const writeFn = vi.fn(() => true);
      const stream = { write: writeFn } as unknown as NodeJS.WriteStream;

      const result = await writer.writeAsync(stream, "hello");
      expect(result).toBe(true);
      expect(writeFn).toHaveBeenCalledWith("hello");
    });

    it("awaits drain when stream.write returns false (buffer full)", async () => {
      const writer = createSafeStreamWriter();
      const emitter = new EventEmitter();
      let writeCount = 0;
      const writeFn = vi.fn(() => ++writeCount > 1);
      const stream = {
        write: writeFn,
        once: (event: string, cb: () => void) => emitter.once(event, cb),
      } as unknown as NodeJS.WriteStream;

      // Start the async write — it should block waiting for drain
      const promise = writer.writeAsync(stream, "hello");

      // Emit drain to unblock
      emitter.emit("drain");

      const result = await promise;
      expect(result).toBe(true);
      expect(writeFn).toHaveBeenCalledWith("hello");
    });

    it("returns false immediately when closed", async () => {
      const writer = createSafeStreamWriter();
      const writeFn = vi.fn(() => true);
      const stream = { write: writeFn } as unknown as NodeJS.WriteStream;

      // Close via broken pipe
      const brokenStream = {
        write: vi.fn(() => {
          const err = new Error("EPIPE") as NodeJS.ErrnoException;
          err.code = "EPIPE";
          throw err;
        }),
      } as unknown as NodeJS.WriteStream;
      writer.write(brokenStream, "trigger close");
      expect(writer.isClosed()).toBe(true);

      const result = await writer.writeAsync(stream, "after close");
      expect(result).toBe(false);
      // stream.write should NOT have been called after close
      expect(writeFn).not.toHaveBeenCalled();
    });

    it("writeLineAsync appends newline and awaits drain", async () => {
      const writer = createSafeStreamWriter();
      const writeFn = vi.fn(() => true);
      const stream = { write: writeFn } as unknown as NodeJS.WriteStream;

      const result = await writer.writeLineAsync(stream, "a line");
      expect(result).toBe(true);
      expect(writeFn).toHaveBeenCalledWith("a line\n");
    });

    it("handles EPIPE in writeAsync and closes the writer", async () => {
      const onBrokenPipe = vi.fn();
      const writer = createSafeStreamWriter({ onBrokenPipe });
      const stream = {
        write: vi.fn(() => {
          const err = new Error("EPIPE") as NodeJS.ErrnoException;
          err.code = "EPIPE";
          throw err;
        }),
      } as unknown as NodeJS.WriteStream;

      const result = await writer.writeAsync(stream, "boom");
      expect(result).toBe(false);
      expect(writer.isClosed()).toBe(true);
      expect(onBrokenPipe).toHaveBeenCalledTimes(1);
    });
  });
});
