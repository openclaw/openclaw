import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// Regression for #194819: the curated recommended-models seed must only contain
// model ids the provider actually serves. DeepSeek retired deepseek-v4-flash and
// never served deepseek-v4.1-flash (a stale alias); the live api.deepseek.com
// inventory serves deepseek-flash (canonical default) and deepseek-v4-pro.
const seedPath = path.resolve(import.meta.dirname, "../../scripts/lib/recommended-models.json");

it("recommends only DeepSeek ids the provider serves", () => {
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as string[];
  const deepseekSeed = seed.filter((id) => id.startsWith("deepseek"));

  expect(deepseekSeed).toContain("deepseek-flash");
  expect(deepseekSeed).not.toContain("deepseek-v4-flash");
  expect(deepseekSeed).not.toContain("deepseek-v4.1-flash");
});
