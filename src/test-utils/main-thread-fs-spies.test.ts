import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeMainThreadFs } from "./main-thread-fs-spies.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("distinguishes read-only opens from file creation and write access at the same call site", () => {
  const directory = temp.make("main-thread-fs-flags-");
  const existing = path.join(directory, "existing");
  fs.writeFileSync(existing, "synthetic fixture");
  const opens: [string, string | number][] = [
    [existing, "r"],
    [existing, fs.constants.O_RDONLY],
    [path.join(directory, "exclusive-string"), "wx"],
    [
      path.join(directory, "exclusive-numeric"),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    ],
    [path.join(directory, "read-create"), fs.constants.O_RDONLY | fs.constants.O_CREAT],
    [existing, "r+"],
    [existing, fs.constants.O_RDWR],
  ];
  using observed = observeMainThreadFs();
  for (const [filename, flags] of opens) {
    fs.closeSync(fs.openSync(filename, flags));
  }
  expect(
    observed
      .stacks()
      .filter(({ api }) => api === "openSync")
      .map(({ calls, opensForWrite }) => ({ calls, opensForWrite })),
  ).toEqual([
    { calls: 2, opensForWrite: false },
    { calls: 5, opensForWrite: true },
  ]);
});
