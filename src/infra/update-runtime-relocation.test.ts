import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { verifyRuntimeLauncher } from "./update-runtime-relocation.js";

/**
 * A bin directory that is a symlink into another tree: `$basedir` resolves through the
 * link's lexical parent, `basedir_abs` (pwd -P) through the physical one. Each layout
 * has the entry only where its shim actually looks.
 */
async function linkedBin(base: string, entryUnder: "lexical" | "physical") {
  const physicalBin = path.join(base, "physical", "bin");
  const lexicalBin = path.join(base, "lexical", "bin");
  await fs.mkdir(physicalBin, { recursive: true });
  await fs.mkdir(path.dirname(lexicalBin), { recursive: true });
  await fs.symlink(physicalBin, lexicalBin);
  const entry = path.join(base, entryUnder, "pkg", "openclaw.mjs");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, "");
  return { launcher: path.join(lexicalBin, "openclaw"), entry };
}

describe.skipIf(process.platform === "win32")("runtime launcher verification", () => {
  it("resolves an older lexical shim from its link even when a path names basedir_abs", async () =>
    withTestDir({ prefix: "launcher-verify-lexical-" }, async (base) => {
      const { launcher, entry } = await linkedBin(base, "lexical");
      await fs.writeFile(
        launcher,
        [
          "#!/bin/sh",
          'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
          'exec node  "$basedir/../pkg/openclaw.mjs" "$@"',
          // Only a directory name: the shim never assigns basedir_abs.
          `# cmd-shim-target=${path.join(base, "basedir_abs", "openclaw.mjs")}`,
          "",
        ].join("\n"),
      );

      await expect(verifyRuntimeLauncher(launcher, path.basename(entry))).resolves.toBe("verified");
    }));

  it("resolves a shim that defines basedir_abs physically, in the braced spelling", async () =>
    withTestDir({ prefix: "launcher-verify-physical-" }, async (base) => {
      const { launcher, entry } = await linkedBin(base, "physical");
      await fs.writeFile(
        launcher,
        [
          "#!/bin/sh",
          'basedir_abs=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P) || exit $?',
          'basedir="$basedir_abs"',
          'exec node  "${basedir_abs}"/../pkg/openclaw.mjs "$@"',
          "",
        ].join("\n"),
      );

      await expect(verifyRuntimeLauncher(launcher, path.basename(entry))).resolves.toBe("verified");
      // The same entry is absent beside the link, so a lexical reading would fail.
      await expect(fs.access(path.join(base, "lexical", "pkg", "openclaw.mjs"))).rejects.toThrow();
    }));
});
