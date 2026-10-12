import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Android release shell wrapper arguments", () => {
  it("overrides an inherited Gemfile and survives caller directory changes", () => {
    const binDir = tempDirs.make("openclaw-android-fastlane-test-");
    const tracePath = path.join(binDir, "trace.log");
    const bundle = path.join(binDir, "bundle");
    const fastlane = path.join(binDir, "fastlane");
    writeFileSync(
      bundle,
      "#!/usr/bin/env bash\n" +
        '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
        '[[ "${1:-}" == "_4.0.22_" ]] || exit 92\n' +
        '[[ "${2:-}" != "check" ]] || exit 0\n' +
        '[[ "${2:-}" == "exec" && "${3:-}" == "fastlane" ]] || exit 93\n' +
        'printf "bundle:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n',
    );
    writeFileSync(
      fastlane,
      "#!/usr/bin/env bash\n" +
        '[[ "${1:-}" != "--version" ]] || exit 0\n' +
        'printf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n',
    );
    chmodSync(bundle, 0o755);
    chmodSync(fastlane, 0o755);
    const result = spawnSync(
      BASH_BIN,
      [
        "-c",
        "source scripts/lib/android-fastlane.sh; cd apps/android; run_android_fastlane android release_preflight",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BUNDLE_GEMFILE: "/tmp/hostile/Gemfile",
          OPENCLAW_FASTLANE_EXPECTED_GEMFILE: path.join(process.cwd(), "apps/android/Gemfile"),
          OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";

    expect(result.status).toBe(0);
    expect(trace).toContain("bundle:_4.0.22_ exec fastlane android release_preflight");
    expect(trace).not.toContain("direct:");
  });
});
