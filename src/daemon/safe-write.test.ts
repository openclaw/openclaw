import { describe, expect, it, vi } from "vitest";
import { safeWrite, safeWriteLine } from "./safe-write.js";

describe("safe-write", () => {
  describe("safeWrite", () => {
    it("writes to stream successfully", () => {
      const mockWrite = vi.fn();
      const stream = { write: mockWrite } as unknown as NodeJS.WritableStream;

      const result = safeWrite(stream, "hello");

      expect(result).toBe(true);
      expect(mockWrite).toHaveBeenCalledWith("hello");
    });

    it("returns false and suppresses EPIPE errors", () => {
      const epipeError = new Error("write EPIPE") as NodeJS.ErrnoException;
      epipeError.code = "EPIPE";

      const stream = {
        write: vi.fn().mockImplementation(() => {
          throw epipeError;
        }),
      } as unknown as NodeJS.WritableStream;

      const result = safeWrite(stream, "hello");

      expect(result).toBe(false);
    });

    it("returns false and suppresses EIO errors", () => {
      const eioError = new Error("write EIO") as NodeJS.ErrnoException;
      eioError.code = "EIO";

      const stream = {
        write: vi.fn().mockImplementation(() => {
          throw eioError;
        }),
      } as unknown as NodeJS.WritableStream;

      const result = safeWrite(stream, "hello");

      expect(result).toBe(false);
    });

    it("rethrows non-pipe errors", () => {
      const otherError = new Error("something else") as NodeJS.ErrnoException;
      otherError.code = "ENOENT";

      const stream = {
        write: vi.fn().mockImplementation(() => {
          throw otherError;
        }),
      } as unknown as NodeJS.WritableStream;

      expect(() => safeWrite(stream, "hello")).toThrow("something else");
    });
  });

  describe("safeWriteLine", () => {
    it("appends newline if not present", () => {
      const mockWrite = vi.fn();
      const stream = { write: mockWrite } as unknown as NodeJS.WritableStream;

      safeWriteLine(stream, "hello");

      expect(mockWrite).toHaveBeenCalledWith("hello\n");
    });

    it("does not double newline", () => {
      const mockWrite = vi.fn();
      const stream = { write: mockWrite } as unknown as NodeJS.WritableStream;

      safeWriteLine(stream, "hello\n");

      expect(mockWrite).toHaveBeenCalledWith("hello\n");
    });

    it("handles EPIPE gracefully", () => {
      const epipeError = new Error("write EPIPE") as NodeJS.ErrnoException;
      epipeError.code = "EPIPE";

      const stream = {
        write: vi.fn().mockImplementation(() => {
          throw epipeError;
        }),
      } as unknown as NodeJS.WritableStream;

      const result = safeWriteLine(stream, "hello");

      expect(result).toBe(false);
    });
  });
});
