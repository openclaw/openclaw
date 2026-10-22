import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflow,
  readCiWorkflow,
  readWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

function cacheFixture(prefix: string) {
  const root = temps.make(prefix);
  const at = (file: string) => path.join(root, file);
  const put = (file: string, content: string, mode?: number) => {
    fs.mkdirSync(path.dirname(at(file)), { recursive: true });
    fs.writeFileSync(at(file), content, { mode });
  };
  const read = (file: string) => fs.readFileSync(at(file), "utf8");
  const copy = (source: string, destination = source) => {
    fs.mkdirSync(path.dirname(at(destination)), { recursive: true });
    fs.copyFileSync(source, at(destination));
  };
  const run = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  return { at, put, read, copy, run, builds: () => read("builds").trim().split("\n").length };
}

it("reuses verified Mermaid bytes, rebuilds changed inputs or damaged output, and refreshes Swift resources", () => {
  const { at, put, read, copy, run: exec, builds } = cacheFixture("apple-mermaid-cache-");
  for (const file of [
    "packages/mermaid-renderer/src/native.ts",
    "packages/mermaid-renderer/vite.config.ts",
    "packages/normalization-core/src/record-coerce.ts",
    "package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.json",
  ]) {
    put(file, "{}");
  }
  const lock = {
    importers: {
      "packages/mermaid-renderer": {
        dependencies: {
          mermaid: { specifier: "12.0.0", version: "12.0.0" },
          "@openclaw/normalization-core": { version: "link:../normalization-core" },
        },
        devDependencies: { vite: { version: "8.3.1" } },
      },
      "packages/normalization-core": {},
      ".": { dependencies: { unrelated: { version: "1.0.0" } } },
    },
    packages: {
      "mermaid@12.0.0": { resolution: { integrity: "mermaid-bytes" } },
      "vite@8.3.1": { resolution: { integrity: "vite-bytes" } },
      "bundler@1.0.0": { resolution: { integrity: "bundler-bytes" } },
      "unrelated@1.0.0": { resolution: { integrity: "unrelated-bytes" } },
    },
    snapshots: {
      "mermaid@12.0.0": {},
      "vite@8.3.1": { optionalDependencies: { bundler: "1.0.0" } },
      "bundler@1.0.0": {},
      "unrelated@1.0.0": {},
    },
  };
  const writeLock = () => put("pnpm-lock.yaml", stringify(lock));
  writeLock();
  fs.mkdirSync(at("patches"));
  for (const file of [
    "scripts/prepare-apple-mermaid.mjs",
    "scripts/lib/pnpm-lockfile-documents.mjs",
    "scripts/pnpm-runner.mts",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/run-node-package-bin.mts",
    "src/infra/update-runtime-staging.ts",
  ]) {
    copy(file);
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
  const prepare = (...args: string[]) =>
    exec(process.execPath, ["scripts/prepare-apple-mermaid.mjs", ...args], {
      npm_execpath: at("pnpm.cjs"),
    });
  const cacheKey = () => prepare("--cache-key");
  const key = cacheKey();
  expect(key).toMatch(/^[a-z0-9-]+-v[\d.]+-[a-f0-9]{64}$/);
  const retained =
    "packages/mermaid-renderer/node_modules.openclaw-update-0459d479-fce3-4876-8faf-03a268fe0562.tmp";
  put(`${retained}/previous/retained.txt`, "rollback bytes");
  // Git promotion retains links relative to their final location. Reading this
  // rollback tree as source would fail, even though its custody is intentional.
  fs.symlinkSync(
    "../missing-normalization-core",
    at(`${retained}/previous/normalization-core`),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(cacheKey()).toBe(key);
  put(`${retained}/previous/retained.txt`, "other rollback bytes");
  expect(cacheKey()).toBe(key);
  put(
    "packages/mermaid-renderer/node_modules.openclaw-update-operator.tmp/source.ts",
    "legitimate source",
  );
  expect(cacheKey()).not.toBe(key);
  expect(() => read("builds")).toThrow();
  const run = () => {
    prepare();
    return builds();
  };
  expect(run()).toBe(1);
  const resources = "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid";
  put(`${resources}/obsolete.js`, "stale resource");
  expect(run()).toBe(1);
  expect(() => read(`${resources}/obsolete.js`)).toThrow();
  expect(read(`${resources}/native.js`)).toBe("verified bundle");
  put("package.json", JSON.stringify({ dependencies: { unrelated: "2.0.0" } }));
  lock.packages["unrelated@1.0.0"].resolution.integrity = "unrelated-change";
  writeLock();
  expect(run()).toBe(1);
  put("packages/mermaid-renderer/vite.config.ts", "changed config");
  expect(run()).toBe(2);
  lock.packages["bundler@1.0.0"].resolution.integrity = "changed-optional-transitive-build-input";
  writeLock();
  expect(run()).toBe(3);
  put("packages/normalization-core/src/record-coerce.ts", "changed workspace dependency");
  expect(run()).toBe(4);
  put("apps/shared/mermaid/assets/mermaid/native.js", "damaged output");
  expect(run()).toBe(5);
  fs.rmSync(at("apps/shared/mermaid/assets/mermaid"), { recursive: true });
  expect(run()).toBe(6);
  put("apps/shared/mermaid/assets/apple-build-inputs.json", "invalid receipt");
  expect(run()).toBe(7);
});

it("reuses Watch slices across new output directories and rebuilds changed inputs or damaged archives", () => {
  const { at, put, read, copy, run: exec, builds } = cacheFixture("watch-rtc-cache-");
  copy("apps/shared/OpenClawWatchRTC/build.sh", "crate/build.sh");
  for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/lib.rs"]) {
    put(`crate/${file}`, "fixture");
  }
  const tool = (name: string, body: string) =>
    put(`bin/${name}`, "#!/bin/sh\nset -eu\n" + body, 0o755);
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
  const cache = at("cache");
  let invocation = 0;
  const run = (sdk = "27") => {
    const output = `output-${++invocation}`;
    exec("/bin/bash", [at("crate/build.sh"), "watchsimulator", at(output), "arm64"], {
      PATH: `${at("bin")}:${process.env.PATH}`,
      OPENCLAW_WATCH_RTC_CACHE_DIR: cache,
      FIXTURE_BUILDS: at("builds"),
      FIXTURE_SDK_VERSION: sdk,
    });
    expect(read(`${output}/libopenclaw_watch_rtc.a`)).toBe("static library");
    return builds();
  };
  expect(run()).toBe(1);
  expect(run()).toBe(1);
  put("crate/src/lib.rs", "changed source");
  expect(run()).toBe(2);
  for (const file of fs.readdirSync(cache).filter((entry) => entry.endsWith(".a"))) {
    fs.writeFileSync(path.join(cache, file), "damaged");
  }
  expect(run()).toBe(3);
  expect(run("28")).toBe(4);
});

it("never saves Apple inputs from PRs, dispatches, non-main refs, or frozen targets", () => {
  const job = readCiWorkflow().jobs["ios-build"];
  const saves = job.steps.filter((step: WorkflowStep) =>
    step.uses?.startsWith("actions/cache/save@"),
  );
  expect(saves).toHaveLength(4);
  const watchRestore = job.steps.find(
    (step: WorkflowStep) => step.name === "Restore Watch RTC build inputs",
  );
  for (const [file, jobName, buildName] of [
    ["ios-periphery.yml", "scan", "Run Periphery"],
    ["macos-periphery.yml", "scan-ios", "Build iOS consumer index"],
  ] as const) {
    const steps = readWorkflow(`.github/workflows/${file}`).jobs[jobName].steps;
    const index = (name: string) => steps.findIndex((step: WorkflowStep) => step.name === name);
    const identify = index("Identify Watch RTC cache inputs");
    const restore = index("Restore Watch RTC build inputs");
    const build = index(buildName);
    expect(identify, file).toBeGreaterThan(-1);
    expect(restore, file).toBeGreaterThan(identify);
    expect(build, file).toBeGreaterThan(restore);
    expect(steps[restore].uses, file).toBe(watchRestore.uses);
    expect(steps[restore].with, file).toEqual(watchRestore.with);
    expect(
      steps.some((step: WorkflowStep) => step.uses?.startsWith("actions/cache/save@")),
      file,
    ).toBe(false);
  }
  for (const event of ["push", "schedule", "pull_request", "workflow_dispatch"] as const) {
    for (const ref of ["refs/heads/main", "refs/heads/topic"]) {
      for (const allowed of ["true", "false"]) {
        const context = {
          eventName: event,
          ref,
          preflightOutputs: { cache_write_allowed: allowed },
          steps: {
            "apple-mermaid-inputs": { outputs: { key: "inputs" } },
            "apple-mermaid-cache": { outputs: { "cache-hit": "false" } },
            "ios-cache-inputs": { outputs: { xcode: "xcode" } },
            "ios-packages-cache": { outputs: { "cache-hit": "false" } },
            "watch-rtc-cache": { outputs: { "cache-hit": "false" } },
            "record-ios-build-cache-metadata": { outputs: {}, outcome: "success" as const },
          },
        };
        for (const step of saves) {
          // Native test products are written only by the scheduled run that recorded their inputs.
          const writers =
            step.name === "Save iOS test build products" ? ["schedule"] : ["push", "schedule"];
          expect(evaluateWorkflow("${{ " + step.if + " }}", context), step.name).toBe(
            writers.includes(event) && ref === "refs/heads/main" && allowed === "true",
          );
          expect(step.uses).toBe("actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
        }
      }
    }
  }
  for (const name of ["Identify Apple Mermaid inputs", "Identify iOS native cache inputs"]) {
    const step = job.steps.find((candidate: { name?: string }) => candidate.name === name);
    expect(
      evaluateWorkflow("${{ " + step.if + " }}", {
        eventName: "schedule",
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
