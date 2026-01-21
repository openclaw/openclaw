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
});
