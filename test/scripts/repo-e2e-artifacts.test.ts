import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { transferRepoE2eArtifacts } from "../../scripts/repo-e2e-artifacts.mts";
import { resolveBuildRequirement } from "../../scripts/run-node.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const workflowHarnesses = new Map<string, string>();

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
    // Real Git acquisition and native Node expose dependencies hidden by the
    // test process's complete checkout and module loader.
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", process.cwd(), harness]);
    execFileSync(
      "git",
      [
        "sparse-checkout",
        "set",
        checkout["sparse-checkout-cone-mode"] === false ? "--no-cone" : "--cone",
        "--stdin",
      ],
      { cwd: harness, input: checkout["sparse-checkout"] },
    );
    execFileSync("git", ["checkout", "--quiet", "--detach", "HEAD"], { cwd: harness });
    // Exercise working changes too, but never materialize a path excluded by
    // the workflow. Skip-worktree entries retain Git's `S` prefix, not `H`.
    const selectedPaths = checkout["sparse-checkout"]
      .trim()
      .split("\n")
      .map((entry: string) => entry.trim().replace(/^\/|\/$/gu, ""));
    const acquired = execFileSync("git", ["ls-files", "-t", "-z", "--", ...selectedPaths], {
      cwd: harness,
      encoding: "utf8",
    });
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
  const artifact = path.join(root, "artifacts");
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  write("package.json", '{"name":"artifact-fixture"}\n');
  write("packages/demo/package.json", "{}\n");
  write(
    "extensions/demo/package.json",
    JSON.stringify({
      openclaw: {
        assetScripts: { build: "fixture-build", buildOutputs: ["assets/.bundle.hash"] },
        build: { staticAssets: [{ source: "assets/runtime.js", output: "assets/runtime.js" }] },
      },
    }),
  );
  write("extensions/demo/assets/.bundle.hash", "generated-hash\n");
  write("extensions/demo/assets/runtime.js", "generated-runtime\n");
  write(".gitignore", "dist\ndist-runtime\npackages/*/dist\nartifacts\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    execFileSync("git", args, { cwd: root });
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  write("dist/index.js", "#!/usr/bin/env node\nconsole.log('artifact');\n");
  fs.chmodSync(path.join(root, "dist/index.js"), 0o755);
  write("dist/private-qa.js", "private QA\n");
  write("dist/.buildstamp", JSON.stringify({ head, inputsClean: true }));
  write("dist/.runtime-postbuildstamp", JSON.stringify({ head, inputsClean: true }));
  write("packages/demo/dist/index.d.ts", "export declare const ready: true;\n");
  fs.mkdirSync(path.join(root, "dist-runtime"));
  fs.symlinkSync("../dist/index.js", path.join(root, "dist-runtime/index.js"));
  const oldStamp = new Date(Date.now() - 20_000);
  fs.utimesSync(path.join(root, "dist/.buildstamp"), oldStamp, oldStamp);
  fs.utimesSync(path.join(root, "dist/.runtime-postbuildstamp"), oldStamp, oldStamp);
  const configTime = new Date(Date.now() - 10_000);
  fs.utimesSync(path.join(root, "package.json"), configTime, configTime);
  return { root, artifact };
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
      const { root, artifact } = fixture();
      transferThroughWorkflowHarness("pack", artifact, profile, root);
      for (const output of [
        "dist",
        "dist-runtime",
        "packages/demo/dist",
        "extensions/demo/assets",
      ]) {
        fs.rmSync(path.join(root, output), { recursive: true });
      }
      // Clean Git state outranks archive mtimes; restore still refreshes the local stamp.
      execFileSync("tar", ["-xzf", path.join(artifact, "repo-e2e-build.tar.gz")], { cwd: root });
      expect(requirement(root)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(fs.statSync(path.join(root, "dist/.buildstamp")).mtimeMs).toBeLessThan(
        fs.statSync(path.join(root, "package.json")).mtimeMs,
      );
      transferThroughWorkflowHarness("restore", artifact, profile, root);
      expect(requirement(root)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(fs.statSync(path.join(root, "dist/.buildstamp")).mtimeMs).toBeGreaterThanOrEqual(
        fs.statSync(path.join(root, "package.json")).mtimeMs,
      );
      expect(fs.readlinkSync(path.join(root, "dist-runtime/index.js"))).toBe("../dist/index.js");
      expect(execFileSync(path.join(root, "dist/index.js"), { encoding: "utf8" })).toBe(
        "artifact\n",
      );
      expect(fs.readFileSync(path.join(root, "dist/private-qa.js"), "utf8")).toBe("private QA\n");
      expect(fs.readFileSync(path.join(root, "packages/demo/dist/index.d.ts"), "utf8")).toContain(
        "ready",
      );
      expect(fs.readFileSync(path.join(root, "extensions/demo/assets/.bundle.hash"), "utf8")).toBe(
        "generated-hash\n",
      );
      expect(fs.readFileSync(path.join(root, "extensions/demo/assets/runtime.js"), "utf8")).toBe(
        "generated-runtime\n",
      );
      expect(
        fs.statSync(path.join(root, "dist/.runtime-postbuildstamp")).mtimeMs,
      ).toBeGreaterThanOrEqual(fs.statSync(path.join(root, "dist/.buildstamp")).mtimeMs);
    },
  );

  it.each([false, null, undefined])(
    "preserves unclean or legacy producer provenance (%s)",
    (inputsClean) => {
      const { root, artifact } = fixture();
      const buildStamp = path.join(root, "dist/.buildstamp");
      const recorded = JSON.parse(fs.readFileSync(buildStamp, "utf8"));
      recorded.inputsClean = inputsClean;
      const original = JSON.stringify(recorded);
      fs.writeFileSync(buildStamp, original);
      transferRepoE2eArtifacts("pack", artifact, "full", root);
      fs.rmSync(path.join(root, "dist"), { recursive: true });
      transferRepoE2eArtifacts("restore", artifact, "full", root);
      expect(fs.readFileSync(buildStamp, "utf8")).toBe(original);
      expect(requirement(root).shouldBuild).toBe(true);
    },
  );

  describe("identity validation", { concurrent: false }, () => {
    let root: string;
    let artifact: string;
    let manifest: string;
    let originalManifest: string;

    beforeAll(() => {
      vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
      try {
        ({ root, artifact } = fixture());
        transferRepoE2eArtifacts("pack", artifact, "full", root);
        manifest = path.join(artifact, "repo-e2e-build.json");
        originalManifest = fs.readFileSync(manifest, "utf8");
        fs.rmSync(path.join(root, "dist"), { recursive: true });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(["targetSha", "profile", "node", "platform", "arch", "privateQa"])(
      "rejects mismatched %s before extraction",
      (field) => {
        // Each probe changes one field of the pristine identity while reusing the real archive.
        const recorded = JSON.parse(originalManifest);
        recorded.identity[field] = "mismatched";
        fs.writeFileSync(manifest, JSON.stringify(recorded));
        try {
          expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
          expect(() => transferRepoE2eArtifacts("restore", artifact, "full", root)).toThrow(
            "artifact identity differs",
          );
          expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
        } finally {
          fs.writeFileSync(manifest, originalManifest);
          fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
        }
      },
    );
  });

  it("rejects corrupt archives before extraction", () => {
    const { root, artifact } = fixture();
    transferRepoE2eArtifacts("pack", artifact, "full", root);
    fs.appendFileSync(path.join(artifact, "repo-e2e-build.tar.gz"), "corruption");
    fs.rmSync(path.join(root, "dist"), { recursive: true });
    expect(() => transferRepoE2eArtifacts("restore", artifact, "full", root)).toThrow(
      "archive digest mismatch",
    );
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });
});
