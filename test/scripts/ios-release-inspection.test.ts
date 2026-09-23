import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readMobileReleaseIntent } from "../../scripts/mobile-release-intent.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const fastfile = path.resolve("apps/ios/fastlane/Fastfile");
const harness = String.raw`
require "json"
module UI
  def self.user_error!(message); raise message; end
  def self.success(*); end
  def self.message(*); end
end
def default_platform(*); end
def desc(*); end
def platform(*); yield; end
def lane(name, &body); define_singleton_method(name, &body); end
alias private_lane lane
load ARGV.fetch(0)
$scenario = ARGV.fetch(2)
$reads = []
def app_store_connect_api_key_config; $reads << "auth"; end
module Spaceship
  class ConnectAPI
    module Platform
      IOS = "IOS"
    end
  end
end
Build = Struct.new(:id, :app_version, :version, :platform, :processing_state, :expired)
Group = Struct.new(:id, :name, :is_internal_group, :has_access_to_all_builds, :builds) do
  def fetch_builds
    $reads << "relationships"
    raise "private API response must not be retained" if $scenario == "api-failure"
    builds
  end
end
Version = Struct.new(:id, :app_version_state, :app_store_state, :version_string)
Upload = Struct.new(:cf_build_version, :cf_build_short_version_string, :state)
class App
  def id; "app-123"; end
  def get_builds(filter:, includes:)
    raise "wrong exact-build filter" unless filter == {"preReleaseVersion.version" => "2026.9.20", version: "1"}
    raise "unnecessary includes" unless includes == "preReleaseVersion"
    $reads << "builds"
    return [] if $scenario == "missing-build"
    return [$build, $build] if $scenario == "ambiguous-build"
    [$build]
  end
  def get_beta_groups(includes: nil)
    raise "unnecessary group includes" unless includes.nil?
    $reads << "groups"
    $groups
  end
  def get_app_store_versions(filter:, includes:)
    raise "planner scope" unless filter == {platform: "IOS"} && includes.nil?
    $reads << "versions"
    raise "private API response must not be retained" if $scenario == "planner-versions-api"
    state = $scenario == "locked-plan" ? "IN_REVIEW" : "PREPARE_FOR_SUBMISSION"
    [Version.new("version-123", state, nil, "2026.9.20")]
  end
end
def resolve_app_store_connect_app(**); App.new; end
def app_store_build_uploads(app_id:, **)
  raise "wrong app" unless app_id == "app-123"
  $reads << "uploads"
  raise "private API response must not be retained" if $scenario == "planner-uploads-api"
  state = $scenario == "unknown-plan" ? "UNKNOWN" : "COMPLETE"
  [Upload.new("1", "2026.9.20", {"state" => state})]
end
$build = Build.new("build-123", "2026.9.20", "1", "IOS", "VALID", false)
$build.processing_state = "UNKNOWN" if $scenario == "unknown-build"
$build.expired = true if $scenario == "expired-build"
$build.platform = "MAC_OS" if $scenario == "wrong-platform"
$build.id = nil if $scenario == "missing-build-id"
$groups = [Group.new("group-123", "Private group name", true, true, [$build]), Group.new("other-group", "Other name", false, false, [])]
$groups.first.builds = [] if %w[missing-relationship manual-missing].include?($scenario)
$groups.first.has_access_to_all_builds = false if $scenario == "manual-missing"
$groups.last.builds = [$build] if $scenario == "outside-group"
$groups.last.is_internal_group = true if $scenario == "unsafe-automatic"
$groups.last.has_access_to_all_builds = nil if $scenario == "unsafe-automatic"
$groups.first.is_internal_group = false if $scenario == "external-group"
$groups.last.name = "group-123" if $scenario == "name-collision"
$groups.last.id = "group-123" if $scenario == "duplicate-group-id"
ENV["TESTFLIGHT_INTERNAL_GROUP"] = "group-123"
ENV["OPENCLAW_MOBILE_RELEASE_REF_MODE"] = "intent" if $scenario == "writer-mode"
# A whole-Fastfile lane load exercises its registered entry point. Every writer
# and command outside the real read-only planner closure fails this fixture.
def sh(*); raise "FORBIDDEN shell/writer"; end
%i[prepare_app_store_context release_signing_check! screenshots metadata build_app_store_release sync_app_store_signing! finalize_mobile_release_ref! record_mobile_release_ref! ensure_mobile_release_ref_available! upload_to_testflight].each do |name|
  define_singleton_method(name) { |*| raise "FORBIDDEN #{name}" }
end
root = ARGV.fetch(1)
error = nil
begin
  release_inspect(source_root: File.join(root, "candidate"), output_directory: File.join(root, "output"), app_store_version: "2026.9.20", build_number: "1")
rescue => failure
  error = failure.message
end
puts JSON.generate({error: error, reads: $reads})
`;

