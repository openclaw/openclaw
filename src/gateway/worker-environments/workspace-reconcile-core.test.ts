import { expect, it } from "vitest";
import { retainedConflictPaths } from "./workspace-reconcile-core.js";

it("retains equivalent conflicts across a large apply inventory", () => {
  const originalApplyPaths = new Set(Array.from({ length: 10000 }, (_, i) => `dir-${i}`));
  const conflictPaths = Array.from({ length: 100 }, (_, i) => `dir-${i}/file.txt`);
  const applyPaths = new Set([...originalApplyPaths, "new-directory", "blocked/child"]);
  const blockingConflictPaths = ["blocked"];
  const expected = [
    ...new Set([
      ...conflictPaths,
      ...[...applyPaths].filter(
        (path) =>
          !originalApplyPaths.has(path) ||
          !conflictPaths.some((conflict) => conflict.startsWith(path + "/")),
      ),
    ]),
  ]
    .filter((path) => path !== "blocked" && !path.startsWith("blocked/"))
    .toSorted();
  expect(
    retainedConflictPaths({ applyPaths, conflictPaths, blockingConflictPaths }, originalApplyPaths),
  ).toEqual(expected);
  expect(retainedConflictPaths({ applyPaths, conflictPaths, blockingConflictPaths })).toEqual(
    [...new Set([...conflictPaths, ...applyPaths])]
      .filter((path) => !path.startsWith("blocked/"))
      .toSorted(),
  );
});
