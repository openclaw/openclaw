import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bundleId = "ai.openclawfoundation.app";

function fixture() {
  const root = tempDirs.make("openclaw-ios-run-");
  const scripts = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  for (const dir of [scripts, bin, path.join(root, "apps/ios")]) {
    mkdirSync(dir, { recursive: true });
  }
  const log = path.join(root, "commands.log");
  const script = path.join(scripts, "ios-run.sh");
  writeFileSync(script, readFileSync("scripts/ios-run.sh"), { mode: 0o755 });
  const stub = path.join(scripts, "command.mjs");
  writeFileSync(
    stub,
    `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const name = process.argv[2] ?? "write-swift-filelist";
const args = process.argv.slice(3);
const env = process.env;
const log = (value) => appendFileSync(${JSON.stringify(log)}, value + "\\n");
if (!["simctl", "plistbuddy"].includes(name) &&
    (env.OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET || env.CUSTOM_SIMULATOR_PUSH_PROOF_SECRET)) {
  log(name + "-proof-env leaked");
}
if (["xcodegen", "xcodebuild", "simctl"].includes(name)) log(name + " " + args.join(" "));
if (name === "write-swift-filelist") log(name);
if (name === "xcodebuild") {
  const option = (flag) => args[args.indexOf(flag) + 1];
  const app = path.join(option("-derivedDataPath"), "Build/Products", option("-configuration") + "-iphonesimulator/OpenClaw.app");
  mkdirSync(app, { recursive: true });
  writeFileSync(path.join(app, "Info.plist"), '<key>CFBundleIdentifier</key><string>${bundleId}</string>');
}
if (name === "plistbuddy") {
  const match = /<key>CFBundleIdentifier<\\/key><string>([^<]*)<\\/string>/.exec(readFileSync(args[2], "utf8"));
  if (match) console.log(match[1]);
}
if (name === "simctl" && args[0] === "launch") {
  log("simctl-launch-proof " + (env.SIMCTL_CHILD_OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET ? "set" : "unset"));
}
if (name === "simctl" && args[0] === "boot" && ["booted", "fail"].includes(env.SIMCTL_BOOT_MODE)) {
  console.error("Unable to boot device in current state: " + (env.SIMCTL_BOOT_MODE === "booted" ? "Booted" : "Shutdown"));
  process.exit(1);
}
`,
  );
  const executable = (dir: string, name: string) =>
    writeFileSync(
      path.join(dir, name),
      `#!/usr/bin/env bash\nexec node "${stub}" "${name}" "$@"\n`,
      {
        mode: 0o755,
      },
    );
  for (const name of ["ios-configure-signing.sh", "ios-write-version-xcconfig.sh"]) {
    executable(scripts, name);
  }
  writeFileSync(path.join(scripts, "ios-write-swift-filelist.mjs"), 'import "./command.mjs";');
  for (const name of ["xcodegen", "xcodebuild", "simctl", "plistbuddy"]) {
    executable(bin, name);
  }
  return {
    log: () => readFileSync(log, "utf8"),
    run: (extraEnv = {}, args: string[] = []) =>
      execFileSync(
        process.platform === "win32" ? "bash" : "/bin/bash",
        [...(process.platform === "win32" ? [] : ["--noprofile", "--norc"]), script, ...args],
        {
          env: {
            ...process.env,
            IOS_DERIVED_DATA_DIR: path.join(root, "DerivedData"),
            ...Object.fromEntries(
              Object.entries({
                XCODEBUILD: "xcodebuild",
                XCODEGEN: "xcodegen",
                SIMCTL: "simctl",
                PLIST_BUDDY: "plistbuddy",
              }).map(([key, name]) => [`IOS_RUN_${key}_BIN`, path.join(bin, name)]),
            ),
            ...extraEnv,
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
  };
}

it.each([true, false])("isolates simulator proof secrets with sandbox mode=%s", (sandbox) => {
  const f = fixture();
  const secret = "x".repeat(32),
    custom = "y".repeat(32);
  f.run(
    {
      OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET: secret,
      SIMCTL_BOOT_MODE: "booted",
      ...(!sandbox && {
        OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET_ENV: "CUSTOM_SIMULATOR_PUSH_PROOF_SECRET",
        CUSTOM_SIMULATOR_PUSH_PROOF_SECRET: custom,
      }),
    },
    sandbox ? ["--push-sandbox-simulator"] : [],
  );
  const log = f.log();
  if (sandbox) {
    expect(log).toContain("OPENCLAW_PUSH_MODE=simulatorSandbox");
    expect(log).toContain(
      "OPENCLAW_PUSH_RELAY_BASE_URL=https://ios-push-relay-sandbox.openclaw.ai",
    );
  }
  expect(log).toContain(`simctl launch iPhone 17 ${bundleId}`);
  expect(log).toContain(`simctl-launch-proof ${sandbox ? "set" : "unset"}`);
  for (const forbidden of ["proof-env leaked", secret, custom]) {
    expect(log).not.toContain(forbidden);
  }
});

it("does not ignore simulator boot failures other than already booted", () => {
  const f = fixture();
  expect(() => f.run({ SIMCTL_BOOT_MODE: "fail" })).toThrow();
  expect(f.log()).not.toContain("simctl launch");
});
