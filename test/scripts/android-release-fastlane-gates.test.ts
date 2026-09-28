import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const rootDir = process.cwd();
const fastfilePath = path.join(rootDir, "apps", "android", "fastlane", "Fastfile");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture(): string {
  const fixtureRoot = tempDirs.make("openclaw-android-fastlane-");
  mkdirSync(path.join(fixtureRoot, "apps/android"), { recursive: true });
  mkdirSync(path.join(fixtureRoot, "recovery"));
  writeFileSync(path.join(fixtureRoot, "package.json"), '{"version":"2026.9.2"}\n');
  writeFileSync(
    path.join(fixtureRoot, "apps/android/version.json"),
    '{"version":"2026.8.2","versionCode":2026080201}\n',
  );
  writeFileSync(
    path.join(fixtureRoot, ".gitignore"),
    "scripts\nFastfile\norigin.git/\nrecovery/\napps/android/build/\napps/android/fastlane/\n",
  );
  symlinkSync(path.join(rootDir, "scripts"), path.join(fixtureRoot, "scripts"), "dir");
  copyFileSync(fastfilePath, path.join(fixtureRoot, "Fastfile"));
  for (const args of [
    ["init", "-b", "main"],
    ["init", "--bare", "origin.git"],
    ["remote", "add", "origin", path.join(fixtureRoot, "origin.git")],
    ["add", "."],
    ["commit", "-m", "Synthetic Android release source"],
    ["push", "origin", "HEAD:refs/openclaw/mobile-releases/android/2026.8.2-2026080203"],
  ]) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Release Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Release Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    expect(result.status, result.stderr).toBe(0);
  }
  return fixtureRoot;
}

const rubyFastlaneHarness = String.raw`
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
def sh(command)
  args = Shellwords.split(command)
  ref_script = args.index { |arg| arg.end_with?("mobile-release-ref.ts") }
  if ref_script
    operation = args.fetch(ref_script + 1)
    raise "Ref command omitted saved plan" unless args[args.index("--plan").to_i + 1] == ENV.fetch("OPENCLAW_ANDROID_RELEASE_PLAN")
    $events << "ref:#{operation}"
    raise "Cutover marker initialization failed" if $scenario == "initialize-failure" && operation == "initialize-android"
  else
    $events << command
  end
end
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
    def aab_version_codes
      $events << "bundles"
      raise "Play inventory unavailable" if $scenario == "inventory-failure"
      return ["invalid"] if $scenario == "invalid-code"
      return [2026080299] if $scenario == "changed-code" && $edits > 1
      [2026080203]
    end
    def apks_version_codes; $events << "apks"; [2026080253]; end
    def tracks(*names)
      $events << "tracks:#{names.join(',')}"
      tracks = $public_tracks || []
      if $scenario == "changed-baseline" && $edits > 1
        tracks = [track("production", "completed", "2026080203")]
      end
      tracks.select { |entry| names.include?(entry.track) }
    end
    def upload_bundle(file)
      $events << "upload"
      file.include?("wear-release") ? 2026080255 : 2026080254
    end
    def update_track(name, track)
      $tracks[name] = track.releases.map { |release| { codes: release.version_codes, notes: release.release_notes.map(&:to_h) } }
    end
    def commit_current_edit!; $events << "commit"; @current_edit = nil; end
    def validate_current_edit!; $events << "validate-edit"; end
    def abort_current_edit; $events << "abort"; @current_edit = nil; end
  end
end
module Open3
  class << self
    alias_method :real_capture3, :capture3
    def capture3(*args, **options)
      if args.any? { |arg| arg.to_s.end_with?("mobile-release-notes.ts") }
        audience = args[args.index("--audience") + 1]
        identity_matches = args[args.index("--version") + 1] == "2026.9.20" && args[args.index("--build") + 1] == "2026080254"
        if $scenario == "invalid-notes" || !identity_matches
          return ["", "Saved release notes do not match source/build", Struct.new(:success?).new(false)]
        end
        return [audience == "phone" ? "Phone chat improvements.\n" : "Wear voice fixes.\n", "", Struct.new(:success?).new(true)]
      end
      planner = args.index { |arg| arg.to_s.end_with?("android-release-plan.ts") }
      $events << "planner:#{args.fetch(planner + 1)}" if planner
      real_capture3(*args, **options)
    end
  end
end
ENV["GOOGLE_PLAY_JSON_KEY_DATA"] = "synthetic"
%w(MATCH_PASSWORD GOOGLE_PLAY_TRACK GOOGLE_PLAY_RELEASE_STATUS GOOGLE_PLAY_VALIDATE_ONLY OPENCLAW_ANDROID_RELEASE_PLAN).each { |key| ENV.delete(key) }
load ARGV.fetch(0)
$root = ARGV.fetch(1)
def repo_root; $root; end
def android_root; File.join($root, "apps", "android"); end
def play_metadata_path; File.join(android_root, "fastlane", "metadata", "android"); end
def track(name, status, *codes)
  release = AndroidPublisher::TrackRelease.new(status: status, version_codes: codes, name: "Editable label, not a version")
  AndroidPublisher::Track.new(track: name, releases: [release])
end
`;

