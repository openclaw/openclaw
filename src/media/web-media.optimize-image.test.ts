import { describe, expect, it, vi } from "vitest";

// Mock image-ops so we can drive the resize loop deterministically without
// pulling in sharp or any real image bytes. The test below covers two
// regression cases for `optimizeImageToJpeg`:
//
// 1. When every size/quality combination fails, the thrown error must
//    surface the underlying cause and attempt counters so an operator can
//    tell whether the source format was unsupported, sharp wasn't available,
//    the buffer was unreadable, etc. Previously the catch was silent and
//    the outer "Failed to optimize image" gave no clue why.
// 2. When some resize calls succeed but every output stays above maxBytes,
//    the function still returns the smallest buffer it found and does NOT
//    throw — that is the documented size-budget contract.
vi.mock("./image-ops.js", () => {
  return {
    isHeicSource: vi.fn(() => false),
    convertHeicToJpeg: vi.fn(async (buf: Buffer) => buf),
    resizeToJpeg: vi.fn(),
  };
});

const imageOps = await import("./image-ops.js");
const { optimizeImageToJpeg } = await import("./web-media.js");

describe("optimizeImageToJpeg", () => {
  it("surfaces the underlying resize failure when every attempt throws", async () => {
    const sharpFailure = new Error("sharp: Input buffer contains unsupported image format");
    vi.mocked(imageOps.resizeToJpeg).mockRejectedValue(sharpFailure);

    const buffer = Buffer.from("not-an-image");
    await expect(optimizeImageToJpeg(buffer, 1024)).rejects.toThrowError(
      /Failed to optimize image \(resize attempts=\d+, failures=\d+\): .*unsupported image format/,
    );

    // Verify the original error is preserved as `cause` so callers can
    // unwrap it for richer error reporting upstream.
    let captured: unknown;
    try {
      await optimizeImageToJpeg(buffer, 1024);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error & { cause?: unknown }).cause).toBe(sharpFailure);
  });

  it("returns the smallest produced buffer when no attempt fits maxBytes", async () => {
    // Each call returns a buffer larger than the requested 100-byte budget
    // so the function falls through the inner `return` and ends up using
    // the smallest of the produced buffers. This must NOT throw \u2014 the
    // size-budget overflow case is recoverable, not a hard failure.
    const sizes = [5000, 4000, 3000, 2500, 2000];
    let i = 0;
    vi.mocked(imageOps.resizeToJpeg).mockImplementation(async () => {
      const next = sizes[Math.min(i, sizes.length - 1)];
      i += 1;
      return Buffer.alloc(next, 0);
    });

    const result = await optimizeImageToJpeg(Buffer.alloc(10_000, 0), 100);
    expect(result.optimizedSize).toBeLessThanOrEqual(5000);
    // 2000 is the smallest the mock will produce, so the loop should
    // converge there regardless of iteration order.
    expect(result.buffer.length).toBe(2000);
  });

  it("returns the first buffer that fits maxBytes and does not iterate further", async () => {
    let calls = 0;
    vi.mocked(imageOps.resizeToJpeg).mockImplementation(async () => {
      calls += 1;
      // First attempt already fits the budget.
      return Buffer.alloc(50, 0);
    });

    const result = await optimizeImageToJpeg(Buffer.alloc(10_000, 0), 100);
    expect(result.optimizedSize).toBe(50);
    expect(calls).toBe(1);
  });
});
