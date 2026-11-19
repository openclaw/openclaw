import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { verifyRuntimeLauncher } from "./update-runtime-relocation.js";

// The bin directory is a symlink: `$basedir` resolves beside the link, `basedir_abs`
// (pwd -P) beside its physical target. Each shim's entry exists only where it looks.
describe.skipIf(process.platform === "win32")("runtime launcher verification", () => {
  it.each([
    // Older lexical shim; a path that merely names basedir_abs is not a definition.
    ["lexical", 'basedir=$(dirname "$0")', '"$basedir/../pkg/openclaw.mjs"', "basedir_abs/x"],
    // pnpm 11+ defines basedir_abs; the rewriter emits the braced spelling.
    [
      "physical",
      'basedir_abs=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P)\nbasedir="$basedir_abs"',
      '"${basedir_abs}"/../pkg/openclaw.mjs',
      "pkg/openclaw.mjs",
    ],
  ] as const)(
    "resolves a %s shim from the directory its shell uses",
    async (side, definition, target, recorded) =>
      withTestDir({ prefix: "launcher-verify-" }, async (base) => {
        await fs.mkdir(path.join(base, "physical", "bin"), { recursive: true });
        await fs.mkdir(path.join(base, "lexical"));
        await fs.symlink(path.join(base, "physical", "bin"), path.join(base, "lexical", "bin"));
        await fs.mkdir(path.join(base, side, "pkg"));
        await fs.writeFile(path.join(base, side, "pkg", "openclaw.mjs"), "");
        const launcher = path.join(base, "lexical", "bin", "openclaw");
        const comment = `# cmd-shim-target=${path.join(base, recorded)}`;
        await fs.writeFile(
          launcher,
          `#!/bin/sh\n${definition}\nexec node  ${target} "$@"\n${comment}\n`,
        );

        await expect(verifyRuntimeLauncher(launcher, "openclaw.mjs")).resolves.toBe("verified");
      }),
  );
});
