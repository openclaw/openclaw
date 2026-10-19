import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const fixture = String.raw`
require "json"
module UI
  def self.user_error!(message); raise message; end
  def self.important(*); end
end
def default_platform(*); end
def desc(*); end
def platform(*); yield; end
def lane(*); end
alias private_lane lane
load ARGV.fetch(0)

# No pre-created devices, including a stale device with the preferred name.
def available_simulator_devices; []; end
module Open3
  def self.capture3(*arguments)
    raise "unexpected command" unless arguments == ["xcrun", "simctl", "list", "runtimes", "--json"]
    types = [
      { name: "Apple Watch Series 12 (46mm)", identifier: "series-12" },
      { name: "Apple Watch Ultra 4 (49mm)", identifier: "ultra-4" }
    ]
    runtimes = [
      { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", version: "26.0", isAvailable: true, supportedDeviceTypes: types },
      { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-28-0", version: "28.0", isAvailable: false, supportedDeviceTypes: types },
      { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0", version: "27.0", isAvailable: true, supportedDeviceTypes: types }
    ]
    if ARGV[1] == "unavailable"
      runtimes.each { |runtime| runtime[:isAvailable] = false }
    end
    [JSON.generate({ runtimes: runtimes }), "", Struct.new(:success?).new(true)]
  end
end
begin
  puts JSON.generate({ device: resolve_simulator_device(ARGV.fetch(2)) })
rescue => error
  puts JSON.generate({ error: error.message })
end
`;

function resolve(scenario: string, name: string) {
  const result = spawnSync(
    "ruby",
    ["-e", fixture, path.join(process.cwd(), "apps/ios/fastlane/Fastfile"), scenario, name],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "false",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it("creates a Watch descriptor from the latest available runtime without pre-created devices", () => {
  expect(resolve("available", "Apple Watch Series 12 (46mm)")).toEqual({
    device: {
      name: "Apple Watch Series 12 (46mm)",
      deviceTypeIdentifier: "series-12",
      runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0",
    },
  });
  expect(resolve("available", "Apple Watch Ultra 3 (49mm)")).toEqual({
    device: {
      name: "Apple Watch Ultra 4 (49mm)",
      deviceTypeIdentifier: "ultra-4",
      runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0",
    },
  });
});

it("reports missing runtime setup separately from a screenshot failure", () => {
  expect(resolve("unavailable", "Apple Watch Ultra 3 (49mm)")).toEqual({
    error:
      "No available watchOS runtime. Install one for the selected Xcode with: xcodebuild -downloadPlatform watchOS",
  });
});

it.each(["installed", "missing", "download-failed", "watch-disabled"])(
  "prepares the CI runtime before capture: %s",
  (scenario) => {
    const root = tempDirs.make("watch-runtime-");
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls");
    const installed = path.join(root, "installed");
    mkdirSync(bin);
    if (scenario === "installed") {
      writeFileSync(installed, "");
    }
    const tool = `#!${process.execPath}
const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([name, ...args]) + "\\n");
if (name === "xcrun") {
  if (args[0] === "--sdk") console.log("27.0");
  else if (args.includes("--json")) console.log(JSON.stringify({runtimes: [
    {identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", version: "26.0", isAvailable: true},
    {identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0", version: "27.0", isAvailable: fs.existsSync(${JSON.stringify(installed)})}
  ]}));
} else if (name === "xcodebuild" && args[0] === "-downloadPlatform") {
  if (${JSON.stringify(scenario)} === "download-failed") process.exit(42);
  if (fs.existsSync(${JSON.stringify(installed)})) process.exit(70);
  fs.writeFileSync(${JSON.stringify(installed)}, "");
}
`;
    for (const name of ["xcrun", "xcodebuild", "bundle"]) {
      const executable = path.join(bin, name);
      writeFileSync(executable, tool);
      chmodSync(executable, 0o755);
    }
    const result = spawnSync("/bin/bash", ["scripts/ios-screenshots.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        OPENCLAW_SNAPSHOT_SKIP_WATCH: scenario === "watch-disabled" ? "1" : "0",
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    });
    const commands: string[][] = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const downloads = commands.filter((command) => command[1] === "-downloadPlatform");
    const captures = commands.filter((command) => command.includes("fastlane"));
    expect(result.status, result.stderr).toBe(scenario === "download-failed" ? 42 : 0);
    expect(downloads).toEqual(
      scenario === "installed" || scenario === "watch-disabled"
        ? []
        : [["xcodebuild", "-downloadPlatform", "watchOS", "-buildVersion", "27.0"]],
    );
    expect(captures).toEqual(
      scenario === "download-failed"
        ? []
        : [["bundle", "_4.0.22_", "exec", "fastlane", "ios", "screenshots"]],
    );
    if (scenario === "watch-disabled") {
      expect(commands.filter(([name]) => name === "xcodebuild" || name === "xcrun")).toEqual([]);
    }
  },
);
