// Containment canonicalization is shared by plugin install and cleanup checks.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { realpathViaExistingPrefix, realpathViaExistingPrefixSync } from "./path-containment.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform !== "win32")("realpathViaExistingPrefix", () => {
  async function layout() {
    const base = await fs.realpath(tempDirs.make("ocl-path-containment-"));
    const real = path.join(base, "real");
    await fs.mkdir(path.join(real, "dir"), { recursive: true });
    await fs.symlink(real, path.join(base, "alias"));
    await fs.symlink(path.join(real, "later"), path.join(real, "dangling"));
    await fs.symlink(path.join(real, "loop-b"), path.join(real, "loop-a"));
    await fs.symlink(path.join(real, "loop-a"), path.join(real, "loop-b"));
    return base;
  }

  it.each([
    ["missing tail under an alias", "alias/dir/new/p.png", "real/dir/new/p.png"],
    ["dangling link followed to its target", "alias/dangling/p.png", "real/later/p.png"],
    [".. through an existing folder", "alias/dir/../dir/p.png", "real/dir/p.png"],
    [".. after a missing folder", "alias/gone/../dir/p.png", undefined],
    ["looping links", "alias/loop-a/p.png", undefined],
  ] as const)("%s (sync and async agree)", async (_name, relative, expected) => {
    const base = await layout();
    const candidate = `${base}/${relative}`;
    const want = expected === undefined ? undefined : path.join(base, expected);
    expect(await realpathViaExistingPrefix(candidate)).toBe(want);
    expect(realpathViaExistingPrefixSync(candidate)).toBe(want);
  });
});
