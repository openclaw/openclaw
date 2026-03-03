import { describe, expect, it } from "vitest";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";

function stat(dev: number | bigint, ino: number | bigint): FileIdentityStat {
  return { dev, ino };
}

describe("sameFileIdentity", () => {
  it("accepts exact dev+ino match", () => {
    expect(sameFileIdentity(stat(7, 11), stat(7, 11), "linux")).toBe(true);
  });

  it("rejects inode mismatch", () => {
    expect(sameFileIdentity(stat(7, 11), stat(7, 12), "linux")).toBe(false);
  });

  it("rejects dev mismatch on non-windows", () => {
    expect(sameFileIdentity(stat(7, 11), stat(8, 11), "linux")).toBe(false);
  });

  it("accepts win32 dev mismatch when either side is 0", () => {
    expect(sameFileIdentity(stat(0, 11), stat(8, 11), "win32")).toBe(true);
    expect(sameFileIdentity(stat(7, 11), stat(0, 11), "win32")).toBe(true);
  });

  it("keeps dev strictness on win32 when both dev values are non-zero", () => {
    expect(sameFileIdentity(stat(7, 11), stat(8, 11), "win32")).toBe(false);
  });

  it("handles bigint stats", () => {
    expect(sameFileIdentity(stat(0n, 11n), stat(8n, 11n), "win32")).toBe(true);
  });
});
