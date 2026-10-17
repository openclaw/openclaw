import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAndroidSigningCommandSync } from "../../scripts/lib/android-release-signing-process.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = path.join(process.cwd(), "scripts", "android-release-signing.mjs");
const MATCH_PASSWORD = "test-match-password";
const STORE_PASSWORD = "store_secret_value";
const KEY_PASSWORD = "key_secret_value";
const APK_CERTIFICATE_SHA256 = "80dbc62315ea216dd6e8a7060735a866ddc464a48ed50fef29ff0550468b9a63";
const ZERO_INSTALL_FILES = [
  "scripts/android-release-signing.mjs",
  "scripts/lib/android-release-signing-process.mjs",
  "scripts/lib/arg-utils.runtime.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/repo-root.mjs",
  "apps/android/Config/ReleaseSigning.json",
] as const;

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const gitIdentity = {
  GIT_AUTHOR_NAME: "OpenClaw Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "OpenClaw Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
};

function expectNoSecrets(text: string) {
  expect(text).not.toContain(STORE_PASSWORD);
  expect(text).not.toContain(KEY_PASSWORD);
}

function expectSuccess(result: ReturnType<typeof runNode>) {
  expect(result.ok).toBe(true);
  expectNoSecrets(`${result.stdout}${result.stderr}`);
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: formatProcessOutput(e.stdout),
      stderr: formatProcessOutput(e.stderr),
    };
  }
}

function formatProcessOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function runGit(args: string[], cwd?: string, env: NodeJS.ProcessEnv = {}) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...gitIdentity,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync(command, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createSigningRepo(tempRoot: string): string {
  const seed = path.join(tempRoot, "seed");
  const remote = path.join(tempRoot, "apps-signing.git");
  fs.mkdirSync(seed, { recursive: true });
  runGit(["init", "--initial-branch=main"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "# signing\n");
  runGit(["add", "README.md"], seed);
  runGit(["commit", "-m", "Initial signing repo"], seed);
  runGit(["clone", "--bare", seed, remote], tempRoot);
  return remote;
}

function writeManifest(tempRoot: string, signingRepo: string): string {
  const manifestPath = path.join(tempRoot, "ReleaseSigning.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        signingRepo,
        signingBranch: "main",
        assetPath: "android/openclaw",
        uploadKeystoreEncryptedFile: "upload-keystore.jks.enc",
        gradlePropertiesEncryptedFile: "gradle.properties.enc",
        apkCertificateSha256: APK_CERTIFICATE_SHA256,
        materializedRoot: "unused-by-test",
        gradlePropertyNames: [
          "OPENCLAW_ANDROID_STORE_FILE",
          "OPENCLAW_ANDROID_STORE_PASSWORD",
          "OPENCLAW_ANDROID_KEY_ALIAS",
          "OPENCLAW_ANDROID_KEY_PASSWORD",
        ],
      },
      null,
      2,
    )}\n`,
  );
  return manifestPath;
}

function writeSigningSources(tempRoot: string) {
  const keystorePath = path.join(tempRoot, "upload-keystore.jks");
  const propertiesPath = path.join(tempRoot, "source.properties");
  fs.writeFileSync(keystorePath, "fake keystore bytes\n");
  fs.writeFileSync(
    propertiesPath,
    [
      `OPENCLAW_ANDROID_STORE_PASSWORD=${STORE_PASSWORD}`,
      "OPENCLAW_ANDROID_KEY_ALIAS=openclaw-upload",
      `OPENCLAW_ANDROID_KEY_PASSWORD=${KEY_PASSWORD}`,
      "",
    ].join("\n"),
  );
  return { keystorePath, propertiesPath };
}

describe("scripts/android-release-signing.mjs", () => {
  it("runs from an isolated copy without node_modules", () => {
    const isolatedRoot = tempRoots.make("openclaw-android-signing-");
    for (const relativePath of ZERO_INSTALL_FILES) {
      const sourcePath = path.join(process.cwd(), relativePath);
      const destinationPath = path.join(isolatedRoot, relativePath);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
    fs.writeFileSync(path.join(isolatedRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(isolatedRoot, "pnpm-workspace.yaml"), "packages: []\n");

    expect(fs.existsSync(path.join(isolatedRoot, "node_modules"))).toBe(false);
    const stdout = execFileSync(
      process.execPath,
      [path.join(isolatedRoot, "scripts", "android-release-signing.mjs"), "--mode", "plan"],
      {
        cwd: isolatedRoot,
        encoding: "utf8",
        env: Object.fromEntries(
          ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"]
            .map((name) => [name, process.env[name]])
            .filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      },
    );

    expect(stdout).toContain("Android release signing plan");
    expect(stdout).toContain("Signing repo: git@github.com:openclaw/apps-signing.git");
    expect(stdout).toContain("Signing assets: android/openclaw");
    expect(stdout).toContain(`Pinned APK certificate SHA-256: ${APK_CERTIFICATE_SHA256}`);
    expect(stdout).toContain("Materialized output: apps/android/build/release-signing");
    expect(stdout).toContain("ORG_GRADLE_PROJECT_*");
  });

  it("terminates a hung signing command at its deadline", () => {
    const timeoutMs = 100;
    const startedAt = Date.now();

    expect(() =>
      runAndroidSigningCommandSync(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        stdio: "pipe",
        timeoutMs,
      }),
    ).toThrow(`Android release signing command timed out after ${timeoutMs}ms`);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.each([
    ["--mode"],
    ["--mode", "--manifest"],
    ["--mode", "-h"],
    ["--manifest", "-h"],
    ["--workspace", "--mode"],
    ["--materialized-dir", "--mode"],
    ["--keystore", "--mode"],
    ["--properties", "--mode"],
  ])("rejects missing values for %s before release signing work", (...args) => {
    const result = runNode(args);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(`Missing value for ${args[0]}.`);
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stdout).toBe("");
  });

  it.runIf(commandAvailable("openssl"))(
    "encrypts, pulls, and materializes Android signing assets without printing secrets",
    () => {
      const tempRoot = tempRoots.make("openclaw-android-signing-");
      const signingRepo = createSigningRepo(tempRoot);
      const manifestPath = writeManifest(tempRoot, signingRepo);
      const { keystorePath, propertiesPath } = writeSigningSources(tempRoot);
      const materializedDir = path.join(tempRoot, "materialized");
      const env = { MATCH_PASSWORD, ...gitIdentity };
      const run = (mode: string, extra: string[] = []) =>
        runNode(
          [
            "--mode",
            mode,
            "--manifest",
            manifestPath,
            "--materialized-dir",
            materializedDir,
            ...extra,
          ],
          env,
        );
      const pullWorkspace = ["--workspace", path.join(materializedDir, "pull-workspace")];
      const keystore = path.join(materializedDir, "upload-keystore.jks");
      const properties = path.join(materializedDir, "gradle.properties");
      expectSuccess(
        run("sync-push", [
          "--workspace",
          path.join(materializedDir, "apps-signing"),
          "--keystore",
          keystorePath,
          "--properties",
          propertiesPath,
        ]),
      );

      const remoteCheck = path.join(tempRoot, "remote-check");
      runGit(["clone", signingRepo, remoteCheck], tempRoot);
      const encryptedProperties = fs.readFileSync(
        path.join(remoteCheck, "android", "openclaw", "gradle.properties.enc"),
        "utf8",
      );
      expectNoSecrets(encryptedProperties);

      fs.mkdirSync(materializedDir, { recursive: true });
      fs.writeFileSync(properties, "stale=1\n", { mode: 0o644 });
      fs.chmodSync(properties, 0o644);
      expectSuccess(run("sync-pull", pullWorkspace));
      expect(fs.readFileSync(keystore, "utf8")).toBe("fake keystore bytes\n");

      const materializedProperties = fs.readFileSync(properties, "utf8");
      expect(materializedProperties).toContain(`OPENCLAW_ANDROID_STORE_FILE=${keystore}`);
      expect(materializedProperties).toContain(`OPENCLAW_ANDROID_STORE_PASSWORD=${STORE_PASSWORD}`);
      expect(materializedProperties).toContain("OPENCLAW_ANDROID_KEY_ALIAS=openclaw-upload");
      expect(materializedProperties).toContain(`OPENCLAW_ANDROID_KEY_PASSWORD=${KEY_PASSWORD}`);
      if (process.platform !== "win32") {
        for (const file of [properties, keystore]) {
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
      }

      expect(
        runNode([
          "--mode",
          "check",
          "--manifest",
          manifestPath,
          "--materialized-dir",
          materializedDir,
        ]).ok,
      ).toBe(true);
      fs.rmSync(keystore);
      fs.rmSync(properties);
      expect(run("materialize", pullWorkspace).ok).toBe(true);
      expect(fs.readFileSync(keystore, "utf8")).toBe("fake keystore bytes\n");
    },
  );

  it("requires MATCH_PASSWORD before pushing encrypted signing assets", () => {
    const tempRoot = tempRoots.make("openclaw-android-signing-");
    const manifestPath = writeManifest(tempRoot, path.join(tempRoot, "apps-signing.git"));
    const { keystorePath, propertiesPath } = writeSigningSources(tempRoot);

    const result = runNode([
      "--mode",
      "sync-push",
      "--manifest",
      manifestPath,
      "--keystore",
      keystorePath,
      "--properties",
      propertiesPath,
    ]);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("MATCH_PASSWORD is required");
    expectNoSecrets(result.stderr);
  });
});
