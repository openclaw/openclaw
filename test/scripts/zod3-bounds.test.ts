import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it("keeps the remaining Zod 3 bounds regression passing in both module formats", () => {
  const file = fileURLToPath(new URL("./zod3-bounds.regression.mjs", import.meta.url));
  expect(() =>
    execFileSync(resolveTestNodeExecPath(), ["--test", file], {
      encoding: "utf8",
    }),
  ).not.toThrow();
});
