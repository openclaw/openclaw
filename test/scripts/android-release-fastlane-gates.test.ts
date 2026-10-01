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
if ENV["OPENCLAW_TEST_FASTLANE_BUNDLE"] == "1"
  require "fastlane"
  require "supply"
  Fastlane.load_actions
  $supply_commit = Supply::Client.instance_method(:commit_current_edit!)
else
  $LOADED_FEATURES << "supply.rb"
  module FastlaneCore
    class Interface
      class FastlaneError < StandardError; end
    end
  end
end
module TestUI
  def self.user_error!(message); raise FastlaneCore::Interface::FastlaneError.new, message; end
  def self.success(message); end
  def self.message(message); end
  def self.important(message); end
  def self.header(message); end
end
class FastfileFixture
  UI = TestUI
  def parsing_binding; binding; end
  def default_platform(name); end
  def platform(name); yield; end
  def desc(text); end
  def lane(name, &block); define_singleton_method(name) { |options = {}| block.call(options) }; end
end
def fixture_sh(command)
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
  LocalizedText = Struct.new(:language, :text, keyword_init: true) unless const_defined?(:LocalizedText)
  TrackRelease = Struct.new(:name, :status, :version_codes, :release_notes, keyword_init: true) unless const_defined?(:TrackRelease)
  Track = Struct.new(:track, :releases, keyword_init: true) unless const_defined?(:Track)
end
module Supply
  AVAILABLE_METADATA_FIELDS = ["title"] unless const_defined?(:AVAILABLE_METADATA_FIELDS)
  IMAGES_TYPES = ["icon"] unless const_defined?(:IMAGES_TYPES)
  SCREENSHOT_TYPES = %w(phoneScreenshots wearScreenshots) unless const_defined?(:SCREENSHOT_TYPES)
  def self.config; @config; end
  def self.config=(value); @config = value; end
  class Client
    attr_reader :current_edit
    def initialize
      return unless $supply_commit

      self.client = AndroidPublisher::AndroidPublisherService.new
      client.define_singleton_method(:execute_or_queue_command) do |command, &block|
        $committed_query = command.query
        if $scenario == "internal" && command.query.key?("changesNotSentForReview")
          raise "Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set."
        end
        AndroidPublisher::AppEdit.new(id: "synthetic-edit")
      end
    end
    def self.make_from_config(params:); $client; end
    def begin_edit(package_name:)
      $events << "begin"
      $edits += 1
      @current_edit = Struct.new(:id).new("synthetic-edit")
      @current_package_name = package_name
    end
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
      $tracks[name] = track.releases.map { |release| { codes: release.version_codes, status: release.status, notes: release.release_notes.map(&:to_h) } }
    end
    def listing_for_language(language)
      Struct.new(:title) do
        def save; $events << "listing"; end
      end.new
    end
    def upload_image(**); $events << "image"; end
    def clear_screenshots(**); $events << "screenshots"; end
    def commit_current_edit!
      $events << "commit"
      $committed_config = Supply.config
      if $supply_commit
        $supply_commit.bind(self).call
      else
        @current_edit = nil
      end
    end
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
%w(MATCH_PASSWORD GOOGLE_PLAY_TRACK GOOGLE_PLAY_RELEASE_STATUS GOOGLE_PLAY_VALIDATE_ONLY OPENCLAW_ANDROID_RELEASE_PLAN SUPPLY_UPLOAD_METADATA SUPPLY_UPLOAD_SCREENSHOTS SUPPLY_UPLOAD_IMAGES SUPPLY_CHANGES_NOT_SENT_FOR_REVIEW SUPPLY_RESCUE_CHANGES_NOT_SENT_FOR_REVIEW).each { |key| ENV.delete(key) }
if ENV["OPENCLAW_TEST_FASTLANE_BUNDLE"] == "1"
  FastlaneCore::UI.ui_object = TestUI
  fastfile = Fastlane::FastFile.new(ARGV.fetch(0))
  $run_lane = ->(name, options = {}) { fastfile.runner.execute(name, :android, options) }
else
  fastfile = FastfileFixture.new
  eval(File.read(ARGV.fetch(0)), fastfile.parsing_binding, ARGV.fetch(0))
  $run_lane = ->(name, options = {}) { fastfile.public_send(name, options) }
end
$root = ARGV.fetch(1)
def track(name, status, *codes)
  release = AndroidPublisher::TrackRelease.new(status: status, version_codes: codes, name: "Editable label, not a version")
  AndroidPublisher::Track.new(track: name, releases: [release])
