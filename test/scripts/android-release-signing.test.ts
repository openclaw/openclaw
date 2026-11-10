import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAndroidSigningCommandSync } from "../../scripts/lib/android-release-signing-process.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

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
const sourceProperties = {
  OPENCLAW_ANDROID_STORE_PASSWORD: STORE_PASSWORD,
  OPENCLAW_ANDROID_KEY_ALIAS: "openclaw-upload",
  OPENCLAW_ANDROID_KEY_PASSWORD: KEY_PASSWORD,
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
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runGit(args: string[], cwd?: string, env: NodeJS.ProcessEnv = {}) {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...gitIdentity, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

function signingFixture(remote = false) {
  const root = tempRoots.make("openclaw-android-signing-");
  const repo = remote ? createSigningRepo(root) : path.join(root, "apps-signing.git");
  const { write, json } = fixtureFiles(root);
  const defaults: Record<string, unknown> = JSON.parse(
    fs.readFileSync("apps/android/Config/ReleaseSigning.json", "utf8"),
  );
  const manifest = json("ReleaseSigning.json", {
    ...defaults,
    signingRepo: repo,
  });
  const keystorePath = write("upload-keystore.jks", "fake keystore bytes\n");
  const propertiesPath = write(
    "source.properties",
    Object.entries(sourceProperties)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  const materializedDir = path.join(root, "materialized");
  const run = (mode: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    runNode(
      ["--mode", mode, "--manifest", manifest, "--materialized-dir", materializedDir, ...extra],
      env,
    );
  return {
    root,
    repo,
    materializedDir,
    run,
    sourceArgs: ["--keystore", keystorePath, "--properties", propertiesPath],
  };
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

    expect(stdout).toContain(`Pinned APK certificate SHA-256: ${APK_CERTIFICATE_SHA256}`);
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

  it.each([["--mode"], ["--mode", "--manifest"], ["--mode", "-h"], ["--manifest", "-h"]])(
    "rejects missing values for %s before release signing work",
    (...args) => {
      const result = runNode(args);

      expect(result).toMatchObject({ ok: false, stdout: "" });
      expect(result.stderr).toContain(`Missing value for ${args[0]}.`);
      expect(result.stderr).not.toContain("ENOENT");
    },
  );

  it.runIf(spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0)(
    "encrypts, pulls, and materializes Android signing assets without printing secrets",
    () => {
      const fixture = signingFixture(true);
      const { root: tempRoot, repo: signingRepo, materializedDir } = fixture;
      const env = { MATCH_PASSWORD, ...gitIdentity };
      const run = (mode: string, extra: string[] = []) => fixture.run(mode, extra, env);
      const pullWorkspace = ["--workspace", path.join(materializedDir, "pull-workspace")];
      const keystore = path.join(materializedDir, "upload-keystore.jks");
      const properties = path.join(materializedDir, "gradle.properties");
      expectSuccess(run("sync-push", fixture.sourceArgs));

      const remoteCheck = path.join(tempRoot, "remote-check");
      runGit(["clone", signingRepo, remoteCheck], tempRoot);
      expectNoSecrets(fixtureFiles(remoteCheck).read("android/openclaw/gradle.properties.enc"));

      fs.mkdirSync(materializedDir, { recursive: true });
      fs.writeFileSync(properties, "stale=1\n", { mode: 0o644 });
      fs.chmodSync(properties, 0o644);
      expectSuccess(run("sync-pull", pullWorkspace));
      expect(fs.readFileSync(keystore, "utf8")).toBe("fake keystore bytes\n");

      const materializedProperties = fs.readFileSync(properties, "utf8");
      for (const [key, value] of Object.entries({
        ...sourceProperties,
        OPENCLAW_ANDROID_STORE_FILE: keystore,
      })) {
        expect(materializedProperties).toContain(`${key}=${value}`);
      }
      if (process.platform !== "win32") {
        for (const file of [properties, keystore]) {
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
      }

      expect(fixture.run("check").ok).toBe(true);
      fs.rmSync(keystore);
      fs.rmSync(properties);
      expect(run("materialize", pullWorkspace).ok).toBe(true);
      expect(fs.readFileSync(keystore, "utf8")).toBe("fake keystore bytes\n");
    },
  );

  it("requires MATCH_PASSWORD before pushing encrypted signing assets", () => {
    const fixture = signingFixture();
    const result = fixture.run("sync-push", fixture.sourceArgs);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("MATCH_PASSWORD is required");
    expectNoSecrets(result.stderr);
  });
});