function inspect(scenario: string) {
  const root = roots.make("ios-release-inspection-");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(candidate, "apps/mobile"), { recursive: true });
  fs.mkdirSync(path.join(candidate, "apps/ios"), { recursive: true });
  fs.mkdirSync(path.join(candidate, "scripts"));
  for (const script of ["ios-version.ts", "ios-release-plan.ts"]) {
    fs.writeFileSync(
      path.join(candidate, "scripts", script),
      'throw new Error("FORBIDDEN candidate execution");',
    );
  }
  fs.writeFileSync(path.join(candidate, "apps/mobile/version.json"), '{"version":"2026.9.2"}\n');
  fs.writeFileSync(
    path.join(candidate, "apps/ios/CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n## 2026.9.20\n\nRelease notes.\n",
  );
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", candidate, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("add", "apps", "scripts");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "candidate fixture",
  );
  const sha = git("rev-parse", "HEAD");
  const result = spawnSync("ruby", ["-e", harness, fastfile, root, scenario], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_MOBILE_RELEASE_REF_MODE: "",
      OPENCLAW_MOBILE_RELEASE_INTENT_PATH: "",
      OPENCLAW_IOS_RELEASE_WRAPPER: "",
      APP_STORE_CONNECT_APP_ID: "",
      APP_STORE_CONNECT_APP_IDENTIFIER: "",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const reportPath = path.join(root, "output/inspection.json");
  const planPath = path.join(root, "output/plan.json");
  return {
    sha,
    outcome: JSON.parse(result.stdout) as { error: string | null; reads: string[] },
    report: fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null,
    plan: fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, "utf8")) : null,
    reportPath,
    files: fs.existsSync(path.join(root, "output"))
      ? fs.readdirSync(path.join(root, "output")).toSorted()
      : [],
  };
}

