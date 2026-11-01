import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAndroidVersionProperties } from "../../scripts/lib/android-version.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { commit, git, write } from "./mobile-release-git.test-support.js";

const script = path.join(process.cwd(), "scripts/mobile-release.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadataPath = "apps/ios/CHANGELOG.md";
const uploadRef = "refs/openclaw/mobile-releases/ios/2026.9.20-8";
const originalMetadata = "# iOS releases\n\n## Unreleased\n\nHistorical notes.\n";
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8");
const json = (root: string, file: string) => JSON.parse(read(root, file));
const exists = (root: string, file: string) => fs.existsSync(path.join(root, file));
const readLines = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const defaultBuild = {
  id: "fixture-build",
  shortVersion: "2026.9.20",
  buildNumber: "7",
  externalState: "READY_FOR_BETA_SUBMISSION",
  configured: false,
  hasBetaNotes: false,
  selectedForAppStore: true,
};
const build = (overrides: Partial<typeof defaultBuild> = {}) => ({ ...defaultBuild, ...overrides });
const testflightPlan = (
  builds: ReturnType<typeof build>[] = [],
  pendingBuild: ReturnType<typeof build> | null = null,
) => ({ groupId: "external-fixture", builds, pendingBuild });
function expectResult(result: ReturnType<typeof spawnSync>, status: number, error?: string) {
  expect(result.status, String(result.stderr)).toBe(status);
  if (error) {
    expect(String(result.stderr)).toContain(error);
  }
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    write(root, file, text);
  }
}
function copyFiles(root: string, files: string[]) {
  for (const file of files) {
    write(root, file, read(process.cwd(), file));
  }
}
function fixture(
  platform = "ios",
  testflight?: ReturnType<typeof testflightPlan>,
  shallow = false,
) {
  const directory = tempDirs.make("openclaw-mobile-release-");
  const remote = path.join(directory, "origin.git");
  let root = path.join(directory, "checkout");
  const recovery = path.join(directory, "recovery");
  const uploadAudit = path.join(directory, "upload.json");
  const firebaseAudit = path.join(directory, "firebase.jsonl");
  const firebasePreload = path.join(directory, "firebase-fixture.mjs");
  let firebaseKey = "";
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "clone", remote, root);
  git(root, "config", "user.name", "Release Fixture");
  git(root, "config", "user.email", "release@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFiles(root, {
    [metadataPath]: originalMetadata,
    "README.md": "Original application source.\n",
    ".gitignore":
      "node_modules\napps/ios/build\napps/android/build\napps/ios/fastlane/screenshots\n",
    "package.json": '{"name":"mobile-release-fixture","type":"module","version":"2026.9.2"}\n',
    "scripts/tsx.mjs": "export {};\n",
    "node_modules/tsx/package.json": '{"name":"tsx","exports":"./index.mjs"}\n',
    "node_modules/tsx/index.mjs": "export {};\n",
  });
  fs.symlinkSync(
    path.join(process.cwd(), "node_modules/zod"),
    path.join(root, "node_modules/zod"),
    "dir",
  );
  copyFiles(root, [
    "scripts/mobile-release-notes.ts",
    "scripts/lib/mobile-release-evidence.ts",
    "scripts/lib/mobile-release-notes.ts",
    "scripts/mobile-release-ref.ts",
    "scripts/lib/arg-utils.mts",
    "scripts/lib/arg-utils.runtime.mjs",
    "scripts/lib/version-script-args.ts",
    "scripts/lib/android-store-version.ts",
    "scripts/lib/mobile-store-version.ts",
    "scripts/lib/release-version.mjs",
  ]);
  writeFiles(root, {
    "scripts/ios-release-plan.sh": `echo '${JSON.stringify({ gatewayVersion: "2026.9.2", appStoreVersion: "2026.9.20", appStoreRevision: 0, buildNumber: 8, buildUploads: [], releaseNotesBaselines: [{ audience: "ios", version: null, build: null }], ...(testflight ? { destination: "testflight", testflight } : {}) })}'\n`,
    "scripts/ios-release-upload.sh": 'exec node scripts/fixture-upload.mjs "$@"\n',
    "scripts/fixture-upload.mjs": `import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { renderMobileReleaseNotes } from "./lib/mobile-release-notes.ts";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const stageOnly = process.argv.includes("--stage-only");
const sourceRoot = process.env.OPENCLAW_IOS_RELEASE_SOURCE_ROOT || process.cwd();
const plan = JSON.parse(fs.readFileSync(process.env.OPENCLAW_IOS_RELEASE_PLAN, "utf8"));
const buildNumber = process.argv[process.argv.indexOf("--build-number") + 1];
const notes = renderMobileReleaseNotes({ rootDir: sourceRoot, platform: "ios", version: plan.appStoreVersion, build: buildNumber, audience: "ios" });
fs.appendFileSync(process.env.FIXTURE_UPLOAD_AUDIT, JSON.stringify({ sha, stageOnly, notes, buildNumber, destination: process.argv.includes("--destination") ? process.argv[process.argv.indexOf("--destination") + 1] : "app-store", stampedSha: process.env.GIT_COMMIT, status: git("status", "--porcelain", "--untracked-files=all"), remoteMain: git("ls-remote", "origin", "refs/heads/main").split(/\\s+/)[0], metadata: fs.readFileSync("apps/ios/CHANGELOG.md", "utf8") }) + "\\n");
if (!stageOnly) {
  fs.mkdirSync("apps/ios/build", { recursive: true });
  fs.writeFileSync("apps/ios/build/screenshot-diagnostics.json", JSON.stringify({ schemaVersion: 1, diagnostics: [{ phase: "build", durationSeconds: 1.25, outcome: "succeeded" }] }));
  fs.writeFileSync("apps/ios/build/private-diagnostics.json", "Synthetic private build environment");
}
if (process.env.FIXTURE_UPLOAD_FAIL === "1") {
  fs.mkdirSync("apps/ios/fastlane/screenshots/en-US", { recursive: true });
  fs.writeFileSync("apps/ios/fastlane/screenshots/en-US/iPhone-01-control-connected.png", "Synthetic fixture screenshot");
  fs.mkdirSync("apps/ios/build/SnapshotTestResults/failure.xcresult", { recursive: true });
  fs.writeFileSync("apps/ios/build/SnapshotTestResults/capture-attempts.json", JSON.stringify({ schemaVersion: 1, attempts: [{ deviceName: "iPhone", screenshotName: "02-chat-connected", attempt: 1, captureOutcome: "failed" }] }));
  fs.writeFileSync("apps/ios/build/SnapshotTestResults/failure.xcresult/pairing.txt", "Synthetic private pairing state");
  fs.mkdirSync("apps/ios/build/SnapshotLogs", { recursive: true });
  fs.writeFileSync("apps/ios/build/SnapshotLogs/build.log", "Synthetic private build environment");
  throw new Error("Synthetic store upload refused");
}
if (!stageOnly) git("push", "origin", sha + ":${uploadRef}");
if (process.env.FIXTURE_STAGE_FAIL === "1") throw new Error("Synthetic metadata stage refused after upload");
console.log(stageOnly ? "Synthetic notes staged" : "Synthetic store upload accepted");
`,
  });
  if (platform === "android") {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    firebaseKey = JSON.stringify({
      type: "service_account",
      project_id: "synthetic-project",
      client_email: "publisher@synthetic-project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    fs.writeFileSync(
      firebasePreload,
      String.raw`
import fs from "node:fs";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "undici" ? { url: import.meta.url, shortCircuit: true } : nextResolve(specifier, context);
} });
export class Agent { async close() {} }
const app = "projects/123/apps/1:123:android:abc123";
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
export const fetch = async (url, options = {}) => {
  const pathname = new URL(url).pathname;
  if (pathname === "/token") return response({ access_token: "synthetic-token", expires_in: 3600 });
  if (pathname.endsWith("/aabInfo")) return response({ integrationState: "INTEGRATED" });
  if (pathname.includes("/groups")) {
    return response(process.env.FIXTURE_FIREBASE_PREFLIGHT_FAIL === "1" ? {} : { name: "projects/123/groups/android-daily" });
  }
  const body = options.body ? Buffer.from(await new Response(options.body).arrayBuffer()).toString() : "";
  fs.appendFileSync(process.env.FIXTURE_FIREBASE_AUDIT, JSON.stringify({ pathname, method: options.method || "GET", body }) + "\n");
  if (pathname.endsWith("releases:upload")) {
    const audience = body.includes("wear") ? "wear" : "phone";
    return response({ name: app + "/releases/-/operations/" + audience });
  }
  if (pathname.includes("/operations/")) {
    const audience = pathname.endsWith("wear") ? "wear" : "phone";
    return response({ done: true, response: { result: "RELEASE_CREATED", release: {
      name: app + "/releases/" + audience,
      displayVersion: "2026.9.20",
      buildVersion: audience === "wear" ? "2026090251" : "2026090250",
      createTime: "2026-09-01T12:00:00Z",
    } } });
  }
  if (pathname.endsWith("phone:distribute") && process.env.FIXTURE_FIREBASE_FAIL === "1") return response({ error: { status: "INVALID_ARGUMENT" } }, 400);
  if (pathname.endsWith(":distribute") || options.method === "PATCH") return response({});
  throw new Error("Unexpected fixture Firebase request: " + pathname);
};
`,
    );
    copyFiles(root, [
      "scripts/android-sync-versioning.ts",
      "scripts/android-version.ts",
      "scripts/lib/android-version.ts",
      "scripts/lib/mobile-changelog.ts",
      "scripts/lib/mobile-version.ts",
      "scripts/lib/release-version.mjs",
      "apps/android/scripts/build-release-artifacts.ts",
      "apps/android/Config/ReleaseSigning.json",
      "apps/android/fastlane/Fastfile",
      "scripts/android-release-upload.sh",
    ]);
    writeFiles(root, {
      "apps/android/version.json": '{"version":"2026.8.2","versionCode":2026080201}\n',
      "apps/android/Config/Version.properties": renderAndroidVersionProperties({
        canonicalVersion: "2026.8.2",
        versionCode: 2026080201,
      }),
      "apps/android/CHANGELOG.md":
        "## Unreleased\n\nFuture manual notes.\n\n## 2026.8.2\n\nPrevious APK notes.\n",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt": "Previous APK notes.\n",
      "scripts/lib/android-fastlane.sh": `run_android_fastlane() {
  if [[ "$2" != "release_plan" ]]; then
    (cd ../.. && ruby scripts/fixture-upload.rb "$3")
    return
  fi
  echo '{"schemaVersion":2,"gatewayVersion":"2026.9.2","revision":0,"buildNumber":1,"version":"2026.9.20","versionCode":2026090250,"wearVersionCode":2026090251,"legacyMaxVersionCode":2026090249,"releaseNotesBaselines":[{"audience":"phone","version":null,"build":null},{"audience":"wear","version":null,"build":null}]}' > "\u0024{3#output_path:}"
}\n`,
      "scripts/fixture-upload.rb": String.raw`
$LOADED_FEATURES << "supply.rb"
require "digest"
require "fileutils"
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
def build_release_artifacts!(artifact: "all")
  raise "Archive failed" unless system("node", "--import", "tsx", "apps/android/scripts/build-release-artifacts.ts", "--artifact", artifact, "--dry-run")
  FileUtils.mkdir_p("apps/android/build/release-artifacts")
  %w(play wear).each do |audience|
    file = "apps/android/build/release-artifacts/openclaw-2026.9.20-#{audience}-release.aab"
    File.write(file, "synthetic signed #{audience} bundle")
    File.write("#{file}.sha256", "#{Digest::SHA256.file(file).hexdigest}  #{File.basename(file)}\n")
  end
end
def upload_play_store_build!(metadata, **options)
  File.open(ENV.fetch("FIXTURE_UPLOAD_AUDIT"), "a") { |file| file.write(JSON.generate({ version: metadata.fetch(:version), versionCode: metadata.fetch(:version_code), wearVersionCode: metadata.fetch(:wear_version_code), uploadMetadata: options.fetch(:upload_metadata), gradleVersion: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_VERSION_NAME"], gradleCode: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_VERSION_CODE"], gradleWearCode: ENV["ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_WEAR_VERSION_CODE"] }) + "\n") }
  %w(initialize-android record).each do |command|
    raise "Record failed" unless system("node", "--import", "tsx", "scripts/mobile-release-ref.ts", command, "--plan", ENV.fetch("OPENCLAW_ANDROID_RELEASE_PLAN"))
  end
end
$lanes.fetch(:release_upload).call(destination: ARGV.fetch(0).delete_prefix("destination:"))
`,
    });
  }
  commit(root, "Initial source");
  write(root, "README.md", "Updated application source.\n");
  const base = commit(root, "Update application source");
  git(root, "push", "origin", "main");
  if (shallow) {
    const checkout = path.join(directory, "shallow");
    git(directory, "clone", "--no-local", "--no-tags", "--depth=1", remote, checkout);
    fs.symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"), "dir");
    root = checkout;
  }
  const env = {
    ...process.env,
    FIXTURE_UPLOAD_AUDIT: uploadAudit,
    FIXTURE_FIREBASE_AUDIT: firebaseAudit,
    FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA: firebaseKey,
    FIREBASE_APP_ID: "1:123:android:abc123",
    FIREBASE_TESTER_GROUPS: "android-daily",
    OPENAI_API_KEY: "synthetic-key",
    GITHUB_ACTIONS: "false",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_REF: "",
    GITHUB_SHA: "",
    GITHUB_RUN_ATTEMPT: "",
    GITHUB_OUTPUT: path.join(directory, "github-output.txt"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
  };
  const invoke = (
    operation: "run" | "stage" | "firebase",
    extra: string[] = [],
    overrides: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      [
        ...(platform === "android" ? ["--import", firebasePreload] : []),
        script,
        operation,
        "--platform",
        platform,
        "--recovery-dir",
        recovery,
        ...extra,
      ],
      { cwd: root, env: { ...env, ...overrides }, encoding: "utf8" },
    );
  return {
    root,
    remote,
    recovery,
    base,
    invoke,
    uploadAudit,
    firebaseAudit,
    audit: () => readLines(uploadAudit),
    ref: (name: string) => git(remote, "rev-parse", name),
  };
}

function advanceMain(f: ReturnType<typeof fixture>): string {
  const sha = git(
    f.remote,
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=release@example.invalid",
    "commit-tree",
    `${f.base}^{tree}`,
    "-p",
    f.base,
    "-m",
    "Advance main",
  );
  git(f.remote, "update-ref", "refs/heads/main", sha);
  return sha;
}
function workflowEnv(sha: string, event = "schedule") {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: event,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
  };
}

