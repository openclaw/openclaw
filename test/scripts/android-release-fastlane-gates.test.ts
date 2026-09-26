// Android Fastlane release gate tests keep Play uploads tied to mobile release refs.
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fastfilePath = path.join(process.cwd(), "apps", "android", "fastlane", "Fastfile");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readFastfile(): string {
  return readFileSync(fastfilePath, "utf8");
}

function functionBody(source: string, name: string): string {
  const startMarker = `def ${name}`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane helper ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextDef = rest.search(/\n(?:def|load_env_file|platform) /);
  return nextDef < 0 ? rest : rest.slice(0, nextDef);
}

function laneBody(source: string, name: string): string {
  const startMarker = `lane :${name} do`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane lane ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextLane = rest.search(/\n\s*(?:desc |lane :|end\nend)/);
  return nextLane < 0 ? rest : rest.slice(0, nextLane);
}

describe("Android Fastlane release upload gates", () => {
  it("plans unused phone/Wear pairs from both Play artifact inventories and aborts every read edit", () => {
    const fixtureRoot = tempDirs.make("openclaw-android-plan-");
    const fixtureFastfile = path.join(fixtureRoot, "Fastfile");
    copyFileSync(fastfilePath, fixtureFastfile);
    const source = String.raw`
require "json"
require "open3"
$LOADED_FEATURES << "supply.rb"
module FastlaneCore
  module Interface
    class FastlaneError < StandardError; end
  end
end
module UI
  def self.user_error!(message); raise FastlaneCore::Interface::FastlaneError, message; end
  def self.success(message); end
end
def default_platform(name); end
def platform(name); yield; end
def desc(text); end
$lanes = {}
def lane(name, &block); $lanes[name] = block; end
module Supply
  class Client
    attr_reader :current_edit, :events
    def self.make_from_config(params:); $client; end
    def initialize(codes, apk_codes, failure)
      @codes, @apk_codes, @failure, @events = codes, apk_codes, failure, []
    end
    def begin_edit(package_name:); @events << "begin"; @current_edit = true; end
    def aab_version_codes
      @events << "bundles"
      raise "Play inventory unavailable" if @failure
      @codes
    end
    def apks_version_codes; @events << "apks"; @apk_codes; end
    def abort_current_edit; @events << "abort"; @current_edit = nil; end
  end
end
module Open3
  def self.capture3(*args)
    data = if args.include?("--from-gateway")
      { "pinnedAndroidVersion" => "2026.9.2", "versionCode" => 2026090201 }
    else
      { "canonicalVersion" => "2026.9.2", "versionCode" => 2026090201 }
    end
    [JSON.generate(data), "", Struct.new(:success?).new(true)]
  end
end
ENV["GOOGLE_PLAY_JSON_KEY_DATA"] = "synthetic"
load ARGV.fetch(0)
cases = [
  [[], [], false],
  [[2026090201, 2026090251], [], false],
  [[2026090203], [2026090255], false],
  [[2026080299], [], false],
  [[2026090250], [], false],
  [[2026090301], [], false],
  [[2026090299], [], false],
  [["invalid"], [], false],
  [[], [], true]
]
results = cases.each_with_index.map do |(codes, apk_codes, failure), index|
  $client = Supply::Client.new(codes, apk_codes, failure)
  output = File.join(ARGV.fetch(1), "plan-#{index}.json")
  begin
    $lanes.fetch(:release_plan).call(output_path: output)
    { plan: JSON.parse(File.read(output)), events: $client.events }
  rescue => error
    { error: error.message, output_exists: File.exist?(output), events: $client.events }
  end
end
puts JSON.generate(results)
`;
    const result = spawnSync("ruby", ["-e", source, fixtureFastfile, fixtureRoot], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const results = JSON.parse(result.stdout);
    expect(results.slice(0, 4)).toEqual(
      [1, 2, 6, 1].map((build) => ({
        plan: {
          version: "2026.9.2",
          versionCode: 2026090200 + build,
          wearVersionCode: 2026090250 + build,
        },
        events: ["begin", "bundles", "apks", "abort"],
      })),
    );
    for (const [index, message] of [
      [4, "does not fit the Android phone/Wear build ranges"],
      [5, "already contains a newer Android release"],
      [6, "exhausted phone builds 01 through 49"],
      [7, "invalid versionCode"],
      [8, "Play inventory unavailable"],
    ] as const) {
      expect(results[index].error).toContain(message);
      expect(results[index].output_exists).toBe(false);
      expect(results[index].events.at(-1)).toBe("abort");
    }
  });

  it("publishes Wear releases to the matching form-factor track", () => {
    const wearTrack = functionBody(readFastfile(), "wear_play_track");

    expect(wearTrack).toContain('"wear:#{play_track}"');
    expect(wearTrack).not.toContain('"qa"');
  });

  it("executes the app and Wear signing validators during release preflight", () => {
    const validation = functionBody(readFastfile(), "validate_android_release_signing!");

    expect(validation).toContain('":app:validateSigningPlayRelease"');
    expect(validation).toContain('":wear:validateSigningRelease"');
    expect(validation).toContain('"-PopenclawBuildCommit=#{build_commit}"');
    expect(validation).toContain('"-PopenclawBuildTimestamp=#{build_timestamp}"');
    expect(validation).not.toContain("--dry-run");
    expect(validation).not.toContain(":app:bundlePlayRelease");
    expect(validation).not.toContain(":wear:bundleRelease");
  });

  it("preflights and records mobile release refs around Play build upload", () => {
    const fastfile = readFastfile();
    const uploadBuild = functionBody(fastfile, "upload_play_store_build!");
    const atomicUpload = functionBody(fastfile, "upload_play_builds_atomically!");
    const booleanEnv = functionBody(fastfile, "fastlane_boolean_env");

    expect(fastfile).toContain("def mobile_release_ref_command");
    expect(fastfile).toContain("def release_git_sha");
    expect(fastfile).toContain('"--root"');
    expect(fastfile).toContain('"--sha"');
    expect(fastfile).toContain("repo_root");
    expect(uploadBuild).toContain("release_sha = release_git_sha");
    expect(uploadBuild).toContain("ensure_mobile_release_ref_available!");
    expect(uploadBuild).toContain("record_mobile_release_ref!");
    expect(uploadBuild.match(/sha: release_sha/g)).toHaveLength(2);
    expect(uploadBuild.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild.indexOf("record_mobile_release_ref!")).toBeGreaterThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild).toContain("unless play_validate_only?");
    expect(atomicUpload.match(/client\.upload_bundle\(/g)).toHaveLength(2);
    expect(atomicUpload.match(/client\.begin_edit\(/g)).toHaveLength(1);
    expect(atomicUpload.match(/client\.commit_current_edit!/g)).toHaveLength(1);
    expect(atomicUpload).toContain("client.validate_current_edit!");
    expect(atomicUpload).toContain("client.abort_current_edit");
    expect(atomicUpload).toContain("upload_play_listing_assets!");
    expect(fastfile).toContain("Supply::SCREENSHOT_TYPES.each");
    expect(fastfile).toContain("%w(phoneScreenshots wearScreenshots)");
    expect(booleanEnv).toContain('["1", "yes", "true", "on"]');
    expect(booleanEnv).toContain('["0", "no", "false", "off"]');
    expect(atomicUpload).toContain(
      'fastlane_boolean_env("ACK_BUNDLE_INSTALLATION_WARNING", default: false)',
    );
    expect(atomicUpload).toContain(
      'fastlane_boolean_env("SUPPLY_RESCUE_CHANGES_NOT_SENT_FOR_REVIEW", default: true)',
    );
  });

  it("generates fresh screenshots before building and uploading a release", () => {
    const releaseUpload = laneBody(readFastfile(), "release_upload");

    expect(releaseUpload).toContain("screenshots");
    expect(releaseUpload.indexOf("screenshots")).toBeLessThan(
      releaseUpload.indexOf("build_release_artifacts!"),
    );
    expect(releaseUpload.indexOf("screenshots")).toBeLessThan(
      releaseUpload.indexOf("upload_play_store_build!"),
    );
    expect(releaseUpload).toContain('ENV["SUPPLY_UPLOAD_SCREENSHOTS"] = "1"');
    expect(readFastfile()).toContain("*.{png,jpg,jpeg}");
  });
});
