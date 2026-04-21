import { describe, expect, it, vi } from "vitest";
import { collectPreparedPrepackErrors, resolvePnpmCommand } from "../scripts/openclaw-prepack.ts";

describe("collectPreparedPrepackErrors", () => {
  it("accepts prepared release artifacts", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        ["dist/control-ui/assets/index-Bu8rSoJV.js"],
      ),
    ).toEqual([]);
  });

  it("reports missing build and control ui artifacts", () => {
    expect(collectPreparedPrepackErrors([], [])).toEqual([
      "missing required prepared artifact: dist/index.js or dist/index.mjs",
      "missing required prepared artifact: dist/control-ui/index.html",
      "missing prepared Control UI asset payload under dist/control-ui/assets/",
    ]);
  });
});

describe("resolvePnpmCommand", () => {
  it("uses pnpm directly when available", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });

    expect(resolvePnpmCommand(spawnSync as never)).toEqual({
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: [],
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to corepack pnpm when pnpm is not on PATH", () => {
    const spawnSync = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });

    expect(resolvePnpmCommand(spawnSync as never)).toEqual({
      command: "corepack",
      args: ["pnpm"],
    });
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});
