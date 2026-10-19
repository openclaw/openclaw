import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

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
    runtimes.each { |runtime| runtime[:isAvailable] = false } if ARGV[1] == "unavailable"
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
    { encoding: "utf8" },
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
