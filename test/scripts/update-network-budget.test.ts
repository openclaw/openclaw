import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps standalone installer network defaults synchronized", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-update-network-budget.mjs", "--check"],
    {
      encoding: "utf8",
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
