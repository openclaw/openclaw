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

it.each([1, 4096, 100_000])("accepts a positive managed-worktree cap %s", (worktreeMaxCount) => {
  expect(OpenClawSchema.parse({ worktreeMaxCount }).worktreeMaxCount).toBe(worktreeMaxCount);
});

it.each([0, -1, 1.5, "4096", null])(
  "rejects an invalid managed-worktree cap %s",
  (worktreeMaxCount) => {
    expect(OpenClawSchema.safeParse({ worktreeMaxCount }).success).toBe(false);
  },
);

it("accepts a single repository branch prefix and rejects ref syntax", () => {
  expect(OpenClawSchema.parse({ repositoryBranchPrefix: "clawson" }).repositoryBranchPrefix).toBe(
    "clawson",
  );
  for (const repositoryBranchPrefix of [
    "",
    "../other",
    "refs/heads",
    "-option",
    "has space",
    "a".repeat(65),
  ]) {
    expect(OpenClawSchema.safeParse({ repositoryBranchPrefix }).success).toBe(false);
  }
});