describe("mobile release CLI", () => {
  it.each([
    { destination: "play-store", event: "local" },
    { destination: "play-store", event: "schedule" },
    { destination: "internal", event: "schedule" },
  ])(
    "builds Android $destination on $event from the saved plan without changing Git or pinned metadata",
    ({ destination, event }) => {
      const f = fixture("android");
      const pinned = [
        "apps/android/version.json",
        "apps/android/Config/Version.properties",
        "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
      ];
      const original = pinned.map((file) => read(f.root, file));
      const ci = workflowEnv(f.base);
      if (destination === "internal") {
        const rejected = f.invoke("run", ["--destination", destination], {
          ...ci,
          FIXTURE_FIREBASE_PREFLIGHT_FAIL: "1",
        });
        expectResult(rejected, 1);
        expect(fs.existsSync(f.uploadAudit)).toBe(false);
        expect(exists(f.recovery, "source")).toBe(false);
      }
      const result = f.invoke(
        "run",
        destination === "internal" ? ["--destination", destination] : [],
        destination === "internal"
          ? { ...ci, FIXTURE_FIREBASE_FAIL: "1" }
          : event === "schedule"
            ? ci
            : {},
      );
      if (destination === "internal") {
        expectResult(result, 1, "Play upload confirmed; Firebase incomplete");
        const recovered = f.invoke("firebase", [], { OPENAI_API_KEY: "" });
        expectResult(recovered, 0);
        const calls = readLines(f.firebaseAudit);
        expect(
          calls
            .filter((call) => call.pathname.endsWith("releases:upload"))
            .map((call) => call.body),
        ).toEqual(["synthetic signed wear bundle", "synthetic signed play bundle"]);
        expect(
          calls
            .filter((call) => call.pathname.endsWith(":distribute"))
            .map((call) => call.pathname.split("/").at(-1)),
        ).toEqual(["wear:distribute", "phone:distribute", "phone:distribute"]);
        expect(f.audit()).toHaveLength(1);
        expect(recovered.stdout).not.toContain("Android versionName:");
      } else {
        expectResult(result, 0);
        expect(fs.existsSync(f.firebaseAudit)).toBe(false);
      }
      expect(json(f.recovery, "android-plan.json")).toMatchObject({
        destination,
        sourceSha: f.base,
      });
      expect(result.stdout.match(/^Release artifact: .+$/gm)).toEqual([
        "Release artifact: wear aab",
        "Release artifact: play aab",
      ]);
      expect(f.audit()[0]).toMatchObject({
        version: "2026.9.20",
        versionCode: 2026090250,
        wearVersionCode: 2026090251,
        uploadMetadata: destination === "play-store",
        gradleVersion: "2026.9.20",
        gradleCode: "2026090250",
        gradleWearCode: "2026090251",
      });
      expect(
        f.ref("refs/openclaw/mobile-releases/android/v2/2026.9.2/0/1/2026090250-2026090251"),
      ).toBe(f.base);
      expect(f.ref("main")).toBe(f.base);
      expect(pinned.map((file) => read(f.root, file))).toEqual(original);
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
      expectResult(rebuilt, 0);
      expect(rebuilt.stdout).toContain("Android versionCode: 2026090250");
      expect(rebuilt.stdout).toContain("Release artifact: third-party apk");
      expect(git(f.root, "status", "--porcelain")).toBe("");
    },
  );

  it.each(["workflow_dispatch", "schedule"])(
    "uploads detached %s source without advancing main",
    (event) => {
      const f = fixture();
      const advanced = advanceMain(f);
      expectResult(f.invoke("run"), 1, "Local main differs from origin/main");
      expect(fs.existsSync(f.uploadAudit)).toBe(false);
      git(f.root, "checkout", "--detach", f.base);
      const ci = workflowEnv(f.base, event);
      const result = f.invoke("run", [], ci);
      expectResult(result, 0);
      const invalidDispatches: Record<string, string>[] = [
        { GITHUB_SHA: advanced },
        { GITHUB_REF: "refs/heads/feature" },
        { GITHUB_REPOSITORY: "example/fork" },
        { GITHUB_EVENT_NAME: "push" },
      ];
      for (const overrides of invalidDispatches) {
        const rejected = f.invoke("run", [], { ...ci, ...overrides });
        expectResult(
          rejected,
          1,
          "exact workflow_dispatch or schedule commit on openclaw/openclaw main",
        );
        expect(f.audit()).toHaveLength(1);
        expect(exists(f.recovery, "source")).toBe(false);
      }
      expect(f.audit()).toEqual([
        expect.objectContaining({
          sha: f.base,
          stampedSha: f.base,
          status: "",
          remoteMain: advanced,
          metadata: originalMetadata,
          notes: "Bug fixes and improvements.",
          stageOnly: false,
        }),
      ]);
      expect([f.ref("main"), f.ref(uploadRef)]).toEqual([advanced, f.base]);
      expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
      expect(
        ["source", "release-notes.json", "release.bundle"].map((file) => exists(f.recovery, file)),
      ).toEqual([false, true, false]);
      expect(fs.readdirSync(path.join(f.recovery, "screenshot-diagnostics"))).toEqual([
        "screenshot-diagnostics.json",
      ]);
      expect(json(f.recovery, "screenshot-diagnostics/screenshot-diagnostics.json")).toEqual({
        schemaVersion: 1,
        diagnostics: [{ phase: "build", durationSeconds: 1.25, outcome: "succeeded" }],
      });
      expect(git(f.remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
        "refs/heads/main",
      );
      const repeated = f.invoke("run", [], { GITHUB_ACTIONS: "true", GITHUB_RUN_ATTEMPT: "2" });
      expect(repeated.stderr).toContain("Do not rerun the upload job");
      expect(f.audit()).toHaveLength(1);
    },
  );

  it("admits scheduled TestFlight on attached exact main", () => {
    const f = fixture("ios", testflightPlan());
    expectResult(f.invoke("run", ["--destination", "testflight"], workflowEnv(f.base)), 0);
    expect(f.audit()).toEqual([
      expect.objectContaining({ destination: "testflight", sha: f.base, stageOnly: false }),
    ]);
  });

  it("retains safe screenshot diagnostics before archive and refuses staging without an upload", () => {
    const f = fixture();
    const result = f.invoke("run", [], { FIXTURE_UPLOAD_FAIL: "1" });
    expectResult(result, 1, "Synthetic store upload refused");
    expect(
      ["source", "release-notes.json", "artifacts"].map((file) => exists(f.recovery, file)),
    ).toEqual([true, true, false]);
    const diagnostics = path.join(f.recovery, "screenshot-diagnostics");
    expect(fs.readdirSync(diagnostics).toSorted()).toEqual([
      "capture-attempts.json",
      "screenshot-diagnostics.json",
      "screenshots",
    ]);
    expect(json(diagnostics, "screenshot-diagnostics.json")).toEqual({
      schemaVersion: 1,
      diagnostics: [{ phase: "build", durationSeconds: 1.25, outcome: "succeeded" }],
    });
    expect(json(diagnostics, "capture-attempts.json")).toEqual({
      schemaVersion: 1,
      attempts: [
        {
          deviceName: "iPhone",
          screenshotName: "02-chat-connected",
          attempt: 1,
          captureOutcome: "failed",
        },
      ],
    });
    expect(read(diagnostics, "screenshots/iPhone-01-control-connected.png")).toBe(
      "Synthetic fixture screenshot",
    );
    expectResult(f.invoke("stage"), 1, "No matching upload record");
    expect(f.audit()).toHaveLength(1);
    expect(f.ref("main")).toBe(f.base);
  });

  it.each(["app-store", "testflight"])(
    "recovers the saved %s destination with corrected tooling and original source without uploading twice",
    (destination) => {
      const f = fixture("ios", destination === "testflight" ? testflightPlan() : undefined);
      const result = f.invoke("run", ["--destination", destination], {
        FIXTURE_STAGE_FAIL: "1",
        OPENCLAW_IOS_RELEASE_SOURCE_ROOT: "/invalid-inherited-source",
      });
      expectResult(result, 1, "Synthetic metadata stage refused after upload");
      expect(f.ref(uploadRef)).toBe(f.base);
      const savedFiles = ["release-notes.json", "ios-plan.json"];
      const savedContents = savedFiles.map((file) => read(f.recovery, file));
      write(
        f.root,
        "scripts/ios-release-upload.sh",
        'echo "Corrected staging tooling"\nexec node scripts/fixture-upload.mjs "$@"\n',
      );
      const toolingSha = commit(f.root, "Fix staging tooling after upload");
      const source = path.join(f.recovery, "source");
      if (destination === "testflight") {
        // Downloaded recovery artifacts have no source checkout.
        git(f.root, "worktree", "remove", "--force", source);
      } else {
        write(source, "README.md", "Uncommitted recovery work.\n");
        expectResult(f.invoke("stage"), 1, "require a clean checkout");
        expect(read(source, "README.md")).toBe("Uncommitted recovery work.\n");
        git(source, "checkout", "--", "README.md");
        git(source, "checkout", "--detach", toolingSha);
        expectResult(f.invoke("stage"), 1, "Retained source differs from the uploaded build");
        expect(git(source, "rev-parse", "HEAD")).toBe(toolingSha);
        git(source, "checkout", "--detach", f.base);
        expect(f.audit()).toHaveLength(1);
      }
      const recovery = f.invoke("stage", [], { OPENAI_API_KEY: "" });
      expectResult(recovery, 0);
      expect(recovery.stdout).toContain("Corrected staging tooling");
      expect(f.audit()).toMatchObject([
        { sha: f.base, stampedSha: f.base, stageOnly: false, destination },
        { sha: toolingSha, stampedSha: f.base, stageOnly: true, destination },
      ]);
      expect(savedFiles.map((file) => read(f.recovery, file))).toEqual(savedContents);
      expect(exists(f.recovery, "source")).toBe(false);
      expect([f.ref("main"), f.ref(uploadRef)]).toEqual([f.base, f.base]);
    },
  );

  it("stages an existing App Store build for TestFlight and recovers its frozen notes without uploading", () => {
    const storeBuild = build({ id: "store-build" });
    const f = fixture("ios", testflightPlan([storeBuild]));
    const existingRef = "refs/openclaw/mobile-releases/ios/2026.9.20-7";
    git(f.root, "push", "origin", `${f.base}:${existingRef}`);
    const result = f.invoke("run", ["--destination", "testflight"], { FIXTURE_STAGE_FAIL: "1" });
    expectResult(result, 1, "Synthetic metadata stage refused after upload");
    expect(f.audit()).toEqual([
      expect.objectContaining({ destination: "testflight", buildNumber: "7", stageOnly: true }),
    ]);
    expect(json(f.recovery, "ios-plan.json")).toMatchObject({
      destination: "testflight",
      decision: "stage-existing",
      buildNumber: 7,
      sourceSha: f.base,
      testflight: { existingBuildId: storeBuild.id },
    });
    const notes = read(f.recovery, "release-notes.json");
    const recovered = f.invoke("stage", [], { OPENAI_API_KEY: "" });
    expectResult(recovered, 0);
    expect(f.audit().map((entry) => [entry.stageOnly, entry.buildNumber])).toEqual([
      [true, "7"],
      [true, "7"],
    ]);
    expect(read(f.recovery, "release-notes.json")).toBe(notes);
    expect(git(f.root, "ls-remote", "--refs", "origin", uploadRef)).toBe("");
    expect(f.ref(existingRef)).toBe(f.base);
    expect(exists(f.recovery, "source")).toBe(false);
  });

  it.each(["unchanged", "deferred-review", "recovery-required"])(
    "does not upload or regenerate notes for TestFlight %s",
    (outcome) => {
      const candidate = build({
        externalState:
          outcome === "deferred-review"
            ? "WAITING_FOR_BETA_REVIEW"
            : outcome === "recovery-required"
              ? "READY_FOR_BETA_SUBMISSION"
              : "IN_BETA_TESTING",
        configured: outcome !== "recovery-required",
        selectedForAppStore: outcome === "recovery-required",
        hasBetaNotes: true,
      });
      const f = fixture(
        "ios",
        testflightPlan([candidate], outcome === "deferred-review" ? candidate : null),
        true,
      );
      if (outcome !== "deferred-review") {
        git(f.root, "push", "origin", `${f.base}:refs/openclaw/mobile-releases/ios/2026.9.20-7`);
      }
      const result = f.invoke("run", ["--destination", "testflight"], { OPENAI_API_KEY: "" });
      expect(fs.existsSync(f.uploadAudit)).toBe(false);
      expect(exists(f.recovery, "release-notes.json")).toBe(false);
      expect(exists(f.recovery, "source")).toBe(false);
      expect(git(f.root, "rev-parse", "--is-shallow-repository")).toBe("true");
      if (outcome === "recovery-required") {
        expectResult(result, 1, "Recover its saved destination");
      } else {
        expectResult(result, 0);
        expect(json(f.recovery, "testflight-result.json")).toMatchObject({
          outcome,
          groupId: "external-fixture",
          sourceSha: f.base,
        });
      }
    },
  );

  it.each(["ios", "android"])(
    "retains full %s release ancestry when notes are needed",
    (platform) => {
      const f = fixture(platform, undefined, true);
      const latestMain = advanceMain(f);
      expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("1");
      const result = f.invoke("run", [], workflowEnv(f.base));
      expectResult(result, 0);
      expect(git(f.root, "log", "--format=%s")).toBe("Update application source\nInitial source");
      expect(f.audit()).toHaveLength(1);
      expect(f.ref("main")).toBe(latestMain);
      expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
    },
  );

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
    expect(exists(f.recovery, "source")).toBe(false);
    expect(fs.existsSync(f.uploadAudit)).toBe(false);
  });
});
