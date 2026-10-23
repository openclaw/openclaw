import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

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
        isAvailable: available, supportedDeviceTypes: types }
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

it.each([
  ["available", "Apple Watch Series 12 (46mm)", "Apple Watch Series 12 (46mm)", "series-12"],
  ["available", "Apple Watch Ultra 3 (49mm)", "Apple Watch Ultra 4 (49mm)", "ultra-4"],
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
  expect(JSON.parse(result.stdout)).toEqual({ device });
});
