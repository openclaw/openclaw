import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it("keeps fast-uri security and MCP/Ajv compatibility checks passing", () => {
  const file = fileURLToPath(new URL("../../scripts/test-security-fast-uri.mjs", import.meta.url));
  expect(() =>
    execFileSync(resolveTestNodeExecPath(), [file], {
      encoding: "utf8",
    }),
  ).not.toThrow();
});
