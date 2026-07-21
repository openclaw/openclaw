import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PhaseRunner } from "../../../scripts/e2e/parallels/phase-runner.ts";

const REPLACEMENT_CHARACTER = "�";

describe("PhaseRunner log tail UTF-8 safety", () => {
  it("skips leading continuation bytes when tail truncation starts inside a multibyte character", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-runner-utf8-"));
    try {
      // maxBytes=60 → marker≈44 bytes → tailBytes=16
      // Combined = 40 x 'a' + '你好世界' (12 bytes) + 8 x 'b' + '\n' = 61 bytes
      // 61 > 60 triggers truncation.
      // subarray(-16) starts at byte 45 = 0xBD (continuation byte of 你 3rd byte).
      const runner = new PhaseRunner(dir, 60);
      runner.append("a".repeat(40) + "你好世界" + "b".repeat(8));

      const tail = (runner as unknown as { logTail: string }).logTail;
      expect(tail).not.toContain(REPLACEMENT_CHARACTER);
      // Verify the multibyte content following the cut is preserved.
      expect(tail).toContain("世界");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes through ASCII-only tails unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-runner-ascii-"));
    try {
      const runner = new PhaseRunner(dir, 60);
      runner.append("hello world");
      runner.append("another line");

      const tail = (runner as unknown as { logTail: string }).logTail;
      expect(tail).toContain("hello world");
      expect(tail).not.toContain(REPLACEMENT_CHARACTER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps tail within the configured byte budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-runner-budget-"));
    try {
      const runner = new PhaseRunner(dir, 100);
      runner.append("x".repeat(200));

      const tail = (runner as unknown as { logTail: string }).logTail;
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