function runRuby(fixtureRoot: string, source: string): unknown {
  const result = spawnSync(
    "ruby",
    ["-e", rubyFastlaneHarness + "\n" + source, path.join(fixtureRoot, "Fastfile"), fixtureRoot],
    { encoding: "utf8", cwd: rootDir },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

type LaneResult = {
  error?: string;
  events: string[];
  tracks: unknown;
  pinned_notes?: string;
  wear_code?: string;
  plan?: {
    schemaVersion: number;
    version: string;
    versionCode: number;
    wearVersionCode: number;
    releaseNotesBaselines: unknown;
  };
  output_exists?: boolean;
};

describe("Android Fastlane release upload gates", () => {
  it("revalidates the saved plan before cutover and atomically uploads the explicit phone/Wear pair", () => {
    const fixtureRoot = createFixture();
    const results = runRuby(
      fixtureRoot,
      String.raw`
%w(phoneScreenshots wearScreenshots).each do |kind|
  directory = File.join(play_metadata_path, "en-US", "images", kind)
  FileUtils.mkdir_p(directory)
  File.write(File.join(directory, "screenshot.jpg"), "synthetic screenshot")
end
FileUtils.mkdir_p(File.join(android_root, "build", "release-artifacts"))
play_release_artifact_paths("2026.9.20").each { |file| File.write(file, "synthetic signed bundle") }
notes_path = File.join(play_metadata_path, "en-US", "release_notes.txt")
File.write(notes_path, "Pinned archive notes stay unchanged.\n")
plan_path = File.join($root, "recovery", "android-plan.json")
$scenario, $events, $edits, $client = "plan", [], 0, Supply::Client.new
$lanes.fetch(:release_plan).call(output_path: plan_path)
ENV["OPENCLAW_ANDROID_RELEASE_PLAN"] = plan_path
results = %w(invalid-notes changed-baseline changed-code initialize-failure validate-only upload).map do |scenario|
  $scenario, $events, $tracks, $edits, $client = scenario, [], {}, 0, Supply::Client.new
  scenario == "validate-only" ? ENV["GOOGLE_PLAY_VALIDATE_ONLY"] = "1" : ENV.delete("GOOGLE_PLAY_VALIDATE_ONLY")
  begin
    $lanes.fetch(:release_upload).call
    { events: $events, tracks: $tracks, pinned_notes: File.read(notes_path), wear_code: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_WEAR_VERSION_CODE"] }
  rescue => error
    { error: error.message, events: $events, tracks: $tracks }
  end
end
puts JSON.generate(results)
`,
    ) as LaneResult[];
    const [rejected, changedBaseline, changedCode, failedInitialize, validated, uploaded] = results;
    expect(rejected?.error).toContain("Saved release notes do not match source/build");
    expect(rejected?.events).toEqual([]);
    for (const rejectedPlan of [changedBaseline, changedCode]) {
      expect(rejectedPlan?.error).toContain("changed after preparation");
      expect(rejectedPlan?.events).not.toContain("upload");
      expect(rejectedPlan?.events).not.toContain("ref:initialize-android");
      expect(rejectedPlan?.events.at(-1)).toBe("abort");
    }
    expect(failedInitialize?.error).toContain("Cutover marker initialization failed");
    expect(failedInitialize?.events).not.toContain("upload");
    expect(failedInitialize?.events.at(-1)).toBe("abort");
    expect(validated?.error).toBeUndefined();
    expect(validated?.events).toContain("validate-edit");
    expect(validated?.events).not.toContain("commit");
    expect(validated?.events).not.toContain("ref:initialize-android");
    expect(validated?.events).not.toContain("ref:record");
    expect(validated?.events.at(-1)).toBe("abort");
    expect(uploaded?.error).toBeUndefined();
    expect(uploaded?.tracks).toEqual({
      internal: [
        { codes: [2026080254], notes: [{ language: "en-US", text: "Phone chat improvements." }] },
      ],
      "wear:internal": [
        { codes: [2026080255], notes: [{ language: "en-US", text: "Wear voice fixes." }] },
      ],
    });
    const events = uploaded!.events;
    expect(events.filter((event) => event === "commit")).toHaveLength(1);
    expect(events.filter((event) => event === "upload")).toHaveLength(2);
    expect(events.filter((event) => event === "planner:validate")).toHaveLength(2);
    expect(events.indexOf("ref:preflight")).toBeLessThan(events.lastIndexOf("planner:validate"));
    expect(events.lastIndexOf("planner:validate")).toBeLessThan(
      events.indexOf("ref:initialize-android"),
    );
    expect(events.indexOf("ref:initialize-android")).toBeLessThan(events.indexOf("upload"));
    expect(events.indexOf("commit")).toBeLessThan(events.indexOf("ref:record"));
    const screenshots = events.findIndex((event) => event.includes("android-screenshots.sh"));
    const build = events.findIndex((event) => event.includes("build-release-artifacts.ts"));
    expect(screenshots).toBeGreaterThan(-1);
    expect(screenshots).toBeLessThan(build);
    expect(build).toBeLessThan(events.indexOf("upload"));
    expect(events.find((event) => event.includes("./gradlew"))).toContain(
      ":app:validateSigningPlayRelease :wear:validateSigningRelease",
    );
    expect(uploaded?.wear_code).toBe("2026080255");
    expect(uploaded?.pinned_notes).toBe("Pinned archive notes stay unchanged.\n");
  });

  it("passes both artifact inventories and public tracks to the planner and aborts read edits on every outcome", () => {
    const fixtureRoot = createFixture();
    const results = runRuby(
      fixtureRoot,
      String.raw`
cases = [
  ["public", [track("production", "completed", "2026080203"), track("wear:production", "completed", "2026080253"), track("internal", "completed", "2026090204")]],
  ["staged", [track("production", "inProgress", "2026080203")]],
  ["invalid-code", []],
  ["inventory-failure", []]
]
results = cases.each_with_index.map do |(scenario, tracks), index|
  $scenario, $public_tracks, $events, $edits, $client = scenario, tracks, [], 0, Supply::Client.new
  output = File.join($root, "recovery", "plan-#{index}.json")
  begin
    $lanes.fetch(:release_plan).call(output_path: output)
    { plan: JSON.parse(File.read(output)), events: $events }
  rescue => error
    { error: error.message, output_exists: File.exist?(output), events: $events }
  end
end
puts JSON.generate(results)
`,
    ) as LaneResult[];
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.plan).toMatchObject({
      schemaVersion: 2,
      version: "2026.9.20",
      versionCode: 2026080254,
      wearVersionCode: 2026080255,
      releaseNotesBaselines: [
        {
          audience: "phone",
          version: "2026.8.2",
          build: "2026080203",
          sourceRef: "refs/openclaw/mobile-releases/android/2026.8.2-2026080203",
        },
        {
          audience: "wear",
          version: "2026.8.2",
          build: "2026080253",
          sourceRef: "refs/openclaw/mobile-releases/android/2026.8.2-2026080203",
        },
      ],
    });
    expect(results[0]?.events).toEqual([
      "begin",
      "bundles",
      "apks",
      "tracks:production,wear:production",
      "planner:plan",
      "abort",
    ]);
    for (const [index, error] of [
      [1, "ambiguous public release state"],
      [2, "invalid versionCode"],
      [3, "Play inventory unavailable"],
    ] as const) {
      expect(results[index]?.error).toContain(error);
      expect(results[index]?.output_exists).toBe(false);
      expect(results[index]?.events.at(-1)).toBe("abort");
    }
  });
});
