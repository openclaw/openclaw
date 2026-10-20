import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } });
}

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

def available_simulator_devices; []; end
module Open3
  def self.capture3(*arguments)
    raise "unexpected command" unless arguments == ["xcrun", "simctl", "list", "runtimes", "--json"]
    types = [
      { name: "Apple Watch Series 12 (46mm)", identifier: "series-12" },
      { name: "Apple Watch Ultra 4 (49mm)", identifier: "ultra-4" }
    ]
    runtimes = [["26.0", true], ["28.0", false], ["27.0", true]].map do |version, available|
      { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-#{version.tr('.', '-')}", version: version,
        isAvailable: available && ARGV[1] != "unavailable", supportedDeviceTypes: types }
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

const runtimeError =
  "No available watchOS runtime. Install one for the selected Xcode with: xcodebuild -downloadPlatform watchOS";
it.each([
  ["available", "Apple Watch Series 12 (46mm)", "Apple Watch Series 12 (46mm)", "series-12"],
  ["available", "Apple Watch Ultra 3 (49mm)", "Apple Watch Ultra 4 (49mm)", "ultra-4"],
  ["unavailable", "Apple Watch Ultra 3 (49mm)", "", ""],
])("resolves %s runtime for %s without pre-created devices", (scenario, requested, name, id) => {
  const result = run(
    "ruby",
    ["-e", fixture, path.resolve("apps/ios/fastlane/Fastfile"), scenario, requested],
    { CI: "false" },
  );
  expect(result.status, result.stderr).toBe(0);
  const device = {
    name,
    deviceTypeIdentifier: id,
    runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0",
  };
  expect(JSON.parse(result.stdout)).toEqual(
    scenario === "unavailable" ? { error: runtimeError } : { device },
  );
});

const download = ["xcodebuild", "-downloadPlatform", "watchOS", "-buildVersion", "27.0"];
const capture = ["bundle", "_4.0.22_", "exec", "fastlane", "ios", "screenshots"];
it.each<[string, number, string[][], string[][]]>([
  ["installed", 0, [], [capture]],
  ["missing", 0, [download], [capture]],
  ["download-failed", 42, [download], []],
  ["watch-disabled", 0, [], [capture]],
])("prepares runtime: %s", (scenario, status, downloads, captures) => {
  const root = tempDirs.make("watch-runtime-");
  const calls = path.join(root, "calls");
  const installed = path.join(root, "installed");
  const marker = JSON.stringify(installed);
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
    {identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0", version: "27.0", isAvailable: fs.existsSync(${marker})}
  ]}));
} else if (name === "xcodebuild" && args[0] === "-downloadPlatform") {
  if (${JSON.stringify(scenario)} === "download-failed") process.exit(42);
  if (fs.existsSync(${marker})) process.exit(70);
  fs.writeFileSync(${marker}, "");
}
`;
  for (const name of ["xcrun", "xcodebuild", "bundle"]) {
    writeFileSync(path.join(root, name), tool, { mode: 0o755 });
  }
  const result = run("/bin/bash", ["scripts/ios-screenshots.sh"], {
    CI: "true",
    OPENCLAW_SNAPSHOT_SKIP_WATCH: scenario === "watch-disabled" ? "1" : "0",
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
  });
  const commands: string[][] = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(result.status, result.stderr).toBe(status);
  expect(commands.filter((command) => command[1] === "-downloadPlatform")).toEqual(downloads);
  expect(commands.filter((command) => command.includes("fastlane"))).toEqual(captures);
  if (scenario === "watch-disabled") {
    expect(commands.filter(([name]) => name === "xcodebuild" || name === "xcrun")).toEqual([]);
  }
});
