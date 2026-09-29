import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mts";
import { writeBuildStamp } from "../../scripts/lib/local-build-metadata.mts";
import { withTestDir } from "../test-helpers/temp-dir.js";

describe("build-stamp script", () => {
  it.each([
    { name: "clean", gitStatus: "", inputsClean: true },
    { name: "dirty source", gitStatus: " M src/index.ts\0", inputsClean: false },
    { name: "ignored test", gitStatus: " M src/index.test.ts\0", inputsClean: true },
    { name: "unknown", gitStatus: null, inputsClean: null },
  ])("records $name build inputs with the current git head", async ({ gitStatus, inputsClean }) => {
    await withTestDir({ prefix: "openclaw-build-stamp-" }, async (tmp) => {
      const stampPath = writeBuildStamp({
        cwd: tmp,
        now: () => 1_700_000_000_000,
        spawnSync: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "abc123\n" };
          }
          return cmd === "git" && args[0] === "status" && gitStatus !== null
            ? { status: 0, stdout: gitStatus }
            : { status: 1, stdout: "" };
        },
      });
      expect(stampPath.endsWith(`/dist/${BUILD_STAMP_FILE}`)).toBe(true);

      expect(JSON.parse(await fs.readFile(stampPath, "utf8"))).toEqual({
        builtAt: 1_700_000_000_000,
        head: "abc123",
        inputsClean,
      });
    });
  });
});