end
fastfile.instance_eval do
def sh(command); fixture_sh(command); end
def repo_root; $root; end
def android_root; File.join($root, "apps", "android"); end
def play_metadata_path; File.join(android_root, "fastlane", "metadata", "android"); end
`;

function runRuby(fixtureRoot: string, source: string): unknown {
  const useBundle = process.env.OPENCLAW_TEST_FASTLANE_BUNDLE === "1";
  const rubyArgs = [
    "-e",
    rubyFastlaneHarness + "\n" + source + "\nend",
    path.join(fixtureRoot, "Fastfile"),
    fixtureRoot,
  ];
  const result = spawnSync(
    useBundle ? "bundle" : "ruby",
    useBundle ? ["_4.0.21_", "exec", "ruby", ...rubyArgs] : rubyArgs,
    {
      encoding: "utf8",
      cwd: rootDir,
      env: { ...process.env, BUNDLE_GEMFILE: path.join(rootDir, "apps/android/Gemfile") },
    },
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
  committed_config?: Record<string, boolean | null>;
  committed_query?: Record<string, boolean>;
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
File.write(File.join(play_metadata_path, "en-US", "title.txt"), "Store listing title")
File.write(File.join(play_metadata_path, "en-US", "images", "icon.png"), "synthetic icon")
plan_path = File.join($root, "recovery", "android-plan.json")
$scenario, $events, $edits, $client = "plan", [], 0, Supply::Client.new
$run_lane.call(:release_plan, output_path: plan_path)
ENV["OPENCLAW_ANDROID_RELEASE_PLAN"] = plan_path
results = %w(invalid-destination invalid-notes changed-baseline changed-code initialize-failure validate-only upload internal).map do |scenario|
  $scenario, $events, $tracks, $edits, $client, $committed_config = scenario, [], {}, 0, Supply::Client.new, nil
  $committed_query = nil
  ENV["SUPPLY_CHANGES_NOT_SENT_FOR_REVIEW"] = "true"
  ENV["SUPPLY_RESCUE_CHANGES_NOT_SENT_FOR_REVIEW"] = "false"
  scenario == "validate-only" ? ENV["GOOGLE_PLAY_VALIDATE_ONLY"] = "1" : ENV.delete("GOOGLE_PLAY_VALIDATE_ONLY")
  if scenario == "internal"
    ENV["GOOGLE_PLAY_TRACK"] = "production"
    ENV["GOOGLE_PLAY_RELEASE_STATUS"] = "draft"
    %w(METADATA SCREENSHOTS IMAGES).each { |kind| ENV["SUPPLY_UPLOAD_#{kind}"] = "1" }
    ENV["SUPPLY_RESCUE_CHANGES_NOT_SENT_FOR_REVIEW"] = "true"
    FileUtils.rm_rf(File.join(play_metadata_path, "en-US", "images"))
  end
  begin
    options = case scenario
              when "internal" then { destination: "internal" }
              when "invalid-destination" then { destination: "production" }
              else {}
              end
    $run_lane.call(:release_upload, options)
    { events: $events, tracks: $tracks, pinned_notes: File.read(notes_path), wear_code: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_WEAR_VERSION_CODE"], committed_config: $committed_config, committed_query: $committed_query }
  rescue => error
    { error: error.message, events: $events, tracks: $tracks }
  end
end
STDOUT.puts JSON.generate(results)
`,
    ) as LaneResult[];
    const [
      invalidDestination,
      rejected,
      changedBaseline,
      changedCode,
      failedInitialize,
      validated,
      uploaded,
      internal,
    ] = results;
    expect(internal?.error).toBeUndefined();
    expect(invalidDestination?.error).toContain("destination must be play-store or internal");
    expect(invalidDestination?.events).toEqual([]);
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
        {
          codes: [2026080254],
          status: "completed",
          notes: [{ language: "en-US", text: "Phone chat improvements." }],
        },
      ],
      "wear:internal": [
        {
          codes: [2026080255],
          status: "completed",
          notes: [{ language: "en-US", text: "Wear voice fixes." }],
        },
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
    expect(events).toContain("listing");
    expect(events).toContain("screenshots");
    expect(internal?.tracks).toEqual(uploaded?.tracks);
    expect(internal?.events.filter((event) => event === "upload")).toHaveLength(2);
    expect(internal?.events.filter((event) => event === "commit")).toHaveLength(1);
    expect(internal?.events.at(-1)).toBe("ref:record");
    expect(internal?.events.some((event) => event.includes("android-screenshots.sh"))).toBe(false);
    expect(internal?.events).not.toContain("listing");
    expect(internal?.events).not.toContain("screenshots");
    expect(internal?.events).not.toContain("image");
    expect(internal?.pinned_notes).toBe("Pinned archive notes stay unchanged.\n");
    expect(uploaded?.committed_config).toMatchObject({
      changes_not_sent_for_review: true,
      rescue_changes_not_sent_for_review: false,
    });
    expect(internal?.committed_config).toMatchObject({
      changes_not_sent_for_review: null,
      rescue_changes_not_sent_for_review: false,
    });
    if (process.env.OPENCLAW_TEST_FASTLANE_BUNDLE === "1") {
      expect(uploaded?.committed_query).toEqual({ changesNotSentForReview: true });
      expect(internal?.committed_query).toEqual({});
    }
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
    $run_lane.call(:release_plan, output_path: output)
    { plan: JSON.parse(File.read(output)), events: $events }
  rescue => error
    { error: error.message, output_exists: File.exist?(output), events: $events }
  end
end
STDOUT.puts JSON.generate(results)
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
