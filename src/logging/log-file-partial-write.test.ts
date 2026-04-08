import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-log-partial-write-");

// Helper: spy on fs.writeSync and intercept only Buffer-based calls (our appendLogLine path).
// The interceptor receives (fd, buf, offset, length) and returns the number of bytes to report
// as written; the real write of that many bytes is issued first so the fd stays consistent.
function spyWriteSync(
  interceptor: (fd: number, buf: Buffer, offset: number, length: number) => number,
): ReturnType<typeof vi.spyOn> {
  const real = fs.writeSync.bind(fs);
  return vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    bufOrStr: NodeJS.ArrayBufferView | string,
    offsetOrPos?: number | null,
    lengthOrEnc?: number | BufferEncoding | null,
    _pos?: number | null,
  ): number => {
    if (Buffer.isBuffer(bufOrStr)) {
      const offset = offsetOrPos ?? 0;
      const length = (lengthOrEnc as number | null | undefined) ?? bufOrStr.byteLength - offset;
      return interceptor(fd, bufOrStr, offset, length);
    }
    type WriteSyncStr = (
      fd: number,
      str: string,
      pos?: number | null,
      enc?: BufferEncoding | null,
    ) => number;
    return (real as unknown as WriteSyncStr)(
      fd,
      bufOrStr as string,
      offsetOrPos,
      lengthOrEnc as BufferEncoding | null | undefined,
    );
  }) as typeof fs.writeSync);
}

describe("appendLogLine partial-write loop", () => {
  let logPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    logPath = logPathTracker.nextPath();
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("retries until all bytes are written when writeSync returns a short count", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 1024 * 1024 });
    const logger = getLogger();

    const real = fs.writeSync.bind(fs);
    let firstCall = true;

    spyWriteSync((fd, buf, offset, length) => {
      if (firstCall) {
        firstCall = false;
        // Write only the first half; the loop must issue a second call for the rest.
        const half = Math.max(1, Math.floor(length / 2));
        real(fd, buf, offset, half);
        return half;
      }
      return real(fd, buf, offset, length);
    });

    logger.error("partial-write-sentinel");

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("partial-write-sentinel");
    // Confirm the entry is a valid complete JSON line (not truncated mid-record).
    const line = content.trim().split("\n").at(-1) ?? "";
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("returns false and leaves the byte counter unchanged when writeSync returns 0", () => {
    // Cap must be large enough for a single serialised tslog JSON line to pass the pre-write
    // nextBytes check, but small enough that 20 incorrectly-accumulated lines would exceed it.
    // Typical tslog JSON line: ~600–900 bytes; 20 × 900 = 18 000 bytes, so 8 KB is a safe band.
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 8192 });
    const logger = getLogger();

    spyWriteSync((_fd, _buf, _offset, _length) => 0);

    for (let i = 0; i < 20; i++) {
      logger.error(`zero-write-${i}-${"x".repeat(40)}`);
    }

    vi.restoreAllMocks();

    // Nothing should have landed on disk during the blocked phase.
    const sizeWhileBlocked = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    expect(sizeWhileBlocked).toBe(0);

    // With the byte counter still at 0, the cap must not fire on the next write.
    logger.error("after-restore-sentinel");
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("after-restore-sentinel");
  });
});
