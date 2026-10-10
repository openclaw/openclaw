// iOS release prepare tests cover release-signing guardrails.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-release-prepare.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_ARGS = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];

describe("scripts/ios-release-prepare.sh", () => {
  it("rejects non-canonical signing teams before generating release inputs", () => {
    const result = spawnSync(
      BASH_BIN,
      [...BASH_ARGS, "--version", "2026.7.2", "--revision", "1", "--build-number", "3"],
      {
        env: { ...process.env, IOS_DEVELOPMENT_TEAM: "Y3YUZP442G" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "iOS App Store release must use canonical OpenClaw Team ID FWJYW4S8P8",
    );
    expect(result.stderr).toContain("got Y3YUZP442G");
  });
});
