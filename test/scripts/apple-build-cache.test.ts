import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

describe("Apple build cache contracts", () => {
  it("reuses verified Mermaid bytes, rebuilds changed inputs or damaged output, and refreshes Swift resources", () => {
    const root = temps.make("apple-mermaid-cache-");
    const put = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    };
    for (const file of [
      "packages/mermaid-renderer/src/native.ts",
      "packages/mermaid-renderer/vite.config.ts",
      "packages/normalization-core/src/record-coerce.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "tsconfig.json",
    ]) {
      put(file, "{}");
    }
    mkdirSync(path.join(root, "scripts"));
    for (const file of [
      "prepare-apple-mermaid.mjs",
      "pnpm-runner.mts",
      "windows-cmd-helpers.mjs",
      "run-node-package-bin.mts",
    ]) {
      copyFileSync(`scripts/${file}`, path.join(root, "scripts", file));
    }
    put(
      "pnpm.cjs",
      `const fs = require("node:fs");
const target = "apps/shared/mermaid/assets/mermaid";
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(target + "/native.js", "verified bundle");
fs.appendFileSync("builds", "built\\n");`,
    );
    const run = () => {
      const result = spawnSync(process.execPath, ["scripts/prepare-apple-mermaid.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, npm_execpath: path.join(root, "pnpm.cjs") },
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(path.join(root, "builds"), "utf8").trim().split("\n").length;
    };
    expect(run()).toBe(1);
    const resources = "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid";
    put(`${resources}/obsolete.js`, "stale resource");
    expect(run()).toBe(1);
    expect(() => readFileSync(path.join(root, resources, "obsolete.js"))).toThrow();
    expect(readFileSync(path.join(root, resources, "native.js"), "utf8")).toBe("verified bundle");
    put("packages/mermaid-renderer/vite.config.ts", "changed config");
    expect(run()).toBe(2);
    put("pnpm-lock.yaml", "changed dependency");
    expect(run()).toBe(3);
    put("packages/normalization-core/src/record-coerce.ts", "changed workspace dependency");
    expect(run()).toBe(4);
    put("apps/shared/mermaid/assets/mermaid/native.js", "damaged output");
    expect(run()).toBe(5);
    rmSync(path.join(root, "apps/shared/mermaid/assets/mermaid"), { recursive: true });
    expect(run()).toBe(6);
    put("apps/shared/mermaid/assets/apple-build-inputs.json", "invalid receipt");
    expect(run()).toBe(7);
  });

  it("reuses Watch slices across new output directories and rebuilds changed inputs or damaged archives", () => {
    const root = temps.make("watch-rtc-cache-");
    const bin = path.join(root, "bin");
    const crate = path.join(root, "crate");
    mkdirSync(bin);
    mkdirSync(path.join(crate, "src"), { recursive: true });
    copyFileSync("apps/shared/OpenClawWatchRTC/build.sh", path.join(crate, "build.sh"));
    for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/lib.rs"]) {
      writeFileSync(path.join(crate, file), "fixture");
    }
    const tool = (name: string, body: string) => {
      const file = path.join(bin, name);
      writeFileSync(file, "#!/bin/sh\nset -eu\n" + body);
      chmodSync(file, 0o755);
    };
    tool("rustup", "echo fixture-rustc\n");
    tool("xcodebuild", "echo fixture-xcode\n");
    tool(
      "xcrun",
      `if [ "$1" = lipo ]; then
  cp "$3" "$5"
elif [ "$3" = --show-sdk-path ]; then
  echo /fixture-sdk
else
  echo "$FIXTURE_SDK_VERSION"
fi
`,
    );
    tool(
      "cargo",
      `while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir) shift; output="$1" ;;
    --target) shift; target="$1" ;;
  esac
  shift
done
mkdir -p "$output/$target/release"
printf 'static library' > "$output/$target/release/libopenclaw_watch_rtc.a"
echo built >> "$FIXTURE_BUILDS"
`,
    );
    const cache = path.join(root, "cache");
    const builds = path.join(root, "builds");
    let invocation = 0;
    const run = (sdk = "27") => {
      const output = path.join(root, `output-${++invocation}`);
      const result = spawnSync(
        "/bin/bash",
        [path.join(crate, "build.sh"), "watchsimulator", output, "arm64"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            OPENCLAW_WATCH_RTC_CACHE_DIR: cache,
            FIXTURE_BUILDS: builds,
            FIXTURE_SDK_VERSION: sdk,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(output, "libopenclaw_watch_rtc.a"), "utf8")).toBe(
        "static library",
      );
      return readFileSync(builds, "utf8").trim().split("\n").length;
    };
    expect(run()).toBe(1);
    expect(run()).toBe(1);
    writeFileSync(path.join(crate, "src/lib.rs"), "changed source");
    expect(run()).toBe(2);
    for (const file of readdirSync(cache).filter((entry) => entry.endsWith(".a"))) {
      writeFileSync(path.join(cache, file), "damaged");
    }
    expect(run()).toBe(3);
    expect(run("28")).toBe(4);
  });

  it("never saves Apple inputs from PRs, dispatches, non-main refs, or frozen targets", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const job = workflow.jobs["ios-build"];
    const saves = job.steps.filter((step: { uses?: string }) =>
      step.uses?.startsWith("actions/cache/save@"),
    );
    expect(saves).toHaveLength(3);
    for (const event of ["push", "schedule", "pull_request", "workflow_dispatch"] as const) {
      for (const ref of ["refs/heads/main", "refs/heads/topic"]) {
        for (const allowed of ["true", "false"]) {
          const context = {
            eventName: event,
            ref,
            repository: "openclaw/openclaw",
            runAttempt: 1,
            preflightOutputs: { cache_write_allowed: allowed },
            steps: {
              "apple-mermaid-inputs": { outputs: { key: "inputs" } },
              "apple-mermaid-cache": { outputs: { "cache-hit": "false" } },
              "ios-cache-inputs": { outputs: { xcode: "xcode" } },
              "ios-packages-cache": { outputs: { "cache-hit": "false" } },
              "watch-rtc-cache": { outputs: { "cache-hit": "false" } },
            },
          };
          for (const step of saves) {
            expect(evaluateWorkflowExpression("${{ " + step.if + " }}", context), step.name).toBe(
              ["push", "schedule"].includes(event) &&
                ref === "refs/heads/main" &&
                allowed === "true",
            );
            expect(step.uses).toBe("actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
          }
        }
      }
    }
    for (const name of ["Identify Apple Mermaid inputs", "Identify iOS native cache inputs"]) {
      const step = job.steps.find((candidate: { name?: string }) => candidate.name === name);
      expect(
        evaluateWorkflowExpression("${{ " + step.if + " }}", {
          eventName: "schedule",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          env: { HISTORICAL_TARGET: "false" },
          preflightOutputs: { frozen_target: "true" },
          fileHashes: {
            "scripts/prepare-apple-mermaid.mjs": "present",
            "apps/shared/OpenClawWatchRTC/build.sh": "present",
          },
        }),
      ).toBe(false);
    }
  });
});
