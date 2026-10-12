import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const execute = promisify(execFile);

it(
  "preserves plugin artifact authoring in the native source host",
  { timeout: 180_000 },
  async () => {
    let stdout: string;
    try {
      ({ stdout } = await execute(
        resolveTestNodeExecPath(),
        [
          "--import",
          pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
          "--test",
          "--experimental-test-isolation=none",
          "--test-reporter=tap",
          path.resolve("src/cli/plugins-feature-artifact.native.test-support.ts"),
        ],
        { timeout: 170_000, maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch (error) {
      const output =
        error instanceof Error
          ? [error.message, Reflect.get(error, "stdout"), Reflect.get(error, "stderr")]
              .filter(Boolean)
              .join("\n")
          : String(error);
      throw new Error(`Native plugin artifact authoring failed:\n${output}`, { cause: error });
    }
    expect(stdout).toMatch(/# tests [1-9][0-9]*/);
    expect(stdout).toContain("# fail 0");
  },
);
