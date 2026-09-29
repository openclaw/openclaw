import path from "node:path";
import { expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

it.each([
  path.resolve("worktrees"),
  "~/worktrees",
  "~",
  ...(path.sep === "\\" ? ["~\\worktrees"] : []),
])("accepts absolute or home-relative worktreeRoot %s", (worktreeRoot) => {
  expect(OpenClawSchema.parse({ worktreeRoot }).worktreeRoot).toBe(worktreeRoot);
});

it("rejects a relative worktreeRoot", () => {
  expect(OpenClawSchema.safeParse({ worktreeRoot: "worktrees" }).success).toBe(false);
});
