// iOS Fastlane release gate tests keep TestFlight upload on one canonical path.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fastfilePath = path.join(process.cwd(), "apps", "ios", "fastlane", "Fastfile");
const packageJsonPath = path.join(process.cwd(), "package.json");
const legacyReleaseScriptPath = path.join(process.cwd(), "scripts", "ios-release.sh");
const uploadScriptPath = path.join(process.cwd(), "scripts", "ios-release-upload.sh");
const snapshotUITestPath = path.join(
  process.cwd(),
  "apps",
  "ios",
  "UITests",
  "OpenClawSnapshotUITests.swift",
);
const rootTabsPath = path.join(process.cwd(), "apps", "ios", "Sources", "RootTabs.swift");
const ciWorkflowPath = path.join(process.cwd(), ".github", "workflows", "ci.yml");
const rubyVersionPath = path.join(process.cwd(), "apps", "ios", ".ruby-version");
const gemfilePath = path.join(process.cwd(), "apps", "ios", "Gemfile");
const gemfileLockPath = path.join(process.cwd(), "apps", "ios", "Gemfile.lock");
const iosReadmePath = path.join(process.cwd(), "apps", "ios", "README.md");
const fastlaneSetupPath = path.join(process.cwd(), "apps", "ios", "fastlane", "SETUP.md");
const metadataReadmePath = path.join(
  process.cwd(),
  "apps",
  "ios",
  "fastlane",
  "metadata",
  "README.md",
);
const screenshotsScriptPath = path.join(process.cwd(), "scripts", "ios-screenshots.sh");

