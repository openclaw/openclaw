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
    expect(result.stdout).toContain("--no-follow");
  });

  it.each([
    ["status", "--no-follow is valid only with rerun --job"],
    ["rerun", "--no-follow is valid only with rerun --job", "--child", "normalCi"],
  ])("rejects --no-follow for unsupported %s commands", (command, message, ...arguments_) => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/frv.mjs"), command, "--run", "77", ...arguments_, "--no-follow"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[frv] ${message}`);
  });
});
