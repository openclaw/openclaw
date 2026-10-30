import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { transferRepoE2eArtifacts } from "../../scripts/repo-e2e-artifacts.mts";
import { resolveBuildRequirement } from "../../scripts/run-node.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const workflowHarnesses = new Map<string, string>();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function transferThroughWorkflowHarness(
  operation: "pack" | "restore",
  artifact: string,
  profile: string,
  root: string,
) {
  const jobName = operation === "pack" ? "build" : "test";
  let harness = workflowHarnesses.get(jobName);
  if (!harness) {
    const workflow = parse(
      fs.readFileSync(".github/workflows/openclaw-repo-e2e-reusable.yml", "utf8"),
    );
    const checkout = workflow.jobs[jobName].steps.find(
      (step: { name?: string }) => step.name === "Checkout trusted artifact harness",
    )?.with;
    if (typeof checkout?.["sparse-checkout"] !== "string") {
      throw new Error("Expected the workflow's bounded artifact-harness checkout");
    }
    harness = path.join(tempDirs.make("repo-e2e-sparse-harness-"), "harness");
    // Real Git acquisition and native Node expose hidden checkout/loader dependencies.
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", process.cwd(), harness]);
    const cone = checkout["sparse-checkout-cone-mode"] === false ? "--no-cone" : "--cone";
    execFileSync("git", ["sparse-checkout", "set", cone, "--stdin"], {
      cwd: harness,
      input: checkout["sparse-checkout"],
    });
    git(harness, "checkout", "--quiet", "--detach", "HEAD");
    // Copy working changes only for materialized paths (not skip-worktree `S` entries).
    const selectedPaths = checkout["sparse-checkout"]
      .trim()
      .split("\n")
      .map((entry: string) => entry.trim().replace(/^\/|\/$/gu, ""));
    const acquired = git(harness, "ls-files", "-t", "-z", "--", ...selectedPaths);
    for (const entry of acquired.split("\0")) {
      if (!entry.startsWith("H ")) {
        continue;
      }
      const file = entry.slice(2);
      const destination = path.join(harness, file);
      if (fs.lstatSync(destination).isFile()) {
        fs.copyFileSync(path.resolve(file), destination);
      }
    }
    expect(fs.existsSync(path.join(harness, "src/index.ts"))).toBe(false);
    workflowHarnesses.set(jobName, harness);
  }
  execFileSync(
    process.execPath,
    [path.join(harness, "scripts/repo-e2e-artifacts.mts"), operation, artifact, profile],
    {
      cwd: root,
      env: { PATH: process.env.PATH, OPENCLAW_BUILD_PRIVATE_QA: "1" },
      stdio: "pipe",
    },
  );
}

function fixture() {
  const root = fs.realpathSync(tempDirs.make("repo-e2e-artifacts-"));
  const { write, read, json } = fixtureFiles(root);
  const artifact = path.join(root, "artifacts");
  const assets = {
    "extensions/demo/assets/.bundle.hash": "generated-hash\n",
    "extensions/demo/assets/runtime.js": "generated-runtime\n",
  };
  for (const [file, contents] of Object.entries({
    "package.json": '{"name":"artifact-fixture"}\n',
    "packages/demo/package.json": "{}\n",
    ".gitignore": "dist\ndist-runtime\npackages/*/dist\nartifacts\n",
    ...assets,
  })) {
    write(file, contents);
  }
  const asset = "assets/runtime.js";
  json("extensions/demo/package.json", {
    openclaw: {
      assetScripts: { build: "fixture-build", buildOutputs: ["assets/.bundle.hash"] },
      build: { staticAssets: [{ source: asset, output: asset }] },
    },
  });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const head = git(root, "rev-parse", "HEAD").trim();
  write("dist/index.js", "#!/usr/bin/env node\nconsole.log('artifact');\n");
  fs.chmodSync(path.join(root, "dist/index.js"), 0o755);
  write("dist/private-qa.js", "private QA\n");
  for (const stamp of [".buildstamp", ".runtime-postbuildstamp"]) {
    write(`dist/${stamp}`, JSON.stringify({ head, inputsClean: true }));
  }
  write("packages/demo/dist/index.d.ts", "export declare const ready: true;\n");
  fs.mkdirSync(path.join(root, "dist-runtime"));
  fs.symlinkSync("../dist/index.js", path.join(root, "dist-runtime/index.js"));
  const oldStamp = new Date(Date.now() - 20_000);
  for (const stamp of [".buildstamp", ".runtime-postbuildstamp"]) {
    fs.utimesSync(path.join(root, "dist", stamp), oldStamp, oldStamp);
  }
  const configTime = new Date(Date.now() - 10_000);
  fs.utimesSync(path.join(root, "package.json"), configTime, configTime);
  const mtime = (file: string) => fs.statSync(path.join(root, file)).mtimeMs;
  const transfer = (op: "pack" | "restore") => transferRepoE2eArtifacts(op, artifact, "full", root);
  const remove = (...files: string[]) => {
    for (const file of files) {
      fs.rmSync(path.join(root, file), { recursive: true });
    }
  };
  return { root, artifact, assets, read, mtime, write, transfer, remove };
}

