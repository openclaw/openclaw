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
  it("uploads distinct generated phone and Wear notes and stops before Play edits when rendering fails", () => {
    const fixtureRoot = tempDirs.make("openclaw-android-notes-");
    const fixtureFastfile = path.join(fixtureRoot, "Fastfile");
    copyFileSync(fastfilePath, fixtureFastfile);
    const source = String.raw`
require "json"
require "open3"
require "fileutils"
$LOADED_FEATURES << "supply.rb"
module FastlaneCore
  module Interface
    class FastlaneError < StandardError; end
  end
end
module UI
  def self.user_error!(message); raise FastlaneCore::Interface::FastlaneError, message; end
  def self.success(message); end
  def self.message(message); end
  def self.important(message); end
end
def default_platform(name); end
def platform(name); yield; end
def desc(text); end
$lanes = {}
def lane(name, &block); $lanes[name] = block; end
def screenshots; $lanes.fetch(:screenshots).call; end
def sh(command); $events << command; end
module AndroidPublisher
  LocalizedText = Struct.new(:language, :text, keyword_init: true)
  TrackRelease = Struct.new(:name, :status, :version_codes, :release_notes, keyword_init: true)
  Track = Struct.new(:track, :releases, keyword_init: true)
end
module Supply
  AVAILABLE_METADATA_FIELDS = []
  SCREENSHOT_TYPES = []
  def self.config; @config; end
  def self.config=(value); @config = value; end
  class Client
    attr_reader :current_edit
    def self.make_from_config(params:); $client; end
    def begin_edit(package_name:); $events << "begin"; $edits += 1; @current_edit = true; end
    def aab_version_codes; []; end
    def apks_version_codes; []; end
    def tracks(*names)
      if $change_baseline && $edits > 1
        release = AndroidPublisher::TrackRelease.new(status: "completed", version_codes: ["2026080203"])
        return [AndroidPublisher::Track.new(track: "production", releases: [release])]
      end
      []
    end
    def upload_bundle(file)
      $events << "upload"
      file.include?("wear-release") ? 2026090252 : 2026090202
    end
    def update_track(name, track)
      $tracks[name] = track.releases.map { |release| { codes: release.version_codes, notes: release.release_notes.map(&:to_h) } }
    end
    def commit_current_edit!; $events << "commit"; @current_edit = nil; end
    def abort_current_edit; $events << "abort"; @current_edit = nil; end
  end
end
module Open3
  def self.capture3(*args)
    if args.any? { |arg| arg.to_s.end_with?("mobile-release-notes.ts") }
      audience = args[args.index("--audience") + 1]
      identity_matches = args[args.index("--version") + 1] == "2026.9.2" && args[args.index("--build") + 1] == "2026090202"
      if $reject_notes || !identity_matches
        return ["", "Saved release notes do not match source/build", Struct.new(:success?).new(false)]
      end
      return [audience == "phone" ? "Phone chat improvements.\n" : "Wear voice fixes.\n", "", Struct.new(:success?).new(true)]
    end
    output = args.first == "git" ? "a" * 40 : JSON.generate(canonicalVersion: "2026.9.2", versionCode: 2026090202)
    [output, "", Struct.new(:success?).new(true)]
  end
end
ENV["GOOGLE_PLAY_JSON_KEY_DATA"] = "synthetic"
%w(MATCH_PASSWORD GOOGLE_PLAY_TRACK GOOGLE_PLAY_RELEASE_STATUS GOOGLE_PLAY_VALIDATE_ONLY).each { |key| ENV.delete(key) }
load ARGV.fetch(0)
$root = ARGV.fetch(1)
def repo_root; $root; end
def android_root; File.join($root, "apps", "android"); end
def play_metadata_path; File.join(android_root, "fastlane", "metadata", "android"); end
%w(phoneScreenshots wearScreenshots).each do |kind|
  directory = File.join(play_metadata_path, "en-US", "images", kind)
  FileUtils.mkdir_p(directory)
  File.write(File.join(directory, "screenshot.jpg"), "synthetic screenshot")
end
FileUtils.mkdir_p(File.join(android_root, "build", "release-artifacts"))
play_release_artifact_paths("2026.9.2").each { |file| File.write(file, "synthetic signed bundle") }
notes_path = File.join(play_metadata_path, "en-US", "release_notes.txt")
File.write(notes_path, "Pinned archive notes stay unchanged.\n")
plan_path = File.join($root, "android-plan.json")
File.write(plan_path, JSON.generate(releaseNotesBaselines: [
  { audience: "phone", version: nil, build: nil },
  { audience: "wear", version: nil, build: nil }
]))
ENV["OPENCLAW_ANDROID_RELEASE_PLAN"] = plan_path
results = [[true, false], [false, true], [false, false]].map do |reject, changed|
  $reject_notes, $change_baseline, $events, $tracks, $edits = reject, changed, [], {}, 0
  $client = Supply::Client.new
  begin
    $lanes.fetch(:release_upload).call
    { events: $events, tracks: $tracks, pinned_notes: File.read(notes_path) }
  rescue => error
    { error: error.message, events: $events, tracks: $tracks }
  end
end
puts JSON.generate(results)
`;
    const result = spawnSync("ruby", ["-e", source, fixtureFastfile, fixtureRoot], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const [rejected, changed, uploaded] = JSON.parse(result.stdout);
    expect(rejected.error).toContain("Saved release notes do not match source/build");
    expect(rejected.events).toEqual([]);
    expect(changed.error).toContain("production releases changed");
    expect(changed.events).not.toContain("upload");
    expect(changed.events.at(-1)).toBe("abort");
    expect(uploaded.tracks).toEqual({
      internal: [
        { codes: [2026090202], notes: [{ language: "en-US", text: "Phone chat improvements." }] },
      ],
      "wear:internal": [
        { codes: [2026090252], notes: [{ language: "en-US", text: "Wear voice fixes." }] },
      ],
    });
    expect(uploaded.events.filter((event: string) => event === "commit")).toHaveLength(1);
    expect(uploaded.pinned_notes).toBe("Pinned archive notes stay unchanged.\n");
  });

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
    def initialize(codes, apk_codes, failure, tracks)
      @codes, @apk_codes, @failure, @tracks, @events = codes, apk_codes, failure, tracks, []
    end
    def begin_edit(package_name:); @events << "begin"; @current_edit = true; end
    def aab_version_codes
      @events << "bundles"
      raise "Play inventory unavailable" if @failure
      @codes
    end
    def apks_version_codes; @events << "apks"; @apk_codes; end
    def tracks(*names); @events << "tracks"; @tracks; end
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
def track(name, status, *codes)
  release = Struct.new(:status, :version_codes, :name).new(status, codes, "Editable label, not a version")
  Struct.new(:track, :releases).new(name, [release])
end
cases = [
  [[], [], false],
  [[2026090201, 2026090251], [], false],
  [[2026090203], [2026090255], false],
  [[2026080299], [], false],
  [[2026090250], [], false],
  [[2026090301], [], false],
  [[2026090299], [], false],
  [["invalid"], [], false],
  [[], [], true],
  [[], [], false, [track("production", "completed", "2026080203"), track("wear:production", "completed", "2026070452"), track("internal", "completed", "2026090299")]],
  [[], [], false, [track("production", "draft", "2026080203")]],
  [[], [], false, [track("production", "inProgress", "2026080203")]],
  [[], [], false, [track("wear:production", "halted", "2026080253")]],
  [[], [], false, [track("production", "completed", "2026080203", "2026080204")]],
  [[], [], false, [track("wear:production", "completed", "2026080203")]],
  [[], [], false, [track("production", "completed", "2026130203")]]
]
results = cases.each_with_index.map do |(codes, apk_codes, failure, tracks), index|
  $client = Supply::Client.new(codes, apk_codes, failure, tracks || [])
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
          releaseNotesBaselines: [
            { audience: "phone", version: null, build: null },
            { audience: "wear", version: null, build: null },
          ],
        },
        events: ["begin", "bundles", "apks", "tracks", "abort"],
      })),
    );
    for (const [index, message] of [
      [4, "does not fit the Android phone/Wear build ranges"],
      [5, "already contains a newer Android release"],
      [6, "exhausted phone builds 01 through 49"],
      [7, "invalid versionCode"],
      [8, "Play inventory unavailable"],
      [11, "ambiguous public release state"],
      [12, "ambiguous public release state"],
      [13, "multiple public builds"],
      [14, "cannot identify an OpenClaw wear release"],
      [15, "cannot identify an OpenClaw phone release"],
    ] as const) {
      expect(results[index].error).toContain(message);
      expect(results[index].output_exists).toBe(false);
      expect(results[index].events.at(-1)).toBe("abort");
    }
    expect(results[9].plan.releaseNotesBaselines).toEqual([
      { audience: "phone", version: "2026.8.2", build: "2026080203" },
      { audience: "wear", version: "2026.7.4", build: "2026070452" },
    ]);
    expect(results[10].plan.releaseNotesBaselines).toEqual([
      { audience: "phone", version: null, build: null },
      { audience: "wear", version: null, build: null },
    ]);
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
