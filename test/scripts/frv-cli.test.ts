import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("frv CLI", () => {
  it.each(["--help", "-h", "help"])("prints help successfully for %s", (argument) => {
    const result = spawnSync(process.execPath, [resolve("scripts/frv.mjs"), argument], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: pnpm frv");
  });
});
