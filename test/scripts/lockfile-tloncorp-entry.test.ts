import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pnpm lockfile integrity", () => {
  it("contains the @tloncorp/api tarball package key", () => {
    const lockfile = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
    expect(lockfile).toMatch(
      /['"]?@tloncorp\/api@https:\/\/codeload\.github\.com\/tloncorp\/api-beta\/tar\.gz\/7eede1c1a756977b09f96aa14a92e2b06318ae87['"]?:/,
    );
  });
});
