// Containment canonicalization is shared by media, sandbox, plugin, config, and cleanup checks.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  canonicalizeForContainment,
  canonicalizeForContainmentSync,
  respellUnderRoot,
} from "./path-containment.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform !== "win32")("canonicalizeForContainment", () => {
  async function layout() {
    const base = await fs.realpath(tempDirs.make("ocl-path-containment-"));
    const real = path.join(base, "real");
    await fs.mkdir(path.join(real, "dir"), { recursive: true });
    await fs.symlink(real, path.join(base, "alias"));
    await fs.symlink(path.join(real, "later"), path.join(real, "dangling"));
    await fs.symlink(path.join(real, "loop-b"), path.join(real, "loop-a"));
    await fs.symlink(path.join(real, "loop-a"), path.join(real, "loop-b"));
    return { base, real };
  }

  it.each([
    [
      "missing tail under an alias",
      "alias/dir/new/p.png",
      { kind: "resolved", path: "real/dir/new/p.png" },
    ],
    [
      "dangling link followed to its target",
      "alias/dangling/p.png",
      { kind: "resolved", path: "real/later/p.png", danglingLink: "alias/dangling" },
    ],
    [
      ".. through an existing folder",
      "alias/dir/../dir/p.png",
      { kind: "resolved", path: "real/dir/p.png" },
    ],
    [
      ".. after a missing folder",
      "alias/gone/../dir/p.png",
      { kind: "unresolved", reason: "parent-after-missing" },
    ],
    ["looping links", "alias/loop-a/p.png", { kind: "unresolved", reason: "link-loop" }],
  ] as const)("%s (sync and async agree)", async (_name, relative, expected) => {
    const { base } = await layout();
    const candidate = `${base}/${relative}`;
    const absolute = (value: unknown) =>
      typeof value === "string" ? path.join(base, value) : value;
    const want =
      expected.kind === "resolved"
        ? Object.fromEntries(
            Object.entries(expected).map(([key, value]) => [
              key,
              key === "kind" ? value : absolute(value),
            ]),
          )
        : expect.objectContaining(expected);
    expect(await canonicalizeForContainment(candidate)).toEqual(want);
    expect(canonicalizeForContainmentSync(candidate)).toEqual(want);
  });

  it("re-spells a canonical candidate under the caller's root spelling", async () => {
    const { base, real } = await layout();
    await expect(respellUnderRoot(`${base}/alias`, `${real}/dir/p.png`)).resolves.toBe(
      `${base}/alias/dir/p.png`,
    );
    await expect(
      respellUnderRoot(`${base}/alias`, `${base}/elsewhere/p.png`),
    ).resolves.toBeUndefined();
  });
});
