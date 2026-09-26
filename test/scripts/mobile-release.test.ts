import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAndroidVersionProperties } from "../../scripts/lib/android-version.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const script = path.join(process.cwd(), "scripts/mobile-release.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadataPath = "apps/ios/CHANGELOG.md";
const uploadRef = "refs/openclaw/mobile-releases/ios/2026.9.20-8";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
function fixture(platform = "ios") {
  const directory = tempDirs.make("openclaw-mobile-release-");
  const remote = path.join(directory, "origin.git");
  const root = path.join(directory, "checkout");
  const recovery = path.join(directory, "recovery");
  const uploadAudit = path.join(directory, "upload.json");
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "clone", remote, root);
  git(root, "config", "user.name", "Release Fixture");
  git(root, "config", "user.email", "release@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  write(root, metadataPath, "# iOS releases\n\n## Unreleased\n\nHistorical notes.\n");
  write(root, "README.md", "Original application source.\n");
  write(root, ".gitignore", "node_modules\n");
  write(
    root,
    "package.json",
    '{"name":"mobile-release-fixture","type":"module","version":"2026.9.2"}\n',
  );
  write(root, "scripts/tsx.mjs", "export {};\n");
  write(root, "node_modules/tsx/package.json", '{"name":"tsx","exports":"./index.mjs"}\n');
  write(root, "node_modules/tsx/index.mjs", "export {};\n");
  fs.symlinkSync(
    path.join(process.cwd(), "node_modules/zod"),
    path.join(root, "node_modules/zod"),
    "dir",
  );
  for (const file of [
    "scripts/mobile-release-notes.ts",
    "scripts/lib/mobile-release-notes.ts",
    "scripts/mobile-release-ref.ts",
  ]) {
    write(root, file, fs.readFileSync(path.join(process.cwd(), file), "utf8"));
  }
  write(
    root,
    "scripts/ios-release-plan.sh",
    `echo '{"gatewayVersion":"2026.9.2","appStoreVersion":"2026.9.20","appStoreRevision":0,"buildNumber":8,"releaseNotesBaselines":[{"audience":"ios","version":null,"build":null}]}'\n`,
  );
  write(root, "scripts/ios-release-upload.sh", 'exec node scripts/fixture-upload.mjs "$@"\n');
  write(
    root,
    "scripts/fixture-upload.mjs",
    `import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { renderMobileReleaseNotes } from "./lib/mobile-release-notes.ts";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const stageOnly = process.argv.includes("--stage-only");
const notes = renderMobileReleaseNotes({ rootDir: process.cwd(), platform: "ios", version: "2026.9.20", build: "8", audience: "ios" });
fs.appendFileSync(process.env.FIXTURE_UPLOAD_AUDIT, JSON.stringify({ sha, stageOnly, notes, stampedSha: process.env.GIT_COMMIT, status: git("status", "--porcelain", "--untracked-files=all"), remoteMain: git("ls-remote", "origin", "refs/heads/main").split(/\\s+/)[0], metadata: fs.readFileSync("apps/ios/CHANGELOG.md", "utf8") }) + "\\n");
if (process.env.FIXTURE_UPLOAD_FAIL === "1") throw new Error("Synthetic store upload refused");
if (!stageOnly) git("push", "origin", sha + ":${uploadRef}");
if (process.env.FIXTURE_STAGE_FAIL === "1") throw new Error("Synthetic metadata stage refused after upload");
console.log(stageOnly ? "Synthetic notes staged" : "Synthetic store upload accepted");
`,
  );
  if (platform === "android") {
    for (const file of [
      "scripts/android-sync-versioning.ts",
      "scripts/android-version.ts",
      "scripts/lib/android-version.ts",
      "scripts/lib/mobile-changelog.ts",
      "scripts/lib/release-version.mjs",
      "scripts/lib/version-script-args.ts",
      "scripts/lib/arg-utils.mts",
      "scripts/lib/arg-utils.runtime.mjs",
      "apps/android/scripts/build-release-artifacts.ts",
      "apps/android/Config/ReleaseSigning.json",
      "apps/android/fastlane/Fastfile",
    ]) {
      write(root, file, fs.readFileSync(path.join(process.cwd(), file), "utf8"));
    }
    write(root, "apps/android/version.json", '{"version":"2026.8.2","versionCode":2026080201}\n');
    write(
      root,
      "apps/android/Config/Version.properties",
      renderAndroidVersionProperties({ canonicalVersion: "2026.8.2", versionCode: 2026080201 }),
    );
    write(
      root,
      "apps/android/CHANGELOG.md",
      "## Unreleased\n\nFuture manual notes.\n\n## 2026.8.2\n\nPrevious APK notes.\n",
    );
    write(
      root,
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
      "Previous APK notes.\n",
    );
    write(
      root,
      "scripts/lib/android-fastlane.sh",
      `run_android_fastlane() {
  echo '{"version":"2026.9.2","versionCode":2026090203,"wearVersionCode":2026090253,"releaseNotesBaselines":[{"audience":"phone","version":null,"build":null},{"audience":"wear","version":null,"build":null}]}' > "\u0024{3#output_path:}"
}\n`,
    );
    write(root, "scripts/android-release-upload.sh", "exec ruby scripts/fixture-upload.rb\n");
    write(
      root,
      "scripts/fixture-upload.rb",
      String.raw`
$LOADED_FEATURES << "supply.rb"
module UI
  def self.user_error!(message); raise message; end
  def self.success(message); end
  def self.important(message); end
end
def default_platform(name); end
def platform(name); yield; end
def desc(text); end
$lanes = {}
def lane(name, &block); $lanes[name] = block; end
def sh(command); raise "Command failed" unless system(*Shellwords.split(command)); end
load "apps/android/fastlane/Fastfile"
def validate_android_release_preflight!(metadata); end
def capture_android_screenshots!; end
def screenshots; $lanes.fetch(:screenshots).call; end
def build_release_artifacts!
  raise "Archive failed" unless system("node", "--import", "tsx", "apps/android/scripts/build-release-artifacts.ts", "--dry-run")
end
def upload_play_store_build!(metadata, **options)
  File.write(ENV.fetch("FIXTURE_UPLOAD_AUDIT"), JSON.generate({ version: metadata.fetch(:version), versionCode: metadata.fetch(:version_code), gradleVersion: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_VERSION_NAME"], gradleCode: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_VERSION_CODE"] }) + "\n")
  raise "Record failed" unless system("git", "push", "origin", "HEAD:refs/openclaw/mobile-releases/android/2026.9.2-2026090203")
end
$lanes.fetch(:release_upload).call
`,
    );
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial source");
  git(root, "push", "origin", "main");
  const base = git(root, "rev-parse", "HEAD");
  const env = {
    ...process.env,
    FIXTURE_UPLOAD_AUDIT: uploadAudit,
    OPENAI_API_KEY: "synthetic-key",
    GITHUB_ACTIONS: "false",
    GITHUB_REF: "",
    GITHUB_SHA: "",
    GITHUB_RUN_ATTEMPT: "",
    GITHUB_OUTPUT: path.join(directory, "github-output.txt"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
  };
  const invoke = (
    operation: "run" | "stage",
    extra: string[] = [],
    overrides: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      [script, operation, "--platform", platform, "--recovery-dir", recovery, ...extra],
      { cwd: root, env: { ...env, ...overrides }, encoding: "utf8" },
    );
  const audit = () =>
    fs
      .readFileSync(uploadAudit, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { directory, root, remote, recovery, base, invoke, uploadAudit, audit };
}

function advanceMain(f: ReturnType<typeof fixture>): string {
  git(f.root, "checkout", "-b", "advance-main", f.base);
  write(f.root, "README.md", "Application source advanced after planning.\n");
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Advance main");
  const sha = git(f.root, "rev-parse", "HEAD");
  git(f.root, "push", "origin", "HEAD:main");
  git(f.root, "checkout", "main");
  return sha;
}

describe("mobile release CLI", () => {
  it("builds Android from the saved store plan and notes without changing Git or pinned metadata", () => {
    const f = fixture("android");
    const pinned = [
      "apps/android/version.json",
      "apps/android/Config/Version.properties",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
    ];
    const original = pinned.map((file) => fs.readFileSync(path.join(f.root, file), "utf8"));
    const result = f.invoke("run");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Android versionName: 2026.9.2");
    expect(result.stdout).toContain("Android versionCode: 2026090203");
    expect(f.audit()[0]).toMatchObject({
      version: "2026.9.2",
      versionCode: 2026090203,
      gradleVersion: "2026.9.2",
      gradleCode: "2026090203",
    });
    expect(
      git(f.remote, "rev-parse", "refs/openclaw/mobile-releases/android/2026.9.2-2026090203"),
    ).toBe(f.base);
    expect(git(f.remote, "rev-parse", "main")).toBe(f.base);
    for (const [index, file] of pinned.entries()) {
      expect(fs.readFileSync(path.join(f.root, file), "utf8")).toBe(original[index]);
    }
    const rebuilt = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/android/scripts/build-release-artifacts.ts", "--dry-run"],
      {
        cwd: f.root,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ANDROID_RELEASE_PLAN: path.join(f.recovery, "android-plan.json"),
          OPENCLAW_MOBILE_RELEASE_NOTES: path.join(f.recovery, "release-notes.json"),
        },
      },
    );
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(rebuilt.stdout).toContain("Android versionCode: 2026090203");
    expect(git(f.root, "status", "--porcelain")).toBe("");
  });

  it("uploads the frozen main source with generated notes and leaves advanced main untouched", () => {
    const f = fixture();
    const advanced = advanceMain(f);
    const stale = f.invoke("run");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Local main differs from origin/main");
    expect(fs.existsSync(f.uploadAudit)).toBe(false);
    const result = f.invoke("run", [], { GITHUB_ACTIONS: "true", GITHUB_RUN_ATTEMPT: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(f.audit()).toEqual([
      expect.objectContaining({
        sha: f.base,
        stampedSha: f.base,
        status: "",
        remoteMain: advanced,
        metadata: "# iOS releases\n\n## Unreleased\n\nHistorical notes.\n",
        notes: "Bug fixes and improvements.",
        stageOnly: false,
      }),
    ]);
    expect(git(f.remote, "rev-parse", "main")).toBe(advanced);
    expect(git(f.remote, "rev-parse", uploadRef)).toBe(f.base);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(false);
    expect(fs.existsSync(path.join(f.recovery, "release-notes.json"))).toBe(true);
    expect(fs.existsSync(path.join(f.recovery, "release.bundle"))).toBe(false);
    expect(git(f.remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
      "refs/heads/main",
    );
    const repeated = f.invoke("run", [], { GITHUB_ACTIONS: "true", GITHUB_RUN_ATTEMPT: "2" });
    expect(repeated.stderr).toContain("Do not rerun the upload job");
    expect(f.audit()).toHaveLength(1);
  });

  it("retains a failed upload attempt and refuses staging without proof of accepted upload", () => {
    const f = fixture();
    const result = f.invoke("run", [], { FIXTURE_UPLOAD_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Synthetic store upload refused");
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(true);
    expect(fs.existsSync(path.join(f.recovery, "release-notes.json"))).toBe(true);
    const recovery = f.invoke("stage");
    expect(recovery.status).toBe(1);
    expect(recovery.stderr).toContain("No matching upload record");
    expect(f.audit()).toHaveLength(1);
    expect(git(f.remote, "rev-parse", "main")).toBe(f.base);
  });

  it("recovers only iOS metadata staging using frozen notes and never uploads twice", () => {
    const f = fixture();
    const result = f.invoke("run", [], { FIXTURE_STAGE_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Synthetic metadata stage refused after upload");
    expect(git(f.remote, "rev-parse", uploadRef)).toBe(f.base);
    const notes = fs.readFileSync(path.join(f.recovery, "release-notes.json"), "utf8");
    const recovery = f.invoke("stage", [], { OPENAI_API_KEY: "" });
    expect(recovery.status, recovery.stderr).toBe(0);
    expect(f.audit().map((entry) => entry.stageOnly)).toEqual([false, true]);
    expect(fs.readFileSync(path.join(f.recovery, "release-notes.json"), "utf8")).toBe(notes);
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(false);
    expect(git(f.remote, "rev-parse", "main")).toBe(f.base);
  });

  it("rejects dirty, non-main, and missing-key releases before creating a worktree or calling Fastlane", () => {
    const f = fixture();
    write(f.root, "uncommitted.txt", "Unrelated local work.\n");
    expect(f.invoke("run").stderr).toContain("require a clean checkout");
    fs.unlinkSync(path.join(f.root, "uncommitted.txt"));
    git(f.root, "checkout", "-b", "feature");
    expect(f.invoke("run").stderr).toContain("Start a release from a clean, current main");
    git(f.root, "checkout", "main");
    expect(f.invoke("run", [], { OPENAI_API_KEY: "" }).stderr).toContain(
      "OPENAI_API_KEY is required",
    );
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(false);
    expect(fs.existsSync(f.uploadAudit)).toBe(false);
  });
});
