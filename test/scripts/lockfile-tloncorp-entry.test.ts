import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pnpm lockfile integrity", () => {
  it("contains @tloncorp/api resolution entry required by frozen installs", () => {
    const lockfilePath = resolve(process.cwd(), "pnpm-lock.yaml");
    const lockfile = readFileSync(lockfilePath, "utf8");
    expect(lockfile).toContain(
      "'@tloncorp/api@https://codeload.github.com/tloncorp/api-beta/tar.gz/7eede1c1a756977b09f96aa14a92e2b06318ae87':",
    );
  });
});
