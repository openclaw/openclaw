import { spawnSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = fileURLToPath(new URL("../../scripts/check-changed.mjs", import.meta.url));
const typescriptPath = "ui/src/e2e/composer-fixture.e2e.test.ts";
const cssPaths = ["ui/src/styles/chat/composer-surface.css", "ui/src/styles/chat/composer.css"];

describe("changed Stylelint targets", () => {
  it.each([
    { state: "present", deleteTypeScript: false, expectedTargets: [typescriptPath, ...cssPaths] },
    { state: "deleted", deleteTypeScript: true, expectedTargets: cssPaths },
  ])(
    "includes existing styles when the UI test is $state",
    ({ deleteTypeScript, expectedTargets }) => {
      const cwd = tempDirs.make("openclaw-changed-stylelint-");
      for (const file of [typescriptPath, ...cssPaths]) {
        const target = path.join(cwd, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(
          target,
          file === typescriptPath
            ? "export const fixture = true;\n"
            : ".composer { display: block; }\n",
        );
      }
      if (deleteTypeScript) {
        unlinkSync(path.join(cwd, typescriptPath));
      }

      const result = spawnSync(
        resolveTestNodeExecPath(),
        [scriptPath, "--dry-run", "--", typescriptPath, ...cssPaths],
        { cwd, env: createNestedGitEnv(), encoding: "utf8" },
      );

      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(
        result.stderr.split(/\r?\n/u).filter((line) => line.includes("scripts/run-stylelint.mts")),
      ).toEqual([
        `[check:changed:dry-run] would run: node --import tsx scripts/run-stylelint.mts ${expectedTargets.join(" ")}`,
      ]);
    },
  );
});