function requirement(root: string) {
  return resolveBuildRequirement({
    cwd: root,
    env: {},
    fs,
    spawnSync,
    distRoot: path.join(root, "dist"),
    distEntry: path.join(root, "dist/index.js"),
    buildStampPath: path.join(root, "dist/.buildstamp"),
    configFiles: [path.join(root, "package.json")],
    sourceRoots: [],
  });
}

describe("repo E2E artifact transfer", () => {
  beforeEach(() => vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["full", "ciArtifacts"])(
    "restores a complete %s build through the workflow harness without rebuilding",
    (profile) => {
      const { root, artifact, assets, read, mtime, remove } = fixture();
      const producerStamp = read("dist/.buildstamp");
      transferThroughWorkflowHarness("pack", artifact, profile, root);
      remove("dist", "dist-runtime", "packages/demo/dist", "extensions/demo/assets");
      // Clean Git state outranks archive mtimes; restore still refreshes the local stamp.
      execFileSync("tar", ["-xzf", path.join(artifact, "repo-e2e-build.tar.gz")], { cwd: root });
      expect(requirement(root)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(mtime("dist/.buildstamp")).toBeLessThan(mtime("package.json"));
      transferThroughWorkflowHarness("restore", artifact, profile, root);
      expect(read("dist/.buildstamp")).toBe(producerStamp);
      expect(requirement(root)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(mtime("dist/.buildstamp")).toBeGreaterThanOrEqual(mtime("package.json"));
      expect(fs.readlinkSync(path.join(root, "dist-runtime/index.js"))).toBe("../dist/index.js");
      expect(execFileSync(path.join(root, "dist/index.js"), { encoding: "utf8" })).toBe(
        "artifact\n",
      );
      expect(read("dist/private-qa.js")).toBe("private QA\n");
      expect(read("packages/demo/dist/index.d.ts")).toContain("ready");
      for (const [file, contents] of Object.entries(assets)) {
        expect(read(file)).toBe(contents);
      }
      expect(mtime("dist/.runtime-postbuildstamp")).toBeGreaterThanOrEqual(
        mtime("dist/.buildstamp"),
      );
    },
  );

  it.each([false, null])(
    "keeps unverified producer stamps (%s) untrusted after restore",
    (inputsClean) => {
      const { root, transfer, remove, read, write } = fixture();
      const original = JSON.stringify({
        ...JSON.parse(read("dist/.buildstamp")),
        inputsClean,
      });
      write("dist/.buildstamp", original);
      transfer("pack");
      remove("dist");
      transfer("restore");
      expect(read("dist/.buildstamp")).toBe(original);
      expect(requirement(root).shouldBuild).toBe(true);
    },
  );

  it("rejects mismatched artifact identity before extraction", () => {
    const { root, transfer, write, read, remove } = fixture();
    transfer("pack");
    remove("dist");
    const recorded = JSON.parse(read("artifacts/repo-e2e-build.json"));
    recorded.identity.targetSha = "mismatched";
    write("artifacts/repo-e2e-build.json", JSON.stringify(recorded));
    expect(() => transfer("restore")).toThrow("artifact identity differs");
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });

  it("rejects corrupt archives before extraction", () => {
    const { root, artifact, transfer, remove } = fixture();
    transfer("pack");
    fs.appendFileSync(path.join(artifact, "repo-e2e-build.tar.gz"), "corruption");
    remove("dist");
    expect(() => transfer("restore")).toThrow("archive digest mismatch");
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });
});
