import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createNativePackageSwapFixture } from "./package-update-swap.test-support.js";

describe("native launcher publication", () => {
  it.each(["executable", "missing target", "unknown format"] as const)(
    "publishes only launchers that start the new package (%s)",
    async (scenario) => {
      await withTestDir({ prefix: "native-launcher-publication-" }, async (base) => {
        const { params, native, packageRoot, candidate, binDir } =
          await createNativePackageSwapFixture(base);
        const entry = path.join(candidate, "openclaw.mjs");
        await fs.writeFile(entry, 'console.log("candidate");\n');
        const target = path.relative(
          native.binDir,
          scenario === "missing target"
            ? path.join(base, ".openclaw-update-native-removed", "openclaw.mjs")
            : entry,
        );
        // All published formats must inspect the executable path, even with correct metadata.
        const formats =
          scenario === "unknown format"
            ? [["openclaw", `exec node "${entry}" "$@"`]]
            : [
                ["openclaw", `exec node "$basedir_abs/${target}" "$@"`],
                ["openclaw.cmd", `"node" "%~dp0\\${target.replaceAll("/", "\\")}" %*`],
                ["openclaw.ps1", `& "node" "$basedir/${target}" $args`],
              ];
        for (const [name, content] of formats) {
          await fs.writeFile(
            path.join(native.binDir, name!),
            `${content}\n# cmd-shim-target=${entry}\n`,
          );
        }
        const result = await swapStagedPackageInstall(params);
        if (scenario === "missing target") {
          // A launcher that cannot start the package must not end as a successful update.
          expect(result).toMatchObject({ status: "failed", step: { exitCode: 1 } });
          expect(result.step.stderrTail).toContain(
            `Published launcher ${path.join(binDir, "openclaw")} cannot start openclaw`,
          );
          expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
            "1.0.0",
          );
          // The live bin had no launchers before; the broken ones are not left published.
          expect(await fs.readdir(binDir)).toEqual([]);
          return;
        }
        expect(result).toMatchObject({ status: "committed", step: { exitCode: 0 } });
        if (scenario === "unknown format") {
          // An unreadable format proves nothing; the update keeps an actionable warning.
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
