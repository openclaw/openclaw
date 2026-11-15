import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps the iOS built-in palette projection in sync with Android", () => {
  expect(() =>
    execFileSync(process.execPath, ["scripts/ios-theme-palettes.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }),
  ).not.toThrow();
});
