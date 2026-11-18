import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { readWorkerBundleDirectoryManifest } from "../../shared/worker-bundle-archive.js";
import {
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ARTIFACT_PATHS,
} from "../../shared/worker-bundle-hash.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../shared/worker-bundle-limits.js";
import {
  createProjectPreparationFixture,
  runProjectScriptWithGitProbe,
} from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot, workerProjectSeedKey } from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "24.21.0";

async function fixture(setup?: string) {
  const root = tempDirs.make("snapshot-node-admission-");
  const f = await createProjectPreparationFixture(root, setup, false, { ".nvmrc": "24\n" });
  const tools = path.join(root, "tools");
  const releaseName = `node-v${version}-linux-x64`;
  const release = path.join(root, releaseName);
  await fs.mkdir(path.join(release, "bin"), { recursive: true });
  await fs.mkdir(tools);
  await fs.writeFile(path.join(release, "bin", "node"), `#!/bin/sh\necho v${version}\n`, {
    mode: 0o755,
  });
  await fs.writeFile(
    path.join(release, "bin", "npm-cli.js"),
    "// official fixture package entry\n",
  );
  await fs.symlink("npm-cli.js", path.join(release, "bin", "npm"));
  const archive = path.join(root, "node.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, releaseName], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const archiveSha256 = createHash("sha256")
    .update(await fs.readFile(archive))
    .digest("hex");
  await fs.writeFile(
    path.join(tools, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; *) echo x86_64;; esac\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(tools, "curl"),
    `#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp '${archive}' "$2"\n`,
    { mode: 0o755 },
  );
  const guest = {
    platform: "linux",
    arch: "x64",
    env: { ...process.env, HOME: f.home, PATH: tools + path.delimiter + process.env.PATH },
    fetch: async (url: string | URL | Request) =>
      new Response(
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith(
          "index.json",
        )
          ? JSON.stringify([{ version: `v${version}`, files: ["linux-x64"] }])
          : `${archiveSha256}  node-v${version}-linux-x64.tar.gz\n`,
      ),
  };
  const runScript = (script: string) =>
    runProjectScriptWithGitProbe(script, f.home, () => undefined, undefined, guest);
  const owner = await f.preparedOperation();
  let prepared;
  try {
    prepared = (await owner.project.prepare({ ...f, runScript })).preparedWorkspace!;
  } catch (error) {
    owner.close();
    throw error;
  }
  const cache = path.join(
    f.home,
    ".openclaw-worker",
    "toolchains",
    "node",
    `${version}-linux-x64-${archiveSha256}`,
  );
  return { ...f, root, owner, prepared, cache, runScript, archiveSha256 };
}

describe("native snapshot machine cache admission", () => {
  it.each([
    "complete",
    "retained-commit",
    "retained-unknown-manifest",
    "retained-seed-link",
    "retained-prepared-extra",
    "extra-file",
    "extra-directory",
    "escaping-link",
    "changed-byte",
    "missing-archive",
  ] as const)("inspects real repository Node installation before snapshot: %s", async (change) => {
    const f = await fixture();
    let currentProject = f.project;
    let currentSeed = f.seed;
    try {
      if (change.startsWith("retained-")) {
        f.owner.close();
        await fs.writeFile(path.join(f.repository, "input.txt"), "prepared revision B\n");
        await requireGit(f.repository, ["add", "input.txt"]);
        await requireGit(f.repository, ["commit", "--quiet", "-m", "revision B"]);
        currentProject = (await prepareWorkerProjectSnapshot({
          localPath: f.repository,
          namespace: "gateway",
        }))!;
        f.owner = await f.preparedOperation(undefined, {
          project: currentProject,
          key: "b".repeat(64),
        });
        f.prepared = (
          await f.owner.project.prepare({ ...f, runScript: f.runScript })
        ).preparedWorkspace!;
        currentSeed = path.join(path.dirname(f.seed), workerProjectSeedKey(currentProject));
        expect(await fs.readdir(path.dirname(currentSeed))).toContain(path.basename(currentSeed));
        expect(await requireGit(currentSeed, ["rev-parse", "HEAD"])).toBe(
          currentProject.baseCommit,
        );
        expect(await fs.readFile(path.join(currentSeed, "input.txt"), "utf8")).toBe(
          "prepared revision B\n",
        );
        if (change === "retained-unknown-manifest") {
          await fs.writeFile(
            path.join(f.home, ".openclaw-worker/manifests/unknown.json"),
            "unknown",
          );
        }
        if (change === "retained-seed-link") {
          const outside = path.join(f.root, "outside-seed");
          await fs.rename(currentSeed, outside);
          await fs.symlink(outside, currentSeed);
        }
        if (change === "retained-prepared-extra") {
          await fs.writeFile(path.join(path.dirname(f.prepared.homeDir), "unknown"), "unknown");
        }
      }
      if (change === "extra-file") {
        await fs.writeFile(path.join(f.cache, "unknown.txt"), "unapproved\n");
      }
      if (change === "extra-directory") {
        await fs.mkdir(path.join(f.cache, "unknown"));
      }
      if (change === "escaping-link") {
        await fs.unlink(path.join(f.cache, "bin", "npm"));
        await fs.symlink("../../../../../outside", path.join(f.cache, "bin", "npm"));
      }
      if (change === "changed-byte") {
        await fs.appendFile(path.join(f.cache, "bin", "node"), "# changed\n");
      }
      if (change === "missing-archive") {
        await fs.unlink(path.join(f.cache, ".archive.tgz"));
      }
      const seedsBeforeInspection = await fs.readdir(path.dirname(currentSeed));
      const inspect = f.owner.project.inspectPreparedWorkspace!({
        snapshot: true,
        runScript: f.runScript,
      });
      if (change === "complete" || change === "retained-commit") {
        const result = await inspect;
        if (change === "retained-commit") {
          expect(await fs.readdir(path.dirname(f.seed))).toEqual([
            workerProjectSeedKey(currentProject),
          ]);
          expect(await fs.readdir(path.join(f.home, ".openclaw-worker/manifests"))).toEqual(
            [...new Set([f.prepared.sourceManifestRef, f.prepared.preparedManifestRef])]
              .map((ref) => ref.slice(7) + ".json")
              .toSorted(),
          );
          expect(await fs.readFile(path.join(f.prepared.workspaceDir, "input.txt"), "utf8")).toBe(
            "prepared revision B\n",
          );
        }
        expect(result).toMatchObject({
          sourceManifestRef: f.prepared.sourceManifestRef,
          preparedManifestRef: f.prepared.preparedManifestRef,
          validatedMachineCaches: {
            nodeToolchain: {
              version,
              platform: "linux",
              arch: "x64",
              archiveSha256: f.archiveSha256,
              inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          },
        });
        // The existing completion owner reads its new envelope on a fresh operation, too.
        const replay = await f.preparedOperation(undefined, {
          project: currentProject,
          key: f.prepared.preparationKey,
        });
        try {
          await replay.project.prepare({ ...f, runScript: f.runScript });
          await expect(
            replay.project.inspectPreparedWorkspace!({ snapshot: true, runScript: f.runScript }),
          ).resolves.toEqual(result);
        } finally {
          replay.close();
        }
        const factoryModule = process.env.OPENCLAW_TEST_FACTORY_SNAPSHOT_VERIFIER;
        if (factoryModule) {
          if (change === "retained-commit") {
            console.log("PAIRED_REFRESH_NATIVE_ADMITTED", {
              seeds: await fs.readdir(path.dirname(f.seed)),
              manifests: await fs.readdir(path.join(f.home, ".openclaw-worker", "manifests")),
            });
          }
          const factory: Record<string, unknown> = await import(pathToFileURL(factoryModule).href);
          const verifyPreEnrollmentState = factory.verifyPreEnrollmentState;
          if (typeof verifyPreEnrollmentState !== "function") {
            throw new Error("Factory snapshot verifier entrypoint missing");
          }
          const workspace = path.join(f.root, "empty-provider-workspace");
          await fs.mkdir(workspace);
          const runtimeSha = createHash("sha256")
            .update("synthetic native runtime fixture")
            .digest("hex");
          const input = {
            schema: "openclaw.snapshot-verifier-input.v1",
            preparedProject: result,
            currentRuntime: {
              nodeBootstrap: {
                sha256: runtimeSha,
                bytes: 1,
                openclawVersion: "2026.10.4",
                buildId: "synthetic-cache-fixture",
                manifestSha256: runtimeSha,
                enabledPluginIds: [],
              },
              workerBundle: {
                sha256: runtimeSha,
                bytes: 1,
                bundleHash: runtimeSha,
                packageRelativePath: `worker-artifacts/${runtimeSha}.tgz`,
                protocolFeatures: [],
              },
            },
          };
          const verify = () =>
            verifyPreEnrollmentState({
              home: f.home,
              workspace,
              env: {},
              snapshotInput: input,
            });
          expect(verify()).toMatchObject({ workerStateLimitedToPreparedCaches: true });
          if (change === "complete") {
            await fs.mkdir(path.join(f.home, ".azure"));
            expect(verify).toThrow("credential, pairing or session state");
          }
          console.log(
            "FACTORY_CACHE_ADMISSION_PAIRED_PASS",
            createHash("sha256")
              .update(await fs.readFile(factoryModule))
              .digest("hex"),
          );
        }
      } else {
        await expect(inspect).rejects.toThrow();
        if (change.startsWith("retained-")) {
          // A rejected snapshot must preserve the admitted seed and any retained artifacts.
          expect(await fs.readdir(path.dirname(currentSeed))).toEqual(seedsBeforeInspection);
        }
      }
    } finally {
      f.owner.close();
    }
  });

  it("rejects a toolchain changed by repository hooks before publishing completion", async () => {
    await expect(
      fixture('#!/bin/sh\nprintf "# changed by setup\\n" >> "$HOME/.local/bin/node"\n'),
    ).rejects.toThrow("not completely verified");
  });

  it.each(["legacy", "unknown-version"] as const)(
    "preserves completion compatibility: %s",
    async (change) => {
      const f = await fixture();
      const completionDirectory = path.join(
        f.prepared.homeDir,
        ".openclaw-worker",
        "manifests",
        "prepared",
        f.prepared.sourceManifestRef.slice(7),
      );
      const [name] = await fs.readdir(completionDirectory);
      const original = await fs.readFile(path.join(completionDirectory, name!));
      const nodePath = path.join(f.cache, "bin", "node");
      const nodeBefore = await fs.readFile(nodePath);
      await fs.unlink(path.join(completionDirectory, name!));
      if (change === "legacy") {
        const bytes = await fs.readFile(
          path.join(
            f.home,
            ".openclaw-worker",
            "manifests",
            f.prepared.preparedManifestRef.slice(7) + ".json",
          ),
        );
        await fs.writeFile(
          path.join(completionDirectory, f.prepared.preparedManifestRef.slice(7) + ".json"),
          bytes,
        );
        await fs.unlink(path.join(f.cache, ".archive.tgz"));
      } else {
        const value: Record<string, unknown> = JSON.parse(original.toString("utf8"));
        value.schema = "openclaw.prepared-completion.v999";
        const bytes = Buffer.from(JSON.stringify(value));
        await fs.writeFile(
          path.join(
            completionDirectory,
            createHash("sha256").update(bytes).digest("hex") + ".json",
          ),
          bytes,
        );
      }
      const replay = await f.preparedOperation();
      try {
        if (change === "legacy") {
          await expect(
            replay.project.prepare({ ...f, runScript: f.runScript }),
          ).resolves.toMatchObject({ preparedWorkspace: f.prepared });
          await expect(
            replay.project.inspectPreparedWorkspace!({ snapshot: true, runScript: f.runScript }),
          ).rejects.toThrow("no completed preparation admission");
          expect(await fs.readFile(nodePath)).toEqual(nodeBefore);
        } else {
          await expect(replay.project.prepare({ ...f, runScript: f.runScript })).rejects.toThrow(
            "completion version is unsupported",
          );
        }
      } finally {
        replay.close();
        f.owner.close();
      }
    },
  );

  it.each(["current", "unknown", "tampered", "receipt-symlink", "root-symlink"] as const)(
    "checks the current native worker bundle: %s",
    async (change) => {
      const f = await fixture();
      try {
        const stage = path.join(f.root, "bundle-stage");
        await fs.mkdir(stage);
        for (const name of WORKER_BUNDLE_ARTIFACT_PATHS) {
          await fs.writeFile(path.join(stage, name), `// fixture ${name}\n`, { mode: 0o700 });
        }
        const entries = await readWorkerBundleDirectoryManifest({
          root: stage,
          limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
        });
        const bundleHash = hashWorkerBundleManifest(entries);
        const expected = { bundleHash, openclawVersion: "2026.10.4", protocolFeatures: [] };
        await fs.writeFile(path.join(stage, "bootstrap-receipt.json"), JSON.stringify(expected));
        const cache = path.join(
          f.home,
          ".openclaw-worker",
          change === "unknown" ? "a".repeat(64) : bundleHash,
        );
        await fs.rename(stage, cache);
        if (change === "root-symlink") {
          const outside = path.join(f.root, "outside-bundle");
          await fs.rename(cache, outside);
          await fs.symlink(outside, cache);
        }
        if (change === "receipt-symlink") {
          const receipt = path.join(cache, "bootstrap-receipt.json");
          const outside = path.join(f.root, "outside-receipt.json");
          await fs.rename(receipt, outside);
          await fs.symlink(outside, receipt);
        }
        if (change === "tampered") {
          await fs.appendFile(path.join(cache, "worker.mjs"), "// changed\n");
        }
        const result = f.owner.project.inspectPreparedWorkspace!({
          snapshot: true,
          snapshotWorkerBundle: expected,
          runScript: f.runScript,
        });
        if (change === "current") {
          await expect(result).resolves.toMatchObject({
            validatedMachineCaches: { workerBundle: { bundleHash } },
          });
        } else {
          await expect(result).rejects.toThrow();
        }
      } finally {
        f.owner.close();
      }
    },
  );
});
