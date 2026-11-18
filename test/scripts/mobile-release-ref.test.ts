import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeAndroidStoreRelease,
  mobileReleaseRefFor,
  parseArgs,
  preflightMobileReleaseRef,
  recordMobileReleaseRef,
  resolveMobileReleaseRef,
} from "../../scripts/mobile-release-ref.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { commit, git as repoGit, initGit, write } from "./mobile-release-git.test-support.js";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "mobile-release-ref.ts");
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const git = (cwd: string, args: string[]) => repoGit(cwd, ...args);
function cli(...args: string[]) {
  return run(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], process.cwd());
}
function gitFailure(stderr: string, message = "Git push failed") {
  return Object.assign(new Error(message), { stderr });
}
function flags(values: Record<string, string>) {
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
}
function recordOptions(root: string, sha = "HEAD", build = "8") {
  return parseArgs([
    "record",
    ...flags({ platform: "ios", version: "2026.6.10", build, sha, root }),
  ]);
}
function commitReadme(root: string, contents: string) {
  write(root, "README.md", `${contents}\n`);
  return commit(root, contents, "README.md");
}
function recording(
  options: ReturnType<typeof parseArgs>,
  intercept: (args: string[], forward: () => string) => string,
) {
  return () =>
    recordMobileReleaseRef(options, {
      execFileSync: (command, args, execOptions) =>
        intercept(args, () => execFileSync(command, args, execOptions)),
    });
}

function createFixtureRepo(tempDirs = tempRoots): { remote: string; root: string; sha: string } {
  const root = tempDirs.make("openclaw-mobile-release-ref-");
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  git(root, ["init", "--bare", remote]);
  initGit(checkout, { name: "Release Test", email: "release@example.com" });
  git(checkout, ["remote", "add", "origin", remote]);
  const sha = commitReadme(checkout, "release");
  git(checkout, ["push", "origin", "HEAD:main"]);
  return { remote: "origin", root: checkout, sha };
}