describe("protected iOS read-only inspection", () => {
  it("uses the real trusted planner with candidate data, and cannot call any writer", () => {
    const result = inspect("safe");
    expect(result.outcome.error).toBeNull();
    expect(result.plan).toMatchObject({
      gatewayVersion: "2026.9.2",
      appStoreVersion: "2026.9.20",
      buildNumber: 2,
      changelogStatus: "ready",
      sourceClean: true,
      sourceSha: result.sha,
    });
    expect(result.report).toMatchObject({
      kind: "openclaw-ios-release-inspection",
      publicationVerified: false,
      planValidation: "passed",
      groupPolicyValid: true,
      exclusiveGroupRelationship: true,
      buildUsable: true,
      appId: "app-123",
      buildId: "build-123",
    });
    expect(result.files).toEqual(["inspection.json", "plan.json"]);
    expect(() => readMobileReleaseIntent(result.reportPath)).toThrow();
    expect(JSON.stringify(result.report)).not.toMatch(
      /Private group name|Other name|tester|email|intent|receipt/i,
    );
  });

  it.each([
    "missing-relationship",
    "manual-missing",
    "outside-group",
    "unsafe-automatic",
    "external-group",
    "name-collision",
    "unknown-build",
    "expired-build",
  ])("reports %s without repairing or claiming publication", (scenario) => {
    const result = inspect(scenario);
    expect(result.outcome.error).toBeNull();
    expect(result.report.publicationVerified).toBe(false);
    expect(
      result.report.groupPolicyValid &&
        result.report.exclusiveGroupRelationship &&
        result.report.buildUsable,
    ).toBe(false);
    expect(result.plan.buildNumber).toBe(2);
  });

  it.each(["locked-plan", "unknown-plan"])(
    "retains group observations but no usable plan for %s",
    (scenario) => {
      const result = inspect(scenario);
      expect(result.outcome.error).toBeNull();
      expect(result.report).toMatchObject({ planValidation: "failed", publicationVerified: false });
      expect(result.plan).toBeNull();
    },
  );

  it.each([
    "api-failure",
    "planner-versions-api",
    "planner-uploads-api",
    "missing-build-id",
    "duplicate-group-id",
    "missing-build",
    "ambiguous-build",
    "wrong-platform",
    "writer-mode",
  ])("fails closed for %s", (scenario) => {
    const result = inspect(scenario);
    expect(result.outcome.error).not.toBeNull();
    expect(result.report).toBeNull();
    expect(result.plan).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private API response");
    if (scenario === "writer-mode") {
      expect(result.outcome.reads).toEqual([]);
    }
  });

  it("resolves the installed inspection bundle through the wrapper in a fresh shell", () => {
    const workflow = parse(fs.readFileSync(".github/workflows/ios-beta-release.yml", "utf8"));
    const job = workflow.jobs.inspect;
    const install = job.steps.find(
      (step: { name: string }) => step.name === "Install locked inspection Fastlane bundle",
    );
    const inspectStep = job.steps.find(
      (step: { name: string }) => step.name === "Inspect iOS plan and exact build relationships",
    );
    const root = roots.make("ios-inspection-bundle-");
    for (const directory of ["apps/ios", "scripts/lib", "bin", "home", "tmp"]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.copyFileSync("scripts/lib/ios-fastlane.sh", path.join(root, "scripts/lib/ios-fastlane.sh"));
    fs.copyFileSync("apps/ios/Gemfile", path.join(root, "apps/ios/Gemfile"));
    // Exercise the actual workflow shells and wrapper without installing gems or
    // accessing the store. The shim checks the deployment contract at each call.
    fs.writeFileSync(
      path.join(root, "bin/bundle"),
      String.raw`#!/bin/bash
set -euo pipefail
[[ "$1" == "_2.6.9_" ]]
shift
printf '%s:%s\n' "$1" "${"$"}{BUNDLE_DEPLOYMENT:-unset}" >> "$GITHUB_WORKSPACE/bundle-trace"
[[ "${"$"}{BUNDLE_DEPLOYMENT:-}" == "true" ]]
case "$1" in
  install) touch "$GITHUB_WORKSPACE/installed" ;;
  check) test -f "$GITHUB_WORKSPACE/installed" ;;
  exec)
    test -f "$GITHUB_WORKSPACE/installed"
    if [[ "$2" == ruby ]]; then
      printf '2.239.0'
    else
      [[ "$BUNDLE_GEMFILE" == "$GITHUB_WORKSPACE/apps/ios/Gemfile" ]]
      [[ "$2 $3 $4" == "fastlane ios release_inspect" ]]
      printf 'inspection fixture reached\n'
    fi
    ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const runStep = (step: {
      run: string;
      env?: Record<string, string>;
      "working-directory"?: string;
    }) =>
      spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", step.run], {
        cwd: path.join(root, step["working-directory"] ?? "."),
        encoding: "utf8",
        env: {
          HOME: path.join(root, "home"),
          PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: path.join(root, "tmp"),
          ...workflow.env,
          ...job.env,
          ...step.env,
        },
      });
    const installed = runStep(install);
    expect(installed.status, installed.stderr).toBe(0);
    const inspected = runStep(inspectStep);
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(inspected.stdout).toBe("inspection fixture reached\n");
    expect(fs.readFileSync(path.join(root, "bundle-trace"), "utf8")).toBe(
      "install:true\ncheck:true\nexec:true\ncheck:true\nexec:true\n",
    );
    expect(job.env.BUNDLE_DEPLOYMENT).toBe("true");
    expect(workflow.env.BUNDLE_DEPLOYMENT).toBeUndefined();
    for (const name of ["authorize", "release", "recover-record"]) {
      expect(workflow.jobs[name].env?.BUNDLE_DEPLOYMENT).toBeUndefined();
    }
  });

  it("keeps inspection in a fresh protected job with trusted execution and no publication credentials", () => {
    const workflow = parse(fs.readFileSync(".github/workflows/ios-beta-release.yml", "utf8"));
    const job = workflow.jobs.inspect;
    expect(job).toBeDefined();
    expect(job.if).toBe("inputs.operation == 'inspect'");
    expect(job.environment).toBe("ios-beta-release");
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    expect(job.concurrency).toEqual(workflow.jobs.release.concurrency);
    const steps = job.steps;
    const read = steps.findIndex(
      (step: { name: string }) => step.name === "Inspect iOS plan and exact build relationships",
    );
    expect(read).toBeGreaterThan(0);
    expect(steps[read - 1].with.operation).toBe("inspect");
    expect(steps[read - 1].with["workflow-sha"]).toBe("${{ github.workflow_sha }}");
    expect(steps[read + 1].with.operation).toBe("inspect");
    expect(steps[0].with.ref).toBe("${{ github.workflow_sha }}");
    expect(
      steps.find((step: { name: string }) => step.name === "Checkout candidate data only").with.ref,
    ).toBe("${{ inputs.target_sha }}");
    const serialized = JSON.stringify(job);
    expect(serialized).not.toMatch(
      /GH_APP_PRIVATE_KEY|MATCH_PASSWORD|ios-signing-keychain|apps-signing|release_upload|ios:release:upload|release-ref-private-key|id-token|attestations/,
    );
    expect(
      steps
        .filter((step: unknown) => JSON.stringify(step).includes("secrets."))
        .map((step: { name: string }) => step.name),
    ).toEqual([steps[read].name]);
    expect(steps[read].run).toContain("run_ios_fastlane ios release_inspect");
    expect(steps.at(-1).with.name).toBe("ios-release-inspection-${{ github.run_id }}-1");
    expect(steps.at(-1).if).toBeUndefined();
    expect(serialized).not.toContain("continue-on-error");
  });
});
