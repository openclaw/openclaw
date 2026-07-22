// Covers file identity comparison across platform stat shapes.
import { describe, expect, it } from "vitest";
import { sameFileIdentity } from "./fs-safe-advanced.js";

type FileIdentityStat = Parameters<typeof sameFileIdentity>[0];

function stat(dev: number | bigint, ino: number | bigint): FileIdentityStat {
  return { dev, ino };
}

describe("sameFileIdentity", () => {
  it.each([
    {
      name: "accepts exact dev+ino match",
      left: stat(7, 11),
      right: stat(7, 11),
      platform: "linux" as const,
      expected: true,
    },
    {
      name: "rejects inode mismatch",
      left: stat(7, 11),
      right: stat(7, 12),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "rejects dev mismatch on non-windows",
      left: stat(7, 11),
      right: stat(8, 11),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "keeps dev strictness on linux when one side is zero",
      left: stat(0, 11),
      right: stat(8, 11),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "accepts win32 dev mismatch when either side is 0",
      left: stat(0, 11),
      right: stat(8, 11),
      platform: "win32" as const,
      expected: true,
    },
    {
      name: "accepts win32 dev mismatch when right side is 0",
      left: stat(7, 11),
      right: stat(0, 11),
      platform: "win32" as const,
      expected: true,
    },
    {
      name: "keeps dev strictness on win32 when both dev values are non-zero",
      left: stat(7, 11),
      right: stat(8, 11),
      platform: "win32" as const,
      expected: false,
    },
    {
      name: "handles bigint stats",
      left: stat(0n, 11n),
      right: stat(8n, 11n),
      platform: "win32" as const,
      expected: true,
    },
    {
      // 72057594037932382n and 72057594037932383n both round to 72057594037932380
      // when represented as a JS Number (> 2^53), so fs.statSync() without
      // {bigint: true} incorrectly treats them as the same inode.  The fix in
      // resolveSessionStorePathRelationship passes {bigint: true} so the full
      // precision is preserved.  This test documents the correct behavior that
      // the fix enables (#112341 — virtiofs/Kata inode precision).
      name: "rejects adjacent inodes above 2^53 when both stats use BigInt (virtiofs/Kata, issue #112341)",
      left: stat(2n, 72057594037932382n),
      right: stat(2n, 72057594037932383n),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "accepts same inode above 2^53 when both stats use BigInt",
      left: stat(2n, 72057594037932382n),
      right: stat(2n, 72057594037932382n),
      platform: "linux" as const,
      expected: true,
    },
  ])("$name", ({ left, right, platform, expected }) => {
    expect(sameFileIdentity(left, right, platform)).toBe(expected);
  });
});
