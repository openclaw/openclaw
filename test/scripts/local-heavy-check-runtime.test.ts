import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
} from "../../scripts/lib/local-heavy-check-runtime.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    ...overrides,
  };
}

describe("local-heavy-check-runtime", () => {
  it("tightens local tsgo runs to a single checker with a Go memory limit", () => {
    const { args, env } = applyLocalTsgoPolicy([], makeEnv());

    expect(args).toEqual(["--singleThreaded", "--checkers", "1"]);
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("keeps explicit tsgo flags and Go env overrides intact", () => {
    const { args, env } = applyLocalTsgoPolicy(
      ["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"],
      makeEnv({
        GOGC: "80",
        GOMEMLIMIT: "5GiB",
        OPENCLAW_TSGO_PPROF_DIR: "/tmp/profile",
      }),
    );

    expect(args).toEqual(["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"]);
    expect(env.GOGC).toBe("80");
    expect(env.GOMEMLIMIT).toBe("5GiB");
  });

  it("serializes local oxlint runs onto one thread", () => {
    const { args } = applyLocalOxlintPolicy([], makeEnv());

    expect(args).toEqual(["--type-aware", "--tsconfig", "tsconfig.oxlint.json", "--threads=1"]);
  });

  it("reclaims stale local heavy-check locks from dead pids", () => {
    const cwd = createTempDir("openclaw-local-heavy-check-");
    const commonDir = path.join(cwd, ".git");
    const lockDir = path.join(commonDir, "openclaw-local-checks", "heavy-check.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        tool: "tsgo",
        cwd,
      })}\n`,
      "utf8",
    );

    const release = acquireLocalHeavyCheckLockSync({
      cwd,
      env: makeEnv(),
      toolName: "oxlint",
    });

    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.tool).toBe("oxlint");

    release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});
