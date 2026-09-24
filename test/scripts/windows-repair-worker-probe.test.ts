import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadPackagedOwner,
  type PackagedOwnerEvidence,
} from "../../scripts/lib/windows-repair-package.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function fixture(files: Record<string, string>) {
  const root = directories.make("windows-repair-package-owner-");
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(packageRoot, "dist", name), contents);
  }
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  return { packageRoot, tarball };
}

it.each([
  { alias: "a", split: false },
  { alias: "$", split: false },
  { alias: "a", split: true },
  { alias: "$", split: true },
])(
  "loads named package owners through $alias with split chunks=$split",
  async ({ alias, split }) => {
    const admit = `function admit() { return "owned"; } export { admit as ${alias} };`;
    const finish = 'function finish() { return "finished"; } export { finish as f };';
    const facade = 'import { f as finish } from "./finish-fixture.mjs"; export { finish };';
    const rootSource = split ? admit : `${admit}\n${finish}`;
    const files: Record<string, string> = split
      ? {
          "executor-fixture.mjs": admit,
          "finish-fixture.mjs": finish,
          "executor-finish.mjs": facade,
        }
      : { "executor-fixture.mjs": rootSource };
    const { packageRoot, tarball } = await fixture(files);
    const evidence: PackagedOwnerEvidence[] = [];
    const owner = await loadPackagedOwner(
      packageRoot,
      tarball,
      "executor",
      ["admit", "finish"],
      evidence,
    );
    expect(owner.admit?.()).toBe("owned");
    expect(owner.finish?.()).toBe("finished");
    const expected: PackagedOwnerEvidence[] = [
      {
        file: "dist/executor-fixture.mjs",
        sha256: createHash("sha256").update(rootSource).digest("hex"),
        exports: split ? { admit: alias } : { admit: alias, finish: "f" },
      },
    ];
    if (split) {
      expected.push({
        file: "dist/executor-finish.mjs",
        sha256: createHash("sha256").update(facade).digest("hex"),
        exports: { finish: "finish" },
      });
    }
    expect(evidence).toHaveLength(expected.length);
    expect(evidence).toEqual(expect.arrayContaining(expected));
  },
);

it("authenticates every selected chunk before importing any owner", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-first.mjs":
      'throw new Error("unverified code executed"); function admit() {} export { admit as a };',
    "executor-second.mjs": "function finish() {} export { finish as f };",
  });
  await fs.writeFile(
    path.join(packageRoot, "dist", "executor-second.mjs"),
    'function finish() { return "changed"; } export { finish as f };',
  );
  await expect(
    loadPackagedOwner(packageRoot, tarball, "executor", ["admit", "finish"], []),
  ).rejects.toThrow("Installed module differs from the bound package");
});

it.each(["absent", "ambiguous"])("refuses an %s packaged authority owner", async (shape) => {
  const files: Record<string, string> =
    shape === "absent"
      ? { "executor-other.mjs": "function different() {} export { different as a };" }
      : {
          "executor-first.mjs": "function admit() {} export { admit as a };",
          "executor-second.mjs": "function admit() {} export { admit as b };",
        };
  const { packageRoot, tarball } = await fixture(files);
  await expect(loadPackagedOwner(packageRoot, tarball, "executor", ["admit"], [])).rejects.toThrow(
    "Expected one packaged executor owner",
  );
});