describe("mobile-release-ref", () => {
  describe("transient Git failures", () => {
    const retryRoots = useAutoCleanupTempDirTracker(afterAll);
    let fixture: ReturnType<typeof createFixtureRepo>;
    let options: ReturnType<typeof parseArgs>;
    let nextBuild = 100;

    beforeAll(() => {
      fixture = createFixtureRepo(retryRoots);
    });

    beforeEach(() => {
      options = recordOptions(fixture.root, fixture.sha, String(nextBuild++));
      vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([
      [
        "push",
        "Unable to determine if workflow can be created or updated due to timeout; `workflows` scope may be required.",
      ],
      ["push", "fatal: unable to access remote: The requested URL returned error: 503"],
      ["push", "fatal: unable to access remote: Recv failure: Connection reset by peer"],
      ["ls-remote", "fatal: Could not resolve host: github.com"],
    ])("retries transient %s failure and records the original source: %s", (operation, stderr) => {
      let attempts = 0;
      const result = recording(options, (args, forward) => {
        if (args[0] === operation && ++attempts === 1) {
          throw gitFailure(stderr);
        }
        return forward();
      })();
      expect(result).toMatchObject({ sha: fixture.sha, status: "created" });
      expect(resolveMobileReleaseRef(options).sha).toBe(fixture.sha);
      if (operation === "push") {
        expect(attempts).toBe(2);
      }
      expect(Atomics.wait).toHaveBeenCalledTimes(1);
    });

    it.each([1, 4])("reconciles a lost push response when %i readbacks fail", (failedReads) => {
      let pushes = 0;
      let readbacks = 0;
      const record = recording(options, (args, forward) => {
        if (args[0] === "ls-remote" && pushes > 0 && ++readbacks <= failedReads) {
          throw gitFailure("fatal: Operation timed out", "Git lookup failed");
        }
        const result = forward();
        if (args[0] === "push") {
          pushes += 1;
          throw gitFailure("fatal: the remote end hung up unexpectedly", "Git response lost");
        }
        return result;
      });
      if (failedReads === 1) {
        expect(record()).toMatchObject({ sha: fixture.sha, status: "already-recorded" });
      } else {
        expect(record).toThrow("Failed to inspect remote release ref");
      }
      expect(resolveMobileReleaseRef(options).sha).toBe(fixture.sha);
      expect(pushes).toBe(1);
      expect(Atomics.wait).toHaveBeenCalledTimes(Math.min(failedReads, 3));
    });

    it.each([
      ["fatal: The requested URL returned error: 502", 4, [5_000, 10_000, 20_000]],
      ["fatal: Authentication failed", 1, []],
      ["fatal: The requested URL returned error: 403", 1, []],
      [
        "remote: refusing to allow a GitHub App to create or update workflow without workflows permission",
        1,
        [],
      ],
      ["remote: GH013: Repository rule violations found", 1, []],
      ["unknown remote rejection", 1, []],
    ] as const)("bounds retries for %s", (stderr, attempts, delays) => {
      let pushes = 0;
      expect(
        recording(options, (args, forward) => {
          if (args[0] === "push") {
            pushes += 1;
            throw gitFailure(stderr);
          }
          return forward();
        }),
      ).toThrow(attempts === 4 ? "Failed to create mobile release ref" : stderr);
      expect(pushes).toBe(attempts);
      expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual(delays);
      if (attempts === 4) {
        expect(() => resolveMobileReleaseRef(options)).toThrow("does not exist");
      }
    });

    it.each([false, true])("preserves concurrent refs (conflicting: %s)", (conflict) => {
      const otherSha = conflict
        ? git(fixture.root, [
            "commit-tree",
            `${fixture.sha}^{tree}`,
            "-p",
            fixture.sha,
            "-m",
            "competing release",
          ]).trim()
        : fixture.sha;
      const ref = `refs/openclaw/mobile-releases/ios/2026.6.10-${options.build}`;
      vi.mocked(Atomics.wait).mockImplementation(() => {
        git(fixture.root, ["push", "origin", `${otherSha}:${ref}`]);
        return "timed-out";
      });
      let pushes = 0;
      const record = recording(options, (args, forward) => {
        if (args[0] === "push" && ++pushes === 1) {
          throw gitFailure("fatal: Connection timed out");
        }
        return forward();
      });
      if (conflict) {
        expect(record).toThrow(`already points at ${otherSha}`);
      } else {
        expect(record()).toMatchObject({ sha: fixture.sha, status: "created" });
      }
      expect(git(fixture.root, ["ls-remote", "--refs", "origin", ref]).trim()).toBe(
        `${otherSha}\t${ref}`,
      );
      expect(Atomics.wait).toHaveBeenCalledTimes(1);
    });
  });

  it("validates platform-specific numeric identities", () => {
    const rejects = (
      identity: Omit<Parameters<typeof mobileReleaseRefFor>[0], "version"> & { version?: string },
      error: string,
    ) => expect(() => mobileReleaseRefFor({ version: "2026.6.10", ...identity })).toThrow(error);
    rejects({ platform: "ios", build: "0" }, "Invalid iOS build");
    rejects({ platform: "android" }, "Invalid Android versionCode");
    rejects({ platform: "android", versionCode: "not-a-code" }, "Invalid Android versionCode");
    rejects(
      { platform: "android", versionCode: "2026061101" },
      "Expected 2026061001 through 2026061099",
    );
    rejects(
      { platform: "ios", version: "2026.06.10", build: "8" },
      "Invalid mobile release version",
    );
  });

  it("preserves flag ordering and fails before treating a missing value as help", () => {
    expect(
      parseArgs(["resolve", "--platform", "android", "--", "--platform", "ios"]),
    ).toMatchObject({ platform: "ios", sha: "HEAD" });
    expect(() => parseArgs(["resolve", "--root", "-h"])).toThrow("Missing value for --root.");
    expect(() => parseArgs(["resolve", "--platform=ios"])).toThrow(
      "Unknown argument: --platform=ios",
    );
    expect(() => parseArgs(["resolve", "--help", "--unknown"])).toThrow("Usage:");
  });

  it("records immutable platform refs and resolves the recorded SHA through the CLI", () => {
    const fixture = createFixtureRepo();
    const iosOptions = recordOptions(fixture.root);
    const recorded = { ref: "refs/openclaw/mobile-releases/ios/2026.6.10-8", sha: fixture.sha };
    expect(preflightMobileReleaseRef(iosOptions).status).toBe("available");
    expect(recordMobileReleaseRef(iosOptions)).toMatchObject({ ...recorded, status: "created" });
    expect(recordMobileReleaseRef(iosOptions).status).toBe("already-recorded");
    expect(resolveMobileReleaseRef(iosOptions)).toMatchObject(recorded);

    const identity = { platform: "android", version: "2026.6.10" };
    const versionCode = "2026061008";
    const args = flags({
      ...identity,
      "version-code": versionCode,
      sha: "HEAD",
      root: fixture.root,
    });
    const androidOptions = parseArgs(["record", "--", ...args]);
    expect(androidOptions).toMatchObject({ command: "record", ...identity, versionCode });
    expect(recordMobileReleaseRef(androidOptions).ref).toBe(
      "refs/openclaw/mobile-releases/android/2026.6.10-2026061008",
    );
    commitReadme(fixture.root, "next");
    expect(() => recordMobileReleaseRef(androidOptions)).toThrow("already points at");

    // CLI resolution must return the recorded build even after checkout HEAD advances.
    const stdout = cli(
      "resolve",
      ...flags({ platform: "ios", version: "2026.6.10", build: "8", root: fixture.root }),
    );

    expect(stdout).toBe(`${fixture.sha}\t${recorded.ref}\n`);
  });

  it("runs the CLI entrypoint from a path containing spaces", () => {
    const root = tempRoots.make("openclaw mobile release ref-");
    const scriptDir = path.join(root, "script dir");
    const scriptPath = path.join(scriptDir, "mobile-release-ref.ts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
    copyFileSync(SCRIPT_PATH, scriptPath);
    symlinkSync(
      path.join(path.dirname(SCRIPT_PATH), "lib"),
      path.join(scriptDir, "lib"),
      "junction",
    );

    const stdout = run(
      process.execPath,
      ["--import", "tsx", realpathSync(scriptPath), "--help"],
      process.cwd(),
    );

    expect(stdout).toContain("scripts/mobile-release-ref.ts preflight");
  });

  it("records Android v2 plans and preserves the immutable cutover maximum across source commits", () => {
    const fixture = createFixtureRepo();
    const planPath = path.join(fixture.root, "android-plan.json");
    const plan = {
      schemaVersion: 2,
      gatewayVersion: "2026.9.6",
      revision: 0,
      buildNumber: 1,
      version: "2026.9.60",
      versionCode: 2026090454,
      wearVersionCode: 2026090455,
      legacyMaxVersionCode: 2026090453,
      sourceSha: fixture.sha,
      releaseNotesBaselines: [
        { audience: "phone", version: null, build: null },
        { audience: "wear", version: null, build: null },
      ],
    };
    const writePlan = (value = plan) => writeFileSync(planPath, JSON.stringify(value), "utf8");
    writePlan();
    const cliArgs = ["--plan", planPath, "--root", fixture.root];
    const options = parseArgs(["record", ...cliArgs]);
    const ref = "refs/openclaw/mobile-releases/android/v2/2026.9.6/0/1/2026090454-2026090455";
    const marker = "refs/openclaw/mobile-releases/android/cutover-v2/2026090453";
    const initialized = { ref: marker, sha: fixture.sha, status: "already-recorded" };
    expect(options).toMatchObject({ platform: "android", sha: fixture.sha, version: "2026.9.60" });
    expect(() => parseArgs(["record", ...cliArgs, "--sha", "HEAD"])).toThrow("does not match");
    expect(() => parseArgs(["record", ...cliArgs, "--platform", "ios"])).toThrow("does not match");
    expect(() => parseArgs(["initialize-android", "--platform", "android"])).toThrow(
      "requires --plan",
    );
    expect(preflightMobileReleaseRef(options).status).toBe("available");

    expect(cli("initialize-android", ...cliArgs)).toContain(`${marker} recorded ${fixture.sha}`);
    expect(initializeAndroidStoreRelease(options)).toEqual(initialized);

    // Git accepted this push, but the caller lost the response. The owner must read it back.
    let pushes = 0;
    expect(
      recording(options, (args, forward) => {
        const result = forward();
        if (args[0] === "push") {
          pushes += 1;
          throw new Error("response lost after accepted push");
        }
        return result;
      })(),
    ).toEqual({ ref, sha: fixture.sha, status: "already-recorded" });
    expect(pushes).toBe(1);
    expect(recordMobileReleaseRef(options).status).toBe("already-recorded");
    expect(cli("resolve", ...cliArgs)).toBe(`${fixture.sha}\t${ref}\n`);

    const nextSha = commitReadme(fixture.root, "next");
    expect(() => preflightMobileReleaseRef({ ...options, sha: nextSha })).toThrow(
      "source SHA does not match",
    );
    writePlan({ ...plan, sourceSha: nextSha });
    const nextOptions = parseArgs(["record", ...cliArgs]);
    expect(initializeAndroidStoreRelease(nextOptions)).toEqual(initialized);
    expect(() => recordMobileReleaseRef(nextOptions)).toThrow("already points at");
    expect(() => resolveMobileReleaseRef(nextOptions)).toThrow(
      "does not record Android plan source",
    );

    writePlan({ ...plan, sourceSha: nextSha, legacyMaxVersionCode: 2026090452 });
    expect(() =>
      initializeAndroidStoreRelease(parseArgs(["initialize-android", ...cliArgs])),
    ).toThrow("does not match planned");
    const conflictingMarker = "refs/openclaw/mobile-releases/android/cutover-v2/2026090452";
    git(fixture.root, ["push", "origin", `${nextSha}:${conflictingMarker}`]);
    expect(() => initializeAndroidStoreRelease(options)).toThrow(
      "Multiple Android store version cutover markers",
    );
  });
});