function runIosScreenshotsCommand(
  options: {
    bundleCheckExit?: number;
    bundleExit?: number;
    conflictingGemfile?: boolean;
  } = {},
) {
  const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-fastlane-"));
  const tracePath = path.join(fixture, "trace.log");
  const writeExecutable = (name: string, body: string) => {
    const executable = path.join(fixture, name);
    writeFileSync(executable, `#!/usr/bin/env bash\n${body}\n`, "utf8");
    chmodSync(executable, 0o755);
  };
  writeExecutable(
    "bundle",
    '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
      '[[ "${1:-}" == "_4.0.21_" ]] || exit 92\n' +
      `[[ "\${2:-}" != "check" ]] || exit ${options.bundleCheckExit ?? 0}\n` +
      'printf "bundle:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n' +
      `exit ${options.bundleExit ?? 0}`,
  );
  writeExecutable("fastlane", 'printf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"');

  try {
    const result = spawnSync("bash", [screenshotsScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_GEMFILE: options.conflictingGemfile ? path.join(fixture, "Gemfile") : "",
        OPENCLAW_FASTLANE_EXPECTED_GEMFILE: gemfilePath,
        OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
        PATH: `${fixture}:/usr/bin:/bin`,
      },
    });
    return {
      result,
      trace: existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "",
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

function readFastfile(): string {
  return readFileSync(fastfilePath, "utf8");
}

function laneBody(source: string, name: string): string {
  const startMarker = `lane :${name} do`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane lane ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextLane = rest.search(/\n\s+(?:desc|lane|private_lane) /);
  return nextLane < 0 ? rest : rest.slice(0, nextLane);
}

function functionBody(source: string, name: string): string {
  const startMarker = `def ${name}`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastfile function ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextFunction = rest.search(/\ndef /);
  return nextFunction < 0 ? rest : rest.slice(0, nextFunction);
}

function functionDefinition(source: string, name: string): string {
  const start = source.indexOf(`def ${name}`);
  if (start < 0) {
    throw new Error(`missing Fastfile function ${name}`);
  }
  const rest = source.slice(start);
  const nextFunction = rest.slice(1).search(/\ndef /);
  return nextFunction < 0 ? rest : rest.slice(0, nextFunction + 1);
}

function runReleaseReconcileFixture(scenario: string) {
  const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-reconcile-fastlane-"));
  const outputPath = path.join(fixture, "observation.json");
  const source = readFastfile();
  const ruby = String.raw`
require "json"
require "fileutils"
require "time"

module UI
  def self.user_error!(message); raise message; end
end

module Spaceship
  module ConnectAPI
    module Platform
      IOS = "IOS"
    end
  end
end

BuildBetaDetail = Struct.new(:internal_build_state)
Build = Struct.new(
  :id, :app_version, :version, :platform, :processing_state, :expired, :build_beta_detail
)
Upload = Struct.new(
  :id, :cf_build_short_version_string, :cf_build_version, :platform, :state, :uploaded_date
)
Group = Struct.new(:id, :is_internal_group, :has_access_to_all_builds, :builds) do
  def fetch_builds
    builds
  end
end
App = Struct.new(:id, :bundle_id, :builds, :groups) do
  def get_builds(**)
    builds
  end
  def get_beta_groups(**)
    groups
  end
end

${functionDefinition(source, "normalized_app_store_timestamp")}
${functionDefinition(source, "ios_release_reconcile_observation!")}

group_id = "group-primary"
build = Build.new(
  "build-1", "2026.9.20", "1", "IOS", "VALID", false,
  BuildBetaDetail.new("READY_FOR_BETA_TESTING")
)
upload = Upload.new(
  "upload-1", "2026.9.20", "1", "IOS",
  { "state" => "COMPLETE", "errors" => [], "infos" => [], "warnings" => [] },
  "2026-09-10T00:55:00Z"
)
target = Group.new(group_id, true, true, [build])
other = Group.new("other-group", true, false, [])
builds = [build]
uploads = [upload]
groups = [target, other]

case ARGV.fetch(0)
when "scalar-state"
  upload.state = "COMPLETE"
when "missing-state-diagnostics"
  upload.state = { "state" => "COMPLETE" }
when "valid-state-diagnostics"
  upload.state = {
    "state" => "COMPLETE",
    "warnings" => [{ "code" => "notice", "description" => "retained warning" }]
  }
when "malformed-state-diagnostics"
  upload.state = {
    "state" => "COMPLETE",
    "errors" => nil,
    "infos" => [],
    "warnings" => []
  }
when "malformed-state-entry"
  upload.state = {
    "state" => "COMPLETE",
    "errors" => [{ "code" => 7 }]
  }
when "extra-state-field"
  upload.state = { "state" => "COMPLETE", "unexpected" => [] }
when "duplicate-upload"
  uploads << upload.dup
when "duplicate-build"
  builds << build.dup
when "invalid-build"
  build.processing_state = "PROCESSING"
when "extra-assignment"
  other.builds = [build]
when "automatic-nontarget"
  other.has_access_to_all_builds = true
when "unknown-automatic"
  other.has_access_to_all_builds = nil
when "unknown-internal"
  other.is_internal_group = nil
when "target-not-automatic"
  target.has_access_to_all_builds = false
when "unusable-internal-state"
  build.build_beta_detail.internal_build_state = "MISSING_EXPORT_COMPLIANCE"
when "missing-target"
  groups = [other]
end

$fixture_app = App.new("1234567890", "com.example.release", builds, groups)
$fixture_uploads = uploads
def app_store_connect_target_app
  $fixture_app
end
def app_store_build_uploads(app_id:, short_version:)
  raise "wrong app" unless app_id == "1234567890" && short_version == "2026.9.20"
  $fixture_uploads
end

begin
  result = ios_release_reconcile_observation!(
    app_store_version: "2026.9.20",
    build_number: "1",
    configured_group_id: group_id,
    output_path: ARGV.fetch(1)
  )
  puts JSON.generate({ ok: true, result: result })
rescue => error
  puts JSON.generate({ ok: false, error: error.message })
end
`;
  try {
    const result = spawnSync("ruby", ["-e", ruby, scenario, outputPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return {
      outcome: JSON.parse(result.stdout) as {
        error?: string;
        ok: boolean;
        result?: Record<string, unknown>;
      },
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

function swiftFunctionBody(source: string, name: string): string {
  const startMarker = `func ${name}(`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Swift function ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextFunction = rest.search(/\n {4}(?:private )?func /);
  return nextFunction < 0 ? rest : rest.slice(0, nextFunction);
}

describe("iOS Fastlane release upload gates", () => {
  it("observes the existing App Store build without mutating it", () => {
    for (const scenario of ["accepted", "missing-state-diagnostics", "valid-state-diagnostics"]) {
      const { outcome, output } = runReleaseReconcileFixture(scenario);

      expect(outcome.ok).toBe(true);
      const observation = JSON.parse(output);
      expect(observation).toMatchObject({
        readOnly: true,
        upload: { state: { state: "COMPLETE" } },
        build: { processingState: "VALID", expired: false },
      });
      expect(observation.groups).toEqual([
        {
          containsBuild: true,
          hasAccessToAllBuilds: true,
          id: "group-primary",
          isInternalGroup: true,
        },
        {
          containsBuild: false,
          hasAccessToAllBuilds: false,
          id: "other-group",
          isInternalGroup: true,
        },
      ]);
    }
  });

  it.each([
    ["scalar-state", "complete StateDetail object"],
    ["malformed-state-diagnostics", "complete StateDetail object"],
    ["malformed-state-entry", "complete StateDetail object"],
    ["extra-state-field", "complete StateDetail object"],
    ["duplicate-upload", "Expected one iOS build upload"],
    ["duplicate-build", "Expected one iOS TestFlight build"],
    ["invalid-build", "not VALID and unexpired"],
    ["extra-assignment", "not assigned exclusively"],
    ["automatic-nontarget", "non-target internal TestFlight group"],
    ["unknown-automatic", "group flags must be explicit booleans"],
    ["unknown-internal", "group flags must be explicit booleans"],
    ["target-not-automatic", "automatic internal TestFlight group"],
    ["unusable-internal-state", "not usable for internal testing"],
    ["missing-target", "does not uniquely contain"],
  ])("rejects unsafe existing-build state: %s", (scenario, error) => {
    const { outcome, output } = runReleaseReconcileFixture(scenario);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain(error);
    expect(output).toBe("");
  });

  it("uses the build attached to the latest public version for notes and rejects missing history", () => {
    const source = String.raw`
require "json"
module UI
  def self.user_error!(message); raise message; end
end
def default_platform(*); end
def desc(*); end
def platform(*); yield; end
def lane(*); end
alias private_lane lane
load ARGV.fetch(0)
Build = Struct.new(:id, :version)
Version = Struct.new(:version_string, :app_version_state, :build) do
  def get_build
    raise "read a non-public build" unless ["2026.7.2", "2026.7.21"].include?(version_string)
    build
  end
end
old = Version.new("2026.7.2", "REPLACED_WITH_NEW_VERSION", Build.new("old", "8"))
latest = Version.new("2026.7.21", "READY_FOR_DISTRIBUTION", Build.new("public", "3"))
candidate = Version.new("2026.7.22", "PREPARE_FOR_SUBMISSION", Build.new("testflight", "19"))
rows = %w[public delisted first missing ambiguous].map do |scenario|
  latest.app_version_state = scenario == "delisted" ? "DEVELOPER_REMOVED_FROM_SALE" : "READY_FOR_DISTRIBUTION"
  latest.build = scenario == "missing" ? nil : Build.new("public", "3")
  versions = scenario == "first" ? [candidate] : [candidate, latest, old]
  versions << latest.dup if scenario == "ambiguous"
  begin
    { scenario: scenario, baseline: ios_public_release_notes_baseline(versions) }
  rescue => error
    { scenario: scenario, error: error.message }
  end
end
puts JSON.generate(rows)
`;
    const result = spawnSync("ruby", ["-e", source, fastfilePath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { scenario: "public", baseline: { audience: "ios", version: "2026.7.21", build: "3" } },
      { scenario: "delisted", baseline: { audience: "ios", version: "2026.7.21", build: "3" } },
      { scenario: "first", baseline: { audience: "ios", version: null, build: null } },
      { scenario: "missing", error: expect.stringContaining("no identifiable attached build") },
      {
        scenario: "ambiguous",
        error: expect.stringContaining("Ambiguous public App Store version"),
      },
    ]);
  });

  it("recovers notes and build selection on the registered stage lane without uploading again", () => {
    const source = String.raw`
require "json"
module UI
  def self.user_error!(message); raise message; end
  def self.success(*); end
  def self.important(*); end
  def self.message(*); end
end
def default_platform(*); end
def desc(*); end
def platform(*); yield; end
def lane(name, &body); define_singleton_method(name, &body); end
alias private_lane lane
load ARGV.fetch(0)
module Spaceship
  module ConnectAPI
    module Platform
      IOS = "IOS"
    end
    class Build
      def self.all(**options)
        raise "wrong build lookup" unless options == {
          app_id: "app", version: "2026.7.21", build_number: "3", platform: "IOS", includes: "preReleaseVersion"
        }
        $builds
      end
    end
  end
end
Build = Struct.new(:id, :version, :app_version, :processing_state, :expired)
Localization = Struct.new(:locale, :whats_new) do
  def update(attributes:)
    $events << "notes"
    raise "notes rejected" if $scenario == "notes-failure"
    self.whats_new = attributes.fetch(:whats_new)
  end
end
Version = Struct.new(:version_string, :app_version_state, :selected, :localization) do
  def get_build; selected; end
  def get_app_store_version_localizations; [localization]; end
  def select_build(build_id:)
    $events << "select"
    raise "selection rejected" if $scenario == "selection-failure"
    self.selected = $builds.find { |build| build.id == build_id }
    localization.whats_new = "stale" if $scenario == "readback-failure"
  end
end
App = Struct.new(:id, :versions) do
  def get_app_store_versions(**); versions; end
end
def read_ios_version_metadata(**)
  { version: "2026.7.2", short_version: "2026.7.21", app_store_revision: "1" }
end
def render_ios_release_notes(short_version:, build_number:)
  raise "wrong notes identity" unless [short_version, build_number] == ["2026.7.21", "3"]
  "Saved public release notes.\n"
end
def assert_ios_uploaded_release_source!(**)
  raise "source mismatch" if $scenario == "source-mismatch"
end
def app_store_connect_api_key_config; end
def app_store_connect_target_app; $app; end
def resolve_app_store_connect_app(**); $app; end
def upload_to_testflight(**); raise "reupload attempted"; end
def resolve_ios_release_plan!(**); raise "replanning attempted"; end
ENV["OPENCLAW_IOS_RELEASE_WRAPPER"] = "1"
rows = %w[success first source-mismatch processing expired missing ambiguous locked newer notes-failure selection-failure readback-failure retry].map do |scenario|
  $scenario, $events = scenario, []
  build = Build.new("uploaded", "3", "2026.7.21", scenario == "processing" ? "PROCESSING" : "VALID", scenario == "expired")
  $builds = scenario == "missing" ? [] : [build]
  $builds << build.dup if scenario == "ambiguous"
  version = Version.new("2026.7.21", scenario == "locked" ? "IN_REVIEW" : "PREPARE_FOR_SUBMISSION", nil, Localization.new("en-US", "Previous notes"))
  version.selected = Build.new("newer", "4") if scenario == "newer"
  if scenario == "retry"
    version.selected = build
    version.localization.whats_new = "Saved public release notes.\n"
  end
  versions = [version]
  versions << Version.new("2026.7.2", "READY_FOR_DISTRIBUTION") unless scenario == "first"
  $app = App.new("app", versions)
  error = nil
  begin
    release_stage(release_version: "2026.7.2", app_store_revision: "1", build_number: "3")
  rescue => failure
    error = failure.message
  end
  { scenario: scenario, events: $events, error: error, selected: version.selected&.id, notes: version.localization.whats_new }
end
puts JSON.generate(rows)
`;
    const result = spawnSync("ruby", ["-e", source, fastfilePath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      scenario: string;
      events: string[];
      error: string | null;
      selected: string | null;
      notes: string;
    }[];
    for (const row of rows) {
      if (["success", "retry"].includes(row.scenario)) {
        expect(row.error).toBeNull();
        expect(row.selected).toBe("uploaded");
        expect(row.notes).toBe("Saved public release notes.\n");
        expect(row.events).toEqual(["notes", "select"]);
      } else if (row.scenario === "first") {
        expect(row.error).toBeNull();
        expect(row.selected).toBe("uploaded");
        expect(row.notes).toBe("Previous notes");
        expect(row.events).toEqual(["select"]);
      } else {
        const expectedErrors: Record<string, string> = {
          "source-mismatch": "source mismatch",
          processing: "not a valid, unexpired processed build",
          expired: "not a valid, unexpired processed build",
          missing: "found 0",
          ambiguous: "found 2",
          locked: "locked in state IN_REVIEW",
          newer: "already selects newer build 4",
          "notes-failure": "notes rejected",
          "selection-failure": "selection rejected",
          "readback-failure": "staging readback did not match",
        };
        expect(row.error).toContain(expectedErrors[row.scenario]);
        const expectedEvents =
          row.scenario === "notes-failure"
            ? ["notes"]
            : ["selection-failure", "readback-failure"].includes(row.scenario)
              ? ["notes", "select"]
              : [];
        expect(row.events).toEqual(expectedEvents);
      }
    }
  });

  it("uploads the planned iOS build without Android preparation and records only accepted uploads", () => {
    const source = String.raw`
require "json"
module UI
  def self.user_error!(message); raise message; end
  def self.success(*); end
  def self.important(*); end
end
def default_platform(*); end
def desc(*); end
def platform(*); yield; end
def lane(name, &body); define_singleton_method(name, &body); end
alias private_lane lane
load ARGV.fetch(0)
def sh(*); raise "unexpected external preparation"; end
def step(name)
  @events << name
  raise "failed #{name}" if @failure == name
end
def release_signing_check!; step("signing"); end
def app_store_connect_api_key_config; :fixture_key; end
def resolve_ios_release_plan!(**)
  @plans += 1
  step(@plans == 1 ? "plan" : "recheck")
  { "gatewayVersion" => "2026.7.2", "appStoreRevision" => 1,
    "buildNumber" => 3, "appStoreVersion" => "2026.7.21" }
end
def assert_ios_release_notes_baseline!(_plan); step(@plans == 1 ? "baseline" : "baseline-recheck"); end
def render_ios_release_notes(**); step("notes"); "Saved notes"; end
def read_ios_version_metadata(**)
  { version: "2026.7.2", short_version: "2026.7.21", app_store_revision: "1" }
end
def pin_release_build_provenance!
  { git_commit: "a" * 40, build_timestamp: "2026-09-25T12:00:00.000Z" }
end
def prepare_app_store_release!(version:, app_store_revision:, build_number:)
  raise "wrong release identity" unless [version, app_store_revision, build_number] == ["2026.7.2", "1", "3"]
  ENV["XCODE_XCCONFIG_FILE"] = "fixture.xcconfig"
end
def preflight_app_store_version!(**); step("store-preflight"); end
def ensure_mobile_release_ref_available!(**); step("ref-preflight"); end
def without_xcode_xcconfig_file; yield; end
def preserve_local_signing; yield; end
def self.screenshots(**); step("screenshots"); end
def verify_apple_release_source!(*); step("source"); end
def build_app_store_release(context)
  step("archive")
  context.merge(ipa_path: "fixture.ipa")
end
def self.metadata(**)
  raise "missing release metadata" unless ENV["DELIVER_SCREENSHOTS"] == "1" && ENV["DELIVER_RELEASE_NOTES"] == "0"
  step("metadata")
end
def upload_to_testflight(**options)
  raise "unexpected distribution" unless options == {
    api_key: :fixture_key, ipa: "fixture.ipa", skip_submission: true,
    skip_waiting_for_build_processing: false,
    wait_processing_timeout_duration: 3600, uses_non_exempt_encryption: false
  }
  step("upload")
end
def record_mobile_release_ref!(**options)
  raise "wrong release ref" unless options == {
    platform: "ios", version: "2026.7.21", build: "3", sha: "a" * 40
  }
  step("record")
end
def self.release_stage(**)
  step("stage")
end
rows = %w[success notes screenshots archive recheck baseline-recheck metadata upload stage direct].map do |scenario|
  @events, @plans, @failure = [], 0, scenario
  ENV["OPENCLAW_IOS_RELEASE_WRAPPER"] = scenario == "direct" ? "" : "1"
  error = nil
  begin
    release_upload({})
  rescue => failure
    error = failure.message
  end
  { scenario: scenario, events: @events, error: error, xcconfig: ENV["XCODE_XCCONFIG_FILE"] }
end
puts JSON.generate(rows)
`;
    const result = spawnSync("ruby", ["-e", source, fastfilePath], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      scenario: string;
      events: string[];
      error: string | null;
      xcconfig: string | null;
    }[];
    const steps = [
      "signing",
      "plan",
      "baseline",
      "notes",
      "store-preflight",
      "ref-preflight",
      "screenshots",
      "source",
      "archive",
      "recheck",
      "baseline-recheck",
      "metadata",
      "upload",
      "record",
      "stage",
    ];
    for (const row of rows) {
      expect(row.xcconfig).toBeNull();
      if (row.scenario === "success") {
        expect(row.error).toBeNull();
        expect(row.events).toEqual(steps);
      } else if (row.scenario === "direct") {
        expect(row.events).toEqual([]);
        expect(row.error).toContain("Use `pnpm ios:release:upload`");
      } else {
        expect(row.error).toBe(`failed ${row.scenario}`);
        expect(row.events).toEqual(steps.slice(0, steps.indexOf(row.scenario) + 1));
      }
    }
  });

  it("pins the CI Ruby and Fastlane toolchain on the Fastlane-owning screenshot shards", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const iosJobStart = workflow.indexOf("\n  ios-build:\n");
    const iosJobEnd = workflow.indexOf("\n  ios-screenshot-shard:\n", iosJobStart);
    const iosJob = workflow.slice(iosJobStart, iosJobEnd);
    const shardJobEnd = workflow.indexOf("\n  ios-screenshot-evidence:\n", iosJobEnd);
    const shardJob = workflow.slice(iosJobEnd, shardJobEnd);
    const gemfile = readFileSync(gemfilePath, "utf8");
    const lockfile = readFileSync(gemfileLockPath, "utf8");

    expect(readFileSync(rubyVersionPath, "utf8")).toBe("3.4.10\n");
    expect(gemfile).toContain('gem "fastlane", "2.240.1"');
    expect(gemfile).toContain('ruby "3.4.10"');
    expect(lockfile).toContain("fastlane (2.240.1)");
    expect(lockfile).toContain("arm64-darwin");
    expect(lockfile).toContain("x86_64-darwin");
    expect(lockfile).toContain("CHECKSUMS");
    expect(lockfile).toContain("RUBY VERSION\n  ruby 3.4.10");
    expect(lockfile).toContain("BUNDLED WITH\n  4.0.21");
    expect(iosJob).not.toContain("BUNDLE_DEPLOYMENT");
    expect(iosJob).not.toContain("BUNDLE_GEMFILE");
    expect(iosJob).not.toContain("ruby/setup-ruby@");
    expect(iosJob).not.toContain("Install locked Fastlane bundle");
    expect(shardJob).toContain('BUNDLE_DEPLOYMENT: "true"');
    expect(shardJob).toContain("BUNDLE_GEMFILE: ${{ github.workspace }}/apps/ios/Gemfile");
    expect(shardJob).toContain("ruby/setup-ruby@a0102e0972be65f351c307e2d64b9314a57c8073");
    expect(shardJob).toContain('ruby-version: "3.4.10"');
    expect(shardJob).toContain('bundler: "4.0.21"');
    expect(shardJob).toContain("bundler-cache: false");
    expect(shardJob).toContain("working-directory: apps/ios");
    expect(shardJob).toContain("bundle _4.0.21_ install --jobs 4 --retry 3");
    expect(shardJob).toContain("bundle _4.0.21_ check");
    expect(shardJob).toContain("bundle _4.0.21_ exec fastlane --version");
    expect(workflow.match(/ruby\/setup-ruby@/gu)).toHaveLength(1);
    expect(workflow.match(/name: Install locked Fastlane bundle/gu)).toHaveLength(1);
  });

  it("documents every iOS Fastlane command through the pinned bundle", () => {
    const documentedCommands = [iosReadmePath, fastlaneSetupPath, metadataReadmePath].flatMap(
      (documentationPath) =>
        readFileSync(documentationPath, "utf8")
          .split("\n")
          .filter((line) => /\bfastlane (?:ios [a-z_]+|spaceauth)\b/u.test(line)),
    );

    expect(documentedCommands.length).toBeGreaterThan(0);
    for (const command of documentedCommands) {
      expect(command).toContain('BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane');
    }
  });

  it("documents a direct Fastlane command that rejects an inherited Gemfile", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-fastlane-docs-"));
    const bundlePath = path.join(fixture, "bundle");
    const tracePath = path.join(fixture, "trace.log");
    writeFileSync(
      bundlePath,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$BUNDLE_GEMFILE" > "$OPENCLAW_FASTLANE_TEST_TRACE"\n',
      "utf8",
    );
    chmodSync(bundlePath, 0o755);

    try {
      const result = spawnSync(
        "bash",
        ["-c", 'BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane ios auth_check'],
        {
          cwd: path.join(process.cwd(), "apps", "ios"),
          encoding: "utf8",
          env: {
            ...process.env,
            BUNDLE_GEMFILE: path.join(fixture, "Gemfile"),
            OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
            PATH: `${fixture}:/usr/bin:/bin`,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(tracePath, "utf8")).toBe(`${gemfilePath}\n`);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("uses the repository bundle when Fastlane is also on PATH", () => {
    const { result, trace } = runIosScreenshotsCommand();

    expect(result.status).toBe(0);
    expect(trace).toBe("bundle:_4.0.21_ exec fastlane ios screenshots\n");
  });

  it("fails closed when the repository bundle fails", () => {
    const { result, trace } = runIosScreenshotsCommand({ bundleExit: 42 });

    expect(result.status).toBe(42);
    expect(trace).toBe("bundle:_4.0.21_ exec fastlane ios screenshots\n");
  });

  it("prints the pinned setup command when the repository bundle is unavailable", () => {
    const { result, trace } = runIosScreenshotsCommand({ bundleCheckExit: 1 });

    expect(result.status).toBe(1);
    expect(trace).toBe("");
    expect(result.stderr).toContain("Install Ruby 3.4.10");
    expect(result.stderr).toContain("gem install bundler -v 4.0.21");
    expect(result.stderr).toContain("bundle _4.0.21_ install");
  });

  it("ignores a conflicting inherited Gemfile on the pinned path", () => {
    const { result, trace } = runIosScreenshotsCommand({ conflictingGemfile: true });

    expect(result.status).toBe(0);
    expect(trace).toBe("bundle:_4.0.21_ exec fastlane ios screenshots\n");
  });

  it("fails closed when the repository Gemfile is absent", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-fastlane-missing-gemfile-"));
    const wrapperPath = path.join(fixture, "scripts", "lib", "ios-fastlane.sh");
    const binDir = path.join(fixture, "bin");
    const tracePath = path.join(fixture, "trace.log");
    mkdirSync(path.dirname(wrapperPath), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    copyFileSync(path.join(process.cwd(), "scripts", "lib", "ios-fastlane.sh"), wrapperPath);
    const inheritedGemfile = path.join(fixture, "Gemfile");
    writeFileSync(inheritedGemfile, 'gem "fastlane"\n', "utf8");
    const fastlanePath = path.join(binDir, "fastlane");
    writeFileSync(
      fastlanePath,
      '#!/usr/bin/env bash\nprintf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n',
      "utf8",
    );
    chmodSync(fastlanePath, 0o755);

    try {
      const result = spawnSync(
        "bash",
        ["-c", `source "${wrapperPath}"; run_ios_fastlane ios screenshots`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BUNDLE_GEMFILE: inheritedGemfile,
            OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
            PATH: `${binDir}:/usr/bin:/bin`,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(existsSync(tracePath)).toBe(false);
      expect(result.stderr).toContain("repository iOS Gemfile is missing");
      expect(result.stderr).toContain("Restore it from the repository checkout");
      expect(result.stderr).toContain("bundle _4.0.21_ install");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("does not keep the old package release alias", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts).toHaveProperty("ios:release:upload");
    expect(packageJson.scripts).toHaveProperty("ios:release:plan");
    expect(packageJson.scripts).toHaveProperty("ios:release:cut");
    expect(packageJson.scripts).not.toHaveProperty("ios:release");
    expect(existsSync(legacyReleaseScriptPath)).toBe(false);
  });

  it("routes the package upload wrapper through the guarded Fastlane lane", () => {
    const script = readFileSync(uploadScriptPath, "utf8");

    expect(script).toContain("OPENCLAW_IOS_RELEASE_WRAPPER=1");
    expect(script).not.toContain("Missing required --version.");
    expect(script).not.toContain("Missing required --revision.");
    expect(script).toContain('"release_version:${RELEASE_VERSION}"');
    expect(script).toContain('"app_store_revision:${APP_STORE_REVISION}"');
    expect(script).toContain('"build_number:${BUILD_NUMBER}"');
    expect(script).toContain("DELIVER_NUMBER_OF_THREADS=1");
    expect(script).toContain("FL_MAX_NUMBER_OF_THREADS=1");
    expect(script).toContain('run_ios_fastlane "${FASTLANE_ARGS[@]}"');
  });

  it("keeps release_upload as the only Fastlane TestFlight upload implementation", () => {
    const fastfile = readFastfile();
    const uploadCalls = fastfile.match(/\bupload_to_testflight\s*\(/g) ?? [];

    expect(uploadCalls).toHaveLength(1);
    expect(laneBody(fastfile, "release_upload")).toContain("upload_to_testflight(");
    expect(fastfile).not.toMatch(/\n\s+lane :app_store do\b/);
    expect(fastfile).not.toContain("Deprecated. Use `pnpm ios:release:upload`.");
  });

  it("rejects direct Fastlane upload before release work", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const prepareContext = laneBody(fastfile, "prepare_app_store_context");

    expect(releaseUpload).toContain('ENV["OPENCLAW_IOS_RELEASE_WRAPPER"] == "1"');
    expect(releaseUpload).toContain("Use `pnpm ios:release:upload`");
    expect(prepareContext).toContain("options[:release_version]");
    expect(prepareContext).toContain("options[:app_store_revision]");
    expect(prepareContext).toContain("options[:build_number]");
    expect(prepareContext).toContain("resolve_ios_release_plan!");
    expect(prepareContext).toContain('release_plan.fetch("gatewayVersion")');
    expect(prepareContext).toContain('release_plan.fetch("appStoreRevision")');
    expect(prepareContext).toContain('release_plan.fetch("buildNumber")');
    expect(releaseUpload).toContain("app_store_revision: context[:app_store_revision]");
    expect(laneBody(fastfile, "metadata")).toContain("options[:release_version]");
    expect(laneBody(fastfile, "metadata")).toContain("Missing iOS gateway version");
    expect(laneBody(fastfile, "metadata")).toContain("Missing iOS App Store revision");
    expect(releaseUpload.indexOf("UI.user_error!")).toBeLessThan(
      releaseUpload.indexOf("prepare_app_store_context"),
    );
  });

  it("preflights the exact App Store version before screenshots and archive work", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const preflight = functionBody(fastfile, "preflight_app_store_version!");

    expect(preflight).toContain("EDITABLE_APP_STORE_VERSION_STATES");
    expect(preflight).toContain("RELEASED_APP_STORE_VERSION_STATES");
    expect(fastfile).toContain('"READY_FOR_SALE"');
    expect(fastfile).toContain('"REMOVED_FROM_SALE"');
    expect(fastfile).toContain('"DEVELOPER_REMOVED_FROM_SALE"');
    expect(fastfile).not.toMatch(
      /EDITABLE_APP_STORE_VERSION_STATES = \[[\s\S]*?"WAITING_FOR_REVIEW"[\s\S]*?\]\.freeze/,
    );
    expect(preflight).toContain("Revisions are never reused");
    expect(preflight).toContain("higher version");
    expect(releaseUpload).toContain("preflight_app_store_version!");
    expect(releaseUpload.indexOf("preflight_app_store_version!")).toBeLessThan(
      releaseUpload.indexOf("screenshots("),
    );
    expect(releaseUpload.indexOf("preflight_app_store_version!")).toBeLessThan(
      releaseUpload.indexOf("build = build_app_store_release(context)"),
    );
  });

  it("validates explicit build numbers against the exact App Store version", () => {
    const resolver = functionBody(readFastfile(), "resolve_release_build_number");

    expect(resolver).toContain("app_store_build_uploads");
    expect(resolver).toContain("IOS_BUILD_UPLOAD_STATES");
    expect(resolver).toContain("expected #{next_build}");
    expect(resolver).toContain("explicit.to_i != next_build");
    expect(resolver).toContain("api_key.nil?");
    expect(resolver).not.toContain("latest_testflight_build_number");
  });

  it("plans revisions and builds from App Store versions and build uploads", () => {
    const fastfile = readFastfile();
    const planner = functionBody(fastfile, "resolve_ios_release_plan!");
    const planLane = laneBody(fastfile, "release_plan");
    const uploadState = functionBody(fastfile, "app_store_build_upload_state");

    expect(planner).toContain("get_app_store_versions");
    expect(planner).toContain("app_store_build_uploads");
    expect(planner).toContain("app_store_build_upload_state(upload)");
    expect(uploadState).toContain('detail["state"]');
    expect(uploadState).toContain("expected a StateDetail object");
    expect(planner).toContain("does not match canonical root version");
    expect(planner).toContain('File.join(repo_root, "scripts", "ios-release-plan.ts")');
    expect(planLane).toContain("resolve_ios_release_plan!");
    expect(planLane).toContain("JSON.pretty_generate(plan)");
  });

  it("validates the exported IPA before the sole TestFlight upload call", () => {
    const fastfile = readFastfile();
    const validationCall = fastfile.indexOf("expected_commit: context[:git_commit]");
    const uploadCall = fastfile.indexOf("upload_to_testflight(");

    expect(validationCall).toBeGreaterThanOrEqual(0);
    expect(uploadCall).toBeGreaterThan(validationCall);
  });

  it("rechecks the plan after local validation and before the first App Store mutation", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const build = releaseUpload.indexOf("build = build_app_store_release(context)");
    const planRecheck = releaseUpload.lastIndexOf("resolve_ios_release_plan!");
    const metadata = releaseUpload.indexOf("\n    metadata(");
    const upload = releaseUpload.indexOf("upload_to_testflight(");

    expect(fastfile).not.toContain("def verify_app_store_binary!");
    expect(releaseUpload).not.toContain("verify_only: true");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(planRecheck).toBeGreaterThan(build);
    expect(metadata).toBeGreaterThan(planRecheck);
    expect(upload).toBeGreaterThan(planRecheck);
  });

  it("finishes fallible local release work before mutating App Store metadata", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const screenshots = releaseUpload.indexOf(
      "screenshots(\n          release_version: context[:version]",
    );
    const sourceCheck = releaseUpload.indexOf("verify_apple_release_source!(release_sha)");
    const build = releaseUpload.indexOf("build = build_app_store_release(context)");
    const metadata = releaseUpload.indexOf("metadata(\n      release_version: context[:version]");

    expect(screenshots).toBeGreaterThanOrEqual(0);
    expect(sourceCheck).toBeGreaterThan(screenshots);
    expect(build).toBeGreaterThan(sourceCheck);
    expect(metadata).toBeGreaterThan(build);
  });

  it("fails from authoritative Xcode results and keeps successful bundles outside screenshots", () => {
    const fastfile = readFastfile();
    const screenshots = laneBody(fastfile, "screenshots");
    const capture = functionBody(fastfile, "capture_release_ios_screenshot!");
    const archive = functionBody(fastfile, "archive_snapshot_test_result!");
    const attemptRecorder = functionBody(fastfile, "record_release_ios_screenshot_attempt!");
    const attemptWriter = functionBody(fastfile, "write_release_ios_screenshot_attempts!");
    const verifier = functionBody(fastfile, "verify_snapshot_test_result!");

    expect(screenshots).toContain("devices = snapshot_devices");
    const prepare = screenshots.indexOf('"../../../scripts/ios-simulator-prepare.sh"');
    expect(prepare).toBeGreaterThan(screenshots.indexOf('device_udid = device.fetch("udid")'));
    expect(prepare).toBeLessThan(
      screenshots.indexOf('sh("xcrun", "simctl", "bootstatus", device_udid'),
    );
    expect(screenshots).toContain('ENV.fetch("OPENCLAW_CI_SIMSLIM_BINARY", "").empty?');
    expect(screenshots).toContain('"build-for-testing"');
    expect(screenshots).toContain("RELEASE_IOS_SCREENSHOT_TESTS.each");
    expect(screenshots).toContain("capture_release_ios_screenshot!(");
    expect(screenshots).toContain(
      "result_bundle_archive_directory: result_bundle_archive_directory",
    );
    expect(capture).toContain("verify_snapshot_test_result!");
    expect(attemptRecorder).toContain('"captureOutcome" => capture_outcome');
    expect(attemptRecorder).toContain("write_release_ios_screenshot_attempts!(");
    expect(attemptWriter).toContain('"schemaVersion" => 1');
    expect(archive).toContain('"#{device}-#{screenshot_name}-attempt-#{attempt}.xcresult"');
    expect(screenshots).toContain("verify_release_ios_screenshot_manifest!(");
    expect(screenshots).toContain(
      'result_bundle_archive_directory = File.join(ios_root, "build", "SnapshotTestResults")',
    );
    expect(screenshots).toContain(
      'capture_attempts_path = File.join(result_bundle_archive_directory, "capture-attempts.json")',
    );
    expect(screenshots.indexOf("capture_release_ios_screenshot!")).toBeLessThan(
      screenshots.indexOf('FileUtils.rm_rf(File.join(output_directory, "test_output"))'),
    );
    expect(verifier).toContain('"xcresulttool"');
    expect(verifier).toContain('summary.fetch("failedTests")');
    expect(verifier).toContain("UI.test_failure!");
  });

  it("preserves the first screenshot failure and records one capture without retrying", () => {
    const fastfile = readFastfile();
    const source = `
require "json"
require "fileutils"
require "tmpdir"
require "shellwords"
module UI
  def self.important(*); end
  def self.message(*); end
end
SNAPSHOT_STATUS_BAR_ARGUMENTS = "fixture"
APP_STORE_APP_IDENTIFIER = "fixture.app"
IOS_SCREENSHOT_XCARGS = "fixture"
${[
  "archive_snapshot_test_result!",
  "write_release_ios_screenshot_attempts!",
  "record_release_ios_screenshot_attempt!",
  "run_screenshot_xcodebuild!",
  "capture_release_ios_screenshot!",
]
  .map((name) => functionDefinition(fastfile, name))
  .join("\n")}
def shell_join(parts)
  Shellwords.join(parts)
end
def repo_root
  "/fixture"
end
def sh(*arguments, **options)
  command = arguments.last
  return JSON.generate({ APP_STORE_APP_IDENTIFIER => {} }) if command.include?("simctl listapps")
  if arguments[0, 3] == ["xcrun", "simctl", "uninstall"]
    @uninstalls += 1
    return
  end
  @calls += 1
  raise "settings lookup" if command.include?("showBuildSettings")
  raise "rebooted simulator" if command.include?("simctl")
  raise "missing test selection" unless command.include?("-only-testing:OpenClawUITests/OpenClawSnapshotUITests/fixture-test")
  raise "not using built products" unless command.include?("test-without-building")
  parts = Shellwords.split(command)
  log_path = parts.fetch(parts.index("run_apple_command_logged") + 1)
  FileUtils.mkdir_p(File.dirname(log_path))
  File.write(log_path, "native capture log")
  FileUtils.mkdir_p(@result_path)
  File.write(File.join(@result_path, "result"), "capture #{@calls}")
  raise "synthetic capture failure" if @scenario == "capture" && @calls == 1
  File.write(@screenshot_path, "fresh screenshot")
end
def verify_snapshot_test_result!(*)
  @checks += 1
  raise "synthetic result failure" if @scenario == "result" && @checks == 1
end
rows = %w[capture result success].map do |scenario|
  Dir.mktmpdir("openclaw-capture-") do |root|
    @scenario, @calls, @checks, @uninstalls = scenario, 0, 0, 0
    @result_path = File.join(root, "current.xcresult")
    archive = File.join(root, "archive")
    logs = File.join(root, "logs")
    FileUtils.mkdir_p(archive)
    FileUtils.mkdir_p(File.join(root, "en-US"))
    FileUtils.mkdir_p(File.join(root, "screenshots"))
    @screenshot_path = File.join(root, "screenshots", "fixture-device-fixture-screen.png")
    ledger = File.join(archive, "capture-attempts.json")
    error = nil
    begin
      capture_release_ios_screenshot!(
        project: "fixture", device: "fixture-device",
        screenshot: { test: "fixture-test", name: "fixture-screen" },
        output_directory: root, result_bundle_path: @result_path,
        result_bundle_archive_directory: archive, capture_attempts: [],
        log_directory: logs,
        capture_attempts_path: ledger, derived_data_path: root,
        device_udid: "fixture-udid", snapshot_cache_directory: root
      )
    rescue => failure
      error = failure.message
    end
    { scenario: scenario, calls: @calls, checks: @checks, uninstalls: @uninstalls, error: error,
      attempts: JSON.parse(File.read(ledger)).fetch("attempts"),
      evidenceEntries: Dir.children(archive).sort,
      log: File.read(File.join(logs, "fixture-device-fixture-screen.log")),
      archived: File.read(File.join(archive, "fixture-device-fixture-screen-attempt-1.xcresult", "result")) }
  end
end
puts JSON.generate(rows)
`;
    const result = spawnSync("ruby", ["-e", source], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      scenario: string;
      calls: number;
      checks: number;
      uninstalls: number;
      error: string | null;
      attempts: { attempt: number; captureOutcome: string }[];
      archived: string;
      evidenceEntries: string[];
      log: string;
    }[];
    expect(
      rows.map(({ scenario, calls, checks, error }) => ({ scenario, calls, checks, error })),
    ).toEqual([
      { scenario: "capture", calls: 1, checks: 0, error: "synthetic capture failure" },
      { scenario: "result", calls: 1, checks: 1, error: "synthetic result failure" },
      { scenario: "success", calls: 1, checks: 1, error: null },
    ]);
    for (const row of rows) {
      expect(row.uninstalls).toBe(1);
      expect(row.attempts).toEqual([
        expect.objectContaining({
          attempt: 1,
          captureOutcome: row.scenario === "success" ? "succeeded" : "failed",
        }),
      ]);
      expect(row.archived).toBe("capture 1");
      expect(row.evidenceEntries).toEqual([
        "capture-attempts.json",
        "fixture-device-fixture-screen-attempt-1.xcresult",
      ]);
      expect(row.log).toBe("native capture log");
    }
  });

  it("captures each release screen from an independent direct launch", () => {
    const snapshotUITest = readFileSync(snapshotUITestPath, "utf8");
    const releaseTests = [
      ["testReleaseControlScreenshot", "controlScreenshotTarget"],
      ["testReleaseChatScreenshot", "chatScreenshotTarget"],
      ["testReleaseAgentScreenshot", "agentScreenshotTarget"],
      ["testReleaseSettingsScreenshot", "settingsScreenshotTarget"],
    ] as const;
    const captureHelper = swiftFunctionBody(snapshotUITest, "captureReleaseScreenshot");
    const launchHelper = swiftFunctionBody(snapshotUITest, "launchApp");
    const navigationTest = swiftFunctionBody(
      snapshotUITest,
      "testAgentsNavigateToSettingsThroughSidebar",
    );
    const rootTabs = readFileSync(rootTabsPath, "utf8");

    for (const [testName, targetName] of releaseTests) {
      const releaseTest = swiftFunctionBody(snapshotUITest, testName);
      expect(releaseTest).toContain(`self.captureReleaseScreenshot(Self.${targetName})`);
    }
    expect(captureHelper.match(/self\.launchApp\(/g)).toHaveLength(1);
    expect(captureHelper).toContain("waitForReleaseScreenshotTarget");
    expect(launchHelper).toContain("app.launch()");
    expect(snapshotUITest).not.toContain("screenshotLaunchRetryThreshold");
    expect(snapshotUITest).not.toContain("selectReleaseScreenshotDestination");
    expect(navigationTest).toContain("self.launchApp(for: Self.agentScreenshotTarget)");
    expect(navigationTest).toContain('self.selectSidebarDestination("Settings")');
    expect(navigationTest).toContain('"SettingsHub.Fallback"');
    expect(navigationTest).not.toContain("XCTExpectFailure");
    expect(navigationTest).not.toContain("XCTExpectedFailure");
    expect(rootTabs).toContain("self.scenePhase == .active");
    expect(rootTabs).toContain("self.selectedSidebarDestination.rawValue");
  });

  it("requires the exact nonempty PNG manifest before Watch capture", () => {
    const fastfile = readFastfile();
    const screenshots = laneBody(fastfile, "screenshots");
    const snapshotDevices = functionBody(fastfile, "snapshot_devices");
    const defaultSnapshotDevices = functionBody(fastfile, "default_snapshot_devices");
    const verifier = functionBody(fastfile, "verify_release_ios_screenshot_manifest!");

    expect(fastfile).toContain("REQUIRED_IOS_SCREENSHOT_NAMES");
    expect(snapshotDevices).toContain('ENV["OPENCLAW_SNAPSHOT_DEVICES"]');
    expect(snapshotDevices).toContain("return default_snapshot_devices if raw.empty?");
    expect(defaultSnapshotDevices).toContain("available_simulator_devices");
    expect(defaultSnapshotDevices).toContain('ENV["OPENCLAW_SNAPSHOT_DEVICE_FAMILY"]');
    expect(defaultSnapshotDevices).toContain("families = DEFAULT_SNAPSHOT_DEVICE_FAMILIES");
    expect(defaultSnapshotDevices).toContain("families = [family]");
    expect(verifier).toContain("expected_names - actual_names");
    expect(verifier).toContain("actual_names - expected_names");
    expect(verifier).toContain("File.size?(path)");
    expect(verifier).toContain("PNG_SIGNATURE");
    expect(screenshots.indexOf("verify_release_ios_screenshot_manifest!")).toBeGreaterThan(
      screenshots.indexOf("RELEASE_IOS_SCREENSHOT_TESTS.each"),
    );
    expect(screenshots.indexOf("verify_release_ios_screenshot_manifest!")).toBeLessThan(
      screenshots.indexOf("capture_watch_screenshot"),
    );
    expect(screenshots).toContain('ENV["OPENCLAW_SNAPSHOT_SKIP_WATCH"] == "1"');
  });

  it("reuses only the current screenshot build for Watch while standalone capture builds fresh", () => {
    const source = `
require "json"
require "tmpdir"
module UI
  def self.user_error!(message)
    raise message
  end
  def self.success(message); end
end
def default_platform(*); end
def desc(*); end
def platform(*)
  yield
end
def lane(name, &body)
  define_singleton_method(name, &body)
end
alias private_lane lane
load ARGV.fetch(0)

def repo_root
  @root
end
def ios_root
  File.join(@root, "apps", "ios")
end
def snapshot_devices
  ["iPad Pro 13-inch"]
end
def available_simulator_devices
  [
    { "name" => "iPad Pro 13-inch", "udid" => "older-ipad", "runtime" => "com.apple.CoreSimulator.SimRuntime.iOS-26-0" },
    { "name" => "iPad Pro 13-inch", "udid" => "ipad-simulator", "runtime" => "com.apple.CoreSimulator.SimRuntime.iOS-27-0" }
  ]
end
def resolve_simulator_device(_name)
  { "name" => "Apple Watch Ultra 3 (49mm)", "udid" => "watch-simulator" }
end
def write_watch_screenshot_mode_defaults(*); end
def clear_watch_screenshot_mode_defaults(*); end
def set_watch_status_bar_override(*)
  false
end
def normalize_watch_screenshot_status_bar(*); end
def sleep(*); end

def make_product(derived_data_path)
  app = File.join(derived_data_path, "Build", "Products", "Debug-watchsimulator", "OpenClawWatchApp.app")
  raise "stale product survived clean build" if File.exist?(File.join(app, "stale"))
  return if @scenario == "missing"
  FileUtils.mkdir_p(app)
  File.write(File.join(app, "Info.plist"), "fixture.watch") unless @scenario == "invalid-plist"
end
module Open3
  def self.capture3(command, *args)
    raise "unexpected external command: #{command}" unless command == "/usr/libexec/PlistBuddy"
    [File.read(args.last), "", Struct.new(:success?).new(true)]
  end
end
def run_screenshot_xcodebuild!(arguments, log_path:)
  raise "not building test products" unless arguments.last == "build-for-testing"
  FileUtils.mkdir_p(File.dirname(log_path))
  File.write(log_path, "native build log")
  @builds << "snapshot"
  raise "snapshot build failed" if @scenario == "build-failure"
  make_product(arguments.fetch(arguments.index("-derivedDataPath") + 1))
end
def capture_release_ios_screenshot!(**options)
  raise "capture before successful build" unless @builds == ["snapshot"]
  raise "selected older runtime" unless options.fetch(:device_udid) == "ipad-simulator"
  name = options.fetch(:screenshot).fetch(:name)
  output = File.join(options.fetch(:output_directory), "en-US", "#{options.fetch(:device)}-#{name}.png")
  FileUtils.mkdir_p(File.dirname(output))
  File.binwrite(output, PNG_SIGNATURE + "fixture")
  FileUtils.mkdir_p(File.join(options.fetch(:result_bundle_archive_directory), "#{name}.xcresult"))
  options.fetch(:capture_attempts) << { name: name, outcome: "passed" }
  write_release_ios_screenshot_attempts!(
    attempts: options.fetch(:capture_attempts), output_path: options.fetch(:capture_attempts_path)
  )
end
def sh(command, *arguments)
  args = arguments.empty? ? Shellwords.split(command) : [command, *arguments]
  @commands << args
  if args.include?("xcodebuild") && args.include?("build")
    @builds << "watch"
    raise "Watch build failed" if @scenario == "standalone-build-failure"
    make_product(args.fetch(args.index("-derivedDataPath") + 1))
  elsif args[0, 3] == ["xcrun", "simctl", "install"]
    @installed = args.last.sub(@root, "")
    raise "simulator rejected Watch product" if @scenario == "invalid-install"
  elsif args[0, 3] == ["xcrun", "simctl", "io"]
    File.binwrite(args.last, PNG_SIGNATURE + "watch")
  end
end

results = %w[combined iphone standalone standalone-build-failure missing invalid-plist invalid-install build-failure].map do |scenario|
  Dir.mktmpdir("openclaw-watch-build-") do |root|
    @root, @scenario, @builds, @commands, @installed = root, scenario, [], [], nil
    ENV["HOME"] = root
    logs = File.join(ios_root, "build", "SnapshotLogs")
    FileUtils.mkdir_p(logs)
    File.write(File.join(logs, "stale.log"), "previous invocation")
    %w[SnapshotDerivedData WatchScreenshotDerivedData].each do |directory|
      app = File.join(ios_root, "build", directory, "Build", "Products", "Debug-watchsimulator", "OpenClawWatchApp.app")
      FileUtils.mkdir_p(app)
      File.write(File.join(app, "stale"), "previous invocation")
    end
    if scenario.start_with?("standalone")
      output = File.join(ios_root, "fastlane", "screenshots", "en-US")
      FileUtils.mkdir_p(output)
      File.write(File.join(output, "Apple Watch Ultra 3 (49mm)-01-now-face.png"), "previous screenshot")
    end
    ENV["OPENCLAW_SNAPSHOT_SKIP_WATCH"] = scenario == "iphone" ? "1" : "0"
    error = nil
    begin
      options = { release_version: "2026.9.1", app_store_revision: "2", build_number: "123" }
      scenario.start_with?("standalone") ? watch_screenshot(options) : screenshots(options)
    rescue => failure
      error = failure.message.sub(root, "")
    end
    {
      scenario: scenario, builds: @builds, error: error, installed: @installed,
      pngs: Dir[File.join(ios_root, "fastlane", "screenshots", "en-US", "*.png")].length,
      xcresults: Dir[File.join(ios_root, "build", "SnapshotTestResults", "*.xcresult")].length,
      attempts: File.exist?(File.join(ios_root, "build", "SnapshotTestResults", "capture-attempts.json")),
      evidenceEntries: Dir.glob(File.join(ios_root, "build", "SnapshotTestResults", "*")).map { |entry| File.basename(entry) }.sort,
      logs: Dir.children(logs).sort,
      versions: @commands.select { |args| args.any? { |arg| arg.end_with?("/ios-write-version-xcconfig.sh") } }
        .map { |args| args.drop(2) }
    }
  end
end
puts JSON.generate(results)
`;
    const result = spawnSync("ruby", ["-e", source, fastfilePath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      scenario: string;
      builds: string[];
      error: string | null;
      installed: string | null;
      pngs: number;
      xcresults: number;
      attempts: boolean;
      evidenceEntries: string[];
      logs: string[];
      versions: string[][];
    }[];
    const row = (scenario: string) => rows.find((entry) => entry.scenario === scenario)!;
    const versionArgs = ["--version", "2026.9.1", "--revision", "2", "--build-number", "123"];
    expect(row("combined")).toMatchObject({
      builds: ["snapshot"],
      error: null,
      installed:
        "/apps/ios/build/SnapshotDerivedData/Build/Products/Debug-watchsimulator/OpenClawWatchApp.app",
      pngs: 5,
      xcresults: 4,
      attempts: true,
      evidenceEntries: [
        "01-control-connected.xcresult",
        "02-chat-connected.xcresult",
        "03-agent-connected.xcresult",
        "04-settings-connected.xcresult",
        "capture-attempts.json",
      ],
      logs: ["build.log"],
      versions: [versionArgs],
    });
    expect(row("iphone")).toMatchObject({
      builds: ["snapshot"],
      error: null,
      installed: null,
      pngs: 4,
    });
    expect(row("standalone")).toMatchObject({
      builds: ["watch"],
      error: null,
      installed:
        "/apps/ios/build/WatchScreenshotDerivedData/Build/Products/Debug-watchsimulator/OpenClawWatchApp.app",
      pngs: 1,
      versions: [versionArgs],
    });
    expect(row("standalone-build-failure")).toMatchObject({
      builds: ["watch"],
      error: "Watch build failed",
      installed: null,
      pngs: 0,
    });
    for (const scenario of ["missing", "invalid-plist", "invalid-install"]) {
      expect(row(scenario), scenario).toMatchObject({
        builds: ["snapshot"],
        pngs: 4,
        xcresults: 4,
        attempts: true,
      });
    }
    expect(row("missing").error).toContain("Watch screenshot build did not produce");
    expect(row("invalid-plist").error).toContain("Expected Info.plist");
    expect(row("invalid-install").error).toBe("simulator rejected Watch product");
    expect(row("build-failure")).toMatchObject({
      builds: ["snapshot"],
      error: "snapshot build failed",
      installed: null,
      pngs: 0,
      xcresults: 0,
    });
  });

  it("runs screenshot shards alongside builds without changing runner authorization", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const iosJobStart = workflow.indexOf("\n  ios-build:\n");
    const iosJobEnd = workflow.indexOf("\n  ios-screenshot-shard:\n", iosJobStart);
    const iosJob = workflow.slice(iosJobStart, iosJobEnd);
    const shardJobStart = iosJobEnd;
    const shardJobEnd = workflow.indexOf("\n  ios-screenshot-evidence:\n", shardJobStart);
    const shardJob = workflow.slice(shardJobStart, shardJobEnd);
    const reducerJobStart = shardJobEnd;
    const reducerJobEnd = workflow.indexOf("\n  android:\n", reducerJobStart);
    const reducerJob = workflow.slice(reducerJobStart, reducerJobEnd);

    expect(workflow).toContain('IOS_SCREENSHOT_NODE_VERSION: "24.16.0"');
    expect(workflow).toContain('IOS_SCREENSHOT_XCODE_VERSION: "Xcode 27.0 Build version 27A266a"');
    expect(iosJob).toContain("timeout-minutes: 150");
    expect(iosJob).not.toContain("Capture iOS release screenshots");
    expect(shardJob).toContain("needs: [preflight]");
    expect(shardJob).toContain("max-parallel: 2");
    expect(shardJob).toContain("device_family: [iphone, ipad-13]");
    expect(shardJob).toContain(
      "OPENCLAW_SNAPSHOT_SKIP_WATCH: ${{ matrix.device_family == 'iphone' && '1' || '0' }}",
    );
    expect(shardJob).not.toContain("run_ios_fastlane ios watch_screenshot");
    expect(shardJob).toContain("run: pnpm ios:screenshots");
    expect(shardJob).toContain("id: package_screenshot_evidence");
    expect(shardJob).toContain('if [[ "$DEVICE_FAMILY" == "ipad-13" ]]; then');
    expect(
      shardJob.match(/node \.ci-harness\/scripts\/ios-screenshot-evidence\.mjs/g),
    ).toHaveLength(2);
    expect(shardJob).not.toContain("node scripts/ios-screenshot-evidence.mjs");
    expect(shardJob).toContain("steps.package_screenshot_evidence.outcome == 'failure'");
    expect(shardJob).toContain("steps.device_screenshots.outcome == 'failure'");
    expect(shardJob).toContain("apps/ios/build/SnapshotTestResults/capture-attempts.json");
    expect(shardJob).not.toContain("IOS_SCREENSHOT_FASTLANE_VERSION");
    expect(shardJob).toContain("IOS_SCREENSHOT_NODE_VERSION");
    expect(shardJob).toContain("IOS_SCREENSHOT_XCODE_VERSION");
    expect(shardJob).not.toContain('test "$fastlane_version" = "$IOS_SCREENSHOT_FASTLANE_VERSION"');
    expect(shardJob).toContain("node-version: ${{ env.IOS_SCREENSHOT_NODE_VERSION }}");
    expect(shardJob).not.toContain("SnapshotDerivedData");
    expect(shardJob.match(/contents: read/g)).toHaveLength(1);
    expect(reducerJob).toContain("needs: [preflight, ios-screenshot-shard]");
    expect(reducerJob).toContain("merge-multiple: false");
    expect(reducerJob).toContain("Setup screenshot evidence Node");
    expect(reducerJob).toContain("node-version: ${{ env.IOS_SCREENSHOT_NODE_VERSION }}");
    expect(reducerJob).toContain("id: reduce_screenshot_evidence");
    expect(reducerJob).toContain("node .ci-harness/scripts/ios-screenshot-evidence.mjs reduce");
    expect(reducerJob).not.toContain("node scripts/ios-screenshot-evidence.mjs");
    expect(reducerJob).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(reducerJob).toContain('--run-id "$RUN_ID"');
    expect(reducerJob).toContain('--run-attempt "$RUN_ATTEMPT"');
    expect(reducerJob).toContain('--xcode-version "$IOS_SCREENSHOT_XCODE_VERSION"');
    expect(reducerJob).toContain('--fastlane-version "$IOS_SCREENSHOT_FASTLANE_VERSION"');
    expect(reducerJob).toContain('--node-version "$(node --version)"');
    expect(reducerJob).toContain("steps.reduce_screenshot_evidence.outcome == 'failure'");
    expect(reducerJob).toContain("apps/ios/build/ScreenshotEvidenceInputs/**/xcresults/*.xcresult");
    expect(reducerJob).toContain(
      "name: ios-release-screenshots-${{ needs.preflight.outputs.checkout_revision }}",
    );
    expect(reducerJob).toContain("apps/ios/build/ScreenshotEvidence/manifest.json");
    expect(reducerJob).not.toContain("SnapshotDerivedData");
  });

  it("records the installed Fastlane semver before the update notice", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const parser = workflow.match(/run_ios_fastlane --version 2>&1 \| awk '([^']+)'/u)?.[1];

    expect(parser).toBeDefined();
    const result = spawnSync("awk", [parser!], {
      encoding: "utf8",
      input:
        "fastlane installation at path:\nfastlane 2.236.1\n# fastlane 2.238.0 is available. You are on 2.236.1.\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2.236.1\n");
  });

  it("preserves caller-pinned Swift tools in archive build PATH", () => {
    const fastfile = readFastfile();
    const pathBuilder = functionBody(fastfile, "xcodebuild_shell_join");
    const callerPath = 'ENV.fetch("PATH", "").split(File::PATH_SEPARATOR)';

    expect(pathBuilder).toContain(callerPath);
    expect(pathBuilder).toContain(".reject(&:empty?).uniq.join(File::PATH_SEPARATOR)");
    expect(pathBuilder).toContain(
      "system_tools_first ? [*system_path, *caller_path] : [*caller_path, *system_path]",
    );
  });

  it("uses Apple's matched rsync pair when exporting the IPA", () => {
    const fastfile = readFastfile();
    const builder = functionBody(fastfile, "build_app_store_release");
    const exportStart = builder.indexOf('"-exportArchive"');

    expect(exportStart).toBeGreaterThanOrEqual(0);
    expect(builder.slice(exportStart)).toContain("system_tools_first: true");
  });

  it("requires clean matching source before preparing and building release artifacts", () => {
    const fastfile = readFastfile();
    const verifier = functionBody(fastfile, "verify_apple_release_source!");
    const provenance = functionBody(fastfile, "pin_release_build_provenance!");
    const builder = functionBody(fastfile, "build_app_store_release");

    expect(verifier).toContain('"apple-release-source-check.sh"');
    expect(verifier).toContain('"--root"');
    expect(verifier).toContain('"--expected-commit"');
    expect(provenance).toContain("verify_apple_release_source!(normalized_commit)");
    expect(provenance).not.toContain('ENV["GITHUB_SHA"]');
    expect(builder).toContain("verify_apple_release_source!(context[:git_commit])");
    expect(builder.indexOf("verify_apple_release_source!")).toBeLessThan(
      builder.indexOf("FileUtils.mkdir_p(output_directory)"),
    );
  });

  it("normalizes Watch screenshots as opaque RGB PNGs for App Store upload", () => {
    const fastfile = readFastfile();

    expect(laneBody(fastfile, "screenshots")).toContain(
      'File.join(repo_root, "scripts", "ios-write-version-xcconfig.sh"), *version_args',
    );
    expect(laneBody(fastfile, "watch_screenshot")).toContain(
      'File.join(repo_root, "scripts", "ios-write-version-xcconfig.sh"), *version_args',
    );
    expect(fastfile).toContain("def normalize_watch_screenshot_status_bar(path)");
    expect(fastfile).toContain("CGImageAlphaInfo.noneSkipLast.rawValue");
    expect(fastfile).toContain("CGImageDestinationCreateWithURL");
    expect(fastfile).toContain("operation: .sourceOver");
  });
});
