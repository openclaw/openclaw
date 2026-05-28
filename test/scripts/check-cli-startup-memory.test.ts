import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-startup-memory-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-cli-startup-memory", () => {
  it("does not create a temp home before argument validation succeeds", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = makeTempRoot();
    const result = spawnSync(process.execPath, ["scripts/check-cli-startup-memory.mjs", "--json"], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});
