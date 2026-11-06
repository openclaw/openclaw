import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createNativePackageSwapFixture } from "./package-update-swap.test-support.js";

describe("native launcher publication", () => {
  it.each([false, true])(
    "commits with an actionable warning only for missing launcher targets (missing=%s)",
    async (missing) => {
      await withTestDir({ prefix: "native-launcher-publication-" }, async (base) => {
        const { params, native, packageRoot, candidate, binDir } =
          await createNativePackageSwapFixture(base);
        const entry = path.join(candidate, "openclaw.mjs");
        await fs.writeFile(entry, 'console.log("candidate");\n');
        const target = path.relative(
          native.binDir,
          missing ? path.join(base, ".openclaw-update-native-removed", "openclaw.mjs") : entry,
        );
        // All published formats must inspect the executable path, even with correct metadata.
        for (const [name, content] of [
          ["openclaw", `exec node "$basedir_abs/${target}" "$@"`],
          ["openclaw.cmd", `"node" "%~dp0\\${target.replaceAll("/", "\\")}" %*`],
          ["openclaw.ps1", `& "node" "$basedir/${target}" $args`],
        ]) {
          await fs.writeFile(
            path.join(native.binDir, name!),
            `${content}\n# cmd-shim-target=${entry}\n`,
          );
        }
        const result = await swapStagedPackageInstall(params);
        expect(result).toMatchObject({ status: "committed", step: { exitCode: 0 } });
        if (missing) {
          expect(result.step.warnings).toHaveLength(3);
          for (const name of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
            expect(result.step.warnings).toContainEqual(
              expect.stringContaining(path.join(binDir, name)),
            );
          }
          expect(result.step.advisory).toMatchObject({
            kind: "recoverable-maintenance",
            message: expect.stringContaining("Reinstall the current openclaw version with pnpm"),
          });
        } else {
          expect(result.step.warnings).toBeUndefined();
        }
        expect(await fs.readFile(path.join(packageRoot, "openclaw.mjs"), "utf8")).toContain(
          "candidate",
        );
      });
    },
  );
});
