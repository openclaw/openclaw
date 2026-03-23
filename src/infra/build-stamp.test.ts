import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeBuildStamp } from "../../scripts/build-stamp.mjs";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-build-stamp-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("build-stamp script", () => {
  it("writes dist/.buildstamp with the current git head", async () => {
    await withTempDir(async (tmp) => {
      const stampPath = writeBuildStamp({
        cwd: tmp,
        now: () => 1_700_000_000_000,
        spawnSync: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "abc123\n" };
          }
          return { status: 1, stdout: "" };
        },
      });

      await expect(fs.readFile(stampPath, "utf8")).resolves.toBe(
        '{"builtAt":1700000000000,"head":"abc123"}\n',
      );
    });
  });
});
