import { describe, expect, it } from "vitest";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";

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
      // Windows 上 lstatSync（路径）与 fstatSync（fd）可返回两个不同的非零 dev，
      // inode 匹配时应接受，否则插件在 Windows 上全部加载失败。
      name: "accepts win32 dev mismatch even when both dev values are non-zero",
      left: stat(7, 11),
      right: stat(8, 11),
      platform: "win32" as const,
      expected: true,
    },
    {
      name: "handles bigint stats",
      left: stat(0n, 11n),
      right: stat(8n, 11n),
      platform: "win32" as const,
      expected: true,
    },
  ])("$name", ({ left, right, platform, expected }) => {
    expect(sameFileIdentity(left, right, platform)).toBe(expected);
  });
});
