import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectEnvironmentRecipe,
} from "./project-preparation.js";
import {
  createProjectPreparationFixture,
  runProjectScriptWithGitProbe,
} from "./project-preparation.test-support.js";
import { createProjectSetupScript } from "./project-setup-script.js";
import { prepareWorkerProjectSnapshot, workerProjectSeedKey } from "./workspace-git-base.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readText = (root: string, ...parts: string[]) =>
  fs.readFile(path.join(root, ...parts), "utf8");

function expectSetupProcessStopped(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect([0, 1]).toContain(result.status);
  const state = result.stdout.trim();
  expect(state === "" || state.startsWith("Z")).toBe(true);
}

function fixture(setup?: string, symlink = false) {
  return createProjectPreparationFixture(tempDirs.make("project-preparation-"), setup, symlink);
}

async function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  options?: Parameters<typeof f.preparedOperation>[1],
) {
  const operation = await f.preparedOperation(undefined, options);
  try {
    return await operation.project.prepare(f);
  } finally {
    operation.close();
  }
}

const preparedPath = (home: string, ...parts: string[]) =>
  path.join(home, ".openclaw-worker", "prepared", "gateway", "c".repeat(64), ...parts);
const snapshot = async (localPath: string) =>
  (await prepareWorkerProjectSnapshot({ localPath, namespace: "gateway" }))!;
const manifestFiles = async (home: string) =>
  (await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).filter((file) =>
    file.endsWith(".json"),
  );
const readManifest = async (home: string, ref: string) =>
  parseWorkerWorkspaceManifest(
    await readText(home, ".openclaw-worker", "manifests", `${ref.slice(7)}.json`),
    ref,
  );

describe("project checkout preparation", () => {
  it("bounds retained checkouts and abandoned staging while preserving the current project", async () => {
    const f = await fixture();
    const namespace = path.dirname(f.seed);
    await fs.mkdir(namespace, { recursive: true });
    for (let index = 0; index < 8; index++) {
      const sibling = path.join(namespace, index.toString(16).repeat(64));
      await fs.mkdir(sibling);
      const future = new Date(Date.now() + (index + 1) * 60_000);
      await fs.utimes(sibling, future, future);
    }
    const stale = path.join(namespace, `.tmp-${"a".repeat(64)}-stale`);
    const fresh = path.join(namespace, `.tmp-${"b".repeat(64)}-fresh`);
    await fs.mkdir(stale);
    await fs.mkdir(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(stale, old, old);
    const operation = f.operation();
    await operation.project.prepare(f);
    operation.close();
    const retained = await fs.readdir(namespace);
    expect(retained.filter((name) => /^[a-f0-9]{64}$/u.test(name))).toHaveLength(6);
    expect(retained).toContain(path.basename(f.seed));
    expect(retained).toContain(path.basename(fresh));
    expect(retained).not.toContain(path.basename(stale));
  });

  it.each([
    { relative: ".openclaw-worker", phase: "seed" },
    { relative: ".openclaw-worker/git-seeds", phase: "seed" },
    { relative: ".openclaw-worker", phase: "inspection" },
  ] as const)(
    "rejects a symlinked $relative parent before writing outside the worker cache ($phase)",
    async ({ relative, phase }) => {
      const f = await fixture();
      const outside = path.join(f.home, "outside");
      await fs.mkdir(outside);
      const link = path.join(f.home, relative);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outside, link);
      const bin = path.join(f.home, "bin");
      const download = path.join(f.home, "download-attempted");
      await fs.mkdir(bin);
      // Exercise bootstrap admission even when the test host already has Node and Corepack.
      await fs.writeFile(
        path.join(bin, "node"),
        '#!/bin/sh\nif [ "$1" = -e ]; then exit 1; fi\nexec "$PREPARATION_NODE_PATH" "$@"\n',
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(bin, "curl"),
        '#!/bin/sh\nprintf attempted > "$PREPARATION_DOWNLOAD_MARKER"\nexit 99\n',
        { mode: 0o755 },
      );
      const runScript = async (script: string) => {
        const result = spawnSync("sh", ["-c", script], {
          env: {
            ...process.env,
            HOME: f.home,
            PATH: bin + path.delimiter + process.env.PATH,
            PREPARATION_NODE_PATH: process.execPath,
            PREPARATION_DOWNLOAD_MARKER: download,
          },
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error) {
          throw result.error;
        }
        if (result.status !== 0) {
          // execFileSync includes the whole script in its error, including guard messages.
          throw new Error(result.stderr);
        }
        return result.stdout;
      };
      const operation = phase === "seed" ? f.operation() : await f.preparedOperation();
      const preparation =
        phase === "seed"
          ? operation.project.prepare({ runScript, upload: f.upload })
          : operation.project.inspectPreparedWorkspace!({ runScript });
      try {
        await preparation.catch(() => undefined);
        expect(await fs.readdir(outside)).toEqual([]);
        expect(f.upload).not.toHaveBeenCalled();
        await expect(preparation).rejects.toThrow(
          phase === "seed"
            ? "Project seed directory escaped its owner"
            : "Prepared project directory escaped its owner",
        );
        expect(
          await fs.stat(download).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      } finally {
        operation.close();
      }
    },
  );

  it("rejects modified pack bytes before publishing a reusable checkout", async () => {
    const f = await fixture();
    const operation = f.operation();
    await expect(
      operation.project.prepare({
        runScript: f.runScript,
        upload: async (source, destination) => {
          const bytes = await fs.readFile(source);
          bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
          await fs.writeFile(destination, bytes);
        },
      }),
    ).rejects.toThrow("Project pack digest does not match");
    operation.close();
    expect(await fs.readdir(path.dirname(f.seed))).toEqual([]);
  });

  it.each(["inspection", "staging cleanup"])(
    "revokes retained callbacks when the provision owner changes during %s",
    async (stage) => {
      const f = await fixture();
      let current = true;
      let temporaryRoot: string | undefined;
      const remove = fs.rm.bind(fs);
      const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        await remove(...args);
        if (stage === "staging cleanup" && args[0] === temporaryRoot) {
          current = false;
        }
      });
      const operation = f.operation(() => {
        if (!current) {
          throw new Error("owner replaced");
        }
      });
      try {
        await expect(
          operation.project.prepare({
            runScript: async (script) => {
              const result = await f.runScript(script);
              if (stage === "inspection") {
                current = false;
              }
              return result;
            },
            upload: async (source, destination) => {
              temporaryRoot = path.dirname(source);
              await f.upload(source, destination);
            },
          }),
        ).rejects.toThrow("owner replaced");
        expect(operation.project.signal.aborted).toBe(true);
        expect(f.upload).toHaveBeenCalledTimes(stage === "inspection" ? 0 : 1);
        expect(() => operation.project.prepare(f)).toThrow("owner replaced");
      } finally {
        cleanup.mockRestore();
        operation.close();
      }
    },
  );

  it("runs the committed recipe once at stable workspace and HOME paths before reusing its source manifest", async () => {
    const f = await fixture(
      `#!/bin/sh
set -eu
test -z "\${PREPARATION_UNRELATED_ENV:-}"
test "$TOKEN" = sentinel_fixture
test "$HTTPS_PROXY" = http://127.0.0.1:3131
test "$NODE_EXTRA_CA_CERTS" = /tmp/owned/ca.pem
test "$PWD" = "$OPENCLAW_SOURCE_TREE_PATH"
test "$PWD" = "$OPENCLAW_WORKTREE_PATH"
mkdir build
printf '%s\\n' "$HOME" > build/home
printf '#!/bin/sh\\ncat %s/input.txt\\n' "$PWD" > build/read-source
chmod +x build/read-source
printf 'setup\\n' >> "$HOME/count"
`,
      true,
    );
    const first = await f.preparedOperation();
    // Mutable local script bytes are never admitted into the pristine generation.
    await fs.writeFile(path.join(f.repository, ".openclaw", "worktree-setup.sh"), "exit 99\n");
    const result = await first.project.prepare({
      ...f,
      runScriptWithBudget: (createScript) =>
        f.runScript(
          createScript(30_000, {
            TOKEN: "sentinel_fixture",
            HTTPS_PROXY: "http://127.0.0.1:3131",
            NODE_EXTRA_CA_CERTS: "/tmp/owned/ca.pem",
          }),
        ),
    });
    first.close();
    const prepared = result.preparedWorkspace!;
    expect(first.getPreparedWorkspace()).toEqual(prepared);
    const directory = path.join(f.home, ".openclaw-worker", "prepared", "gateway", "c".repeat(64));
    expect(prepared).toMatchObject({
      preparationKey: "a".repeat(64),
      cacheKey: "c".repeat(64),
      workspaceDir: path.join(directory, "workspace"),
      homeDir: path.join(directory, "home"),
    });
    expect(await readText(prepared.homeDir, "count")).toBe("setup\n");
    expect(await fs.readlink(path.join(prepared.workspaceDir, "linked-input"))).toBe("input.txt");
    expect(await readText(prepared.workspaceDir, "build", "home")).toBe(`${prepared.homeDir}\n`);
    expect(
      execFileSync(path.join(prepared.workspaceDir, "build", "read-source"), { encoding: "utf8" }),
    ).toBe("prepared base\n");
    const manifest = await readManifest(prepared.homeDir, prepared.sourceManifestRef);
    expect(manifest.baseCommit).toBe(f.project.baseCommit);
    expect(manifest.entries.some((entry) => entry.path.startsWith("build/"))).toBe(false);
    const second = await f.preparedOperation();
    f.runScript.mockClear();
    const slowVerification = vi.fn<Parameters<typeof runProjectScriptWithGitProbe>[2]>(
      (args, options) => {
        if (args[2] === "fsck" && (options.timeout ?? Infinity) < 45_000) {
          return {
            pid: 0,
            output: [],
            stdout: "",
            stderr: "",
            status: null,
            signal: "SIGTERM" as const,
            error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
          };
        }
        return undefined;
      },
    );
    f.runScript.mockImplementationOnce((script) =>
      runProjectScriptWithGitProbe(script, f.home, slowVerification),
    );
    expect(result.captureRequired).toBe(true);
    const reused = await second.project.prepare(f);
    expect(reused).toEqual({
      seedKey: result.seedKey,
      preparedWorkspace: result.preparedWorkspace,
      cacheHit: true,
    });
    expect(reused.captureRequired).toBeUndefined();
    second.close();
    expect(f.runScript).toHaveBeenCalledTimes(1);
    expect(slowVerification.mock.calls.some(([args]) => args[2] === "fsck")).toBe(true);
    expect(await readText(prepared.homeDir, "count")).toBe("setup\n");
    expect(f.upload).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(prepared.workspaceDir, "linked-input"), "session edit\n");
    expect(await readText(f.seed, "input.txt")).toBe("prepared base\n");
  });

  it("reports Git failure causes without exposing command output or paths", async () => {
    const f = await fixture();
    await prepare(f);
    for (const [failure, detail] of [
      [
        { status: null, error: Object.assign(new Error("private command"), { code: "ETIMEDOUT" }) },
        "timed out after 600000 ms",
      ],
      [
        { error: Object.assign(new Error("private command"), { code: "ENOBUFS" }) },
        "output exceeded 262144 bytes",
      ],
      [{ error: Object.assign(new Error("private command"), { code: "ENOENT" }) }, "ENOENT"],
      [{ status: 128 }, "exit 128"],
      [{ status: null, signal: "SIGKILL" as const }, "signal SIGKILL"],
    ] as const) {
      const operation = await f.preparedOperation();
      f.runScript.mockImplementationOnce((script) =>
        runProjectScriptWithGitProbe(script, f.home, (args) =>
          args[2] === "fsck"
            ? {
                pid: 0,
                output: [],
                status: 0,
                signal: null,
                stdout: "private output",
                stderr: "private repository path",
                ...failure,
              }
            : undefined,
        ),
      );
      await expect(operation.project.prepare(f)).rejects.toThrow(
        new Error(`Prepared project Git verification failed (git fsck: ${detail})`),
      );
      expect(operation.getPreparedWorkspace()).toBeUndefined();
      operation.close();
    }
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("inspects enrolled completion without repeating setup, transfer, or blessing later edits", async () => {
    const f = await fixture('#!/bin/sh\nprintf "setup\\n" >> "$HOME/count"\n');
    const completed = (await prepare(f)).preparedWorkspace!;
    const replay = await f.preparedOperation();
    f.runScript.mockClear();
    await replay.project.inspectPreparedWorkspace!({ runScript: f.runScript });
    expect(replay.getPreparedWorkspace()).toEqual(completed);
    expect(f.runScript).toHaveBeenCalledTimes(1);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(await readText(completed.homeDir, "count")).toBe("setup\n");
    replay.close();
    await fs.writeFile(path.join(completed.workspaceDir, "input.txt"), "later session edit\n");
    const changed = await f.preparedOperation();
    await expect(
      changed.project.inspectPreparedWorkspace!({ runScript: f.runScript }),
    ).rejects.toThrow("completed workspace changed");
    expect(changed.getPreparedWorkspace()).toBeUndefined();
    expect(await readText(completed.workspaceDir, "input.txt")).toBe("later session edit\n");
    expect(await readText(completed.homeDir, "count")).toBe("setup\n");
    changed.close();
  });

  it("verifies a skipped executable recipe without running it or sharing its build cache", async () => {
    const f = await fixture('#!/bin/sh\nprintf setup > "$HOME/setup-ran"\n');
    const seed = f.operation();
    await seed.project.prepare(f);
    seed.close();
    const input = {
      namespace: "gateway",
      seedKey: workerProjectSeedKey(f.project),
      preparationKey: "a".repeat(64),
      cacheKey: "c".repeat(64),
      baseCommit: f.project.baseCommit,
      setupRecipe: (await readWorkerProjectEnvironmentRecipe(f.project)).identity,
      timeoutMs: 30_000,
    };
    await expect(
      f.runScript(
        createProjectSetupScript({ ...input, runSetupScript: false, setupRecipe: "f".repeat(40) }),
      ),
    ).rejects.toThrow("Prepared project setup recipe differs from its admission");
    const skipped = JSON.parse(
      await f.runScript(createProjectSetupScript({ ...input, runSetupScript: false })),
    ) as { homeDir: string; workspaceDir: string; sourceManifestRef: string };
    expect(skipped.sourceManifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      await fs.stat(path.join(skipped.homeDir, "setup-ran")).catch(() => undefined),
    ).toBeUndefined();
    expect(await requireGit(skipped.workspaceDir, ["rev-parse", "HEAD"])).toBe(
      f.project.baseCommit,
    );
    const built = JSON.parse(
      await f.runScript(
        createProjectSetupScript({
          ...input,
          preparationKey: "b".repeat(64),
          cacheKey: "d".repeat(64),
        }),
      ),
    ) as { homeDir: string; workspaceDir: string };
    expect(built.workspaceDir).not.toBe(skipped.workspaceDir);
    expect(await readText(built.homeDir, "setup-ran")).toBe("setup");
    expect(
      await fs.stat(path.join(skipped.homeDir, "setup-ran")).catch(() => undefined),
    ).toBeUndefined();
  });

  it("updates A to B to A with thin transfers and stable build and HOME paths", async () => {
    const f = await fixture(`#!/bin/sh
set -eu
mkdir -p build
test -e build/original-path || printf '%s' "$PWD" > build/original-path
test -e build/retained || printf initial > build/retained
test -e "$HOME/cached" || printf retained > "$HOME/cached"
if test -f generated; then
  test "$(cat generated)" = 'tracked B'
else
  mkdir -p generated/cache
  printf setup-output > generated/result
  printf disposable > generated/cache/state
fi
cat input.txt >> "$HOME/count"
`);
    await fs.writeFile(path.join(f.repository, ".gitignore"), "build/\ngenerated/cache/\n");
    await fs.writeFile(path.join(f.repository, "bulk.bin"), randomBytes(2 * 1024 * 1024));
    await requireGit(f.repository, ["add", "."]);
    await requireGit(f.repository, ["commit", "--quiet", "-m", "bulk A"]);
    const a = await snapshot(f.repository);
    const preparedA = (await prepare(f, { project: a })).preparedWorkspace!;
    await fs.writeFile(path.join(preparedA.workspaceDir, "build/retained"), "retained-build-A");
    await fs.writeFile(path.join(preparedA.homeDir, "cached"), "retained-home-A");
    await fs.writeFile(path.join(f.repository, "input.txt"), "changed B\n");
    await fs.writeFile(path.join(f.repository, "generated"), "tracked B\n");
    await requireGit(f.repository, ["add", "generated"]);
    await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
    const b = await snapshot(f.repository);
    const retainedChecks: string[] = [];
    f.runScript.mockImplementation((script) =>
      runProjectScriptWithGitProbe(script, f.home, (args) => {
        if (args[1] === preparedA.workspaceDir && args[2] === "fsck") {
          retainedChecks.push(args.at(-1)!);
        }
        return undefined;
      }),
    );
    const preparedB = (await prepare(f, { project: b, key: "b".repeat(64) })).preparedWorkspace!;
    expect(retainedChecks).toEqual([a.baseCommit]);
    expect(preparedB).toMatchObject({
      workspaceDir: preparedA.workspaceDir,
      homeDir: preparedA.homeDir,
      cacheKey: preparedA.cacheKey,
    });
    expect(preparedB.preparationKey).not.toBe(preparedA.preparationKey);
    expect(preparedB.sourceManifestRef).not.toBe(preparedA.sourceManifestRef);
    expect(await requireGit(preparedB.workspaceDir, ["rev-parse", "HEAD"])).toBe(b.baseCommit);
    expect(await readText(preparedB.workspaceDir, "input.txt")).toBe("changed B\n");
    expect(await readText(preparedB.workspaceDir, "generated")).toBe("tracked B\n");
    expect(await readText(preparedB.workspaceDir, "build/retained")).toBe("retained-build-A");
    expect(await readText(preparedB.homeDir, "cached")).toBe("retained-home-A");
    expect(f.uploadBytes).toHaveLength(2);
    expect(f.uploadBytes[0]).toBeGreaterThan(2 * 1024 * 1024);
    expect(f.uploadBytes[1]).toBeLessThan(f.uploadBytes[0]! / 100);
    const coldB = (await prepare(f, { project: b, key: "b".repeat(64), cacheKey: "d".repeat(64) }))
      .preparedWorkspace!;
    expect(coldB.workspaceDir).not.toBe(preparedB.workspaceDir);
    expect(await readText(coldB.workspaceDir, "generated")).toBe("tracked B\n");
    expect(await readText(coldB.homeDir, "count")).toBe("changed B\n");
    expect((await prepare(f, { project: a })).preparedWorkspace).toEqual(preparedA);
    expect(retainedChecks).toEqual([a.baseCommit, b.baseCommit]);
    expect(f.uploadBytes).toHaveLength(2);
    expect(await readText(preparedA.homeDir, "count")).toBe(
      "prepared base\nchanged B\nprepared base\n",
    );
    expect(await readText(preparedA.homeDir, "cached")).toBe("retained-home-A");
    expect(await readText(preparedA.workspaceDir, "build/retained")).toBe("retained-build-A");
    expect(await readText(preparedA.workspaceDir, "build/original-path")).toBe(
      preparedA.workspaceDir,
    );
    expect((await manifestFiles(preparedA.homeDir)).toSorted()).toEqual(
      [preparedA.sourceManifestRef, preparedA.preparedManifestRef]
        .map((ref) => `${ref.slice(7)}.json`)
        .toSorted(),
    );
    await fs.rename(f.repository, `${f.repository}-offline`);
    await fs.rename(
      path.join(f.home, ".openclaw-worker", "git-seeds"),
      path.join(f.home, "seeds-offline"),
    );
    expect(await requireGit(preparedA.workspaceDir, ["remote"])).toBe("");
    await requireGit(preparedA.workspaceDir, [
      "fsck",
      "--full",
      "--strict",
      "--no-reflogs",
      a.baseCommit,
    ]);
    expect(await readText(preparedA.workspaceDir, "input.txt")).toBe("prepared base\n");
  });

  it("refreshes a prepared checkout after the Gateway garbage-collects rewritten history", async () => {
    const f = await fixture(`#!/bin/sh
mkdir -p build
test -e build/cache || printf retained > build/cache
`);
    const prepared = (await prepare(f)).preparedWorkspace!;
    const originalBranch = await requireGit(f.repository, ["symbolic-ref", "--short", "HEAD"]);
    await requireGit(f.repository, ["checkout", "--quiet", "--orphan", "rewritten"]);
    await fs.writeFile(path.join(f.repository, "input.txt"), "rewritten source\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "rewritten root"]);
    await requireGit(f.repository, ["branch", "-D", originalBranch.trim()]);
    await requireGit(f.repository, ["reflog", "expire", "--expire=now", "--all"]);
    await requireGit(f.repository, ["gc", "--prune=now"]);
    expect(
      await requireGit(f.repository, ["cat-file", "--batch-check"], {
        input: `${f.project.baseCommit}\n`,
        env: { GIT_NO_LAZY_FETCH: "1" },
      }),
    ).toBe(`${f.project.baseCommit} missing`);
    const project = await snapshot(f.repository);
    const refreshed = (await prepare(f, { project, key: "b".repeat(64) })).preparedWorkspace!;
    expect(refreshed.workspaceDir).toBe(prepared.workspaceDir);
    expect(await readText(refreshed.workspaceDir, "input.txt")).toBe("rewritten source\n");
    expect(await readText(refreshed.workspaceDir, "build/cache")).toBe("retained");
    expect(await requireGit(refreshed.workspaceDir, ["rev-parse", "HEAD"])).toBe(
      project.baseCommit,
    );
  });

  it("retains separate pristine and completed manifests while refreshing setup-modified sources", async () => {
    const f = await fixture(`#!/bin/sh
set -eu
mkdir -p generated build
if grep -q 'changed B' input.txt; then
  test ! -e generated/only-a
else
  printf generated > generated/only-a
fi
printf 'built\\n' >> input.txt
cat input.txt > generated/result
if test ! -e build/cache; then printf retained > build/cache; fi
cat input.txt >> "$HOME/count"
`);
    const a = (await prepare(f)).preparedWorkspace!;
    expect(a.preparedManifestRef).not.toBe(a.sourceManifestRef);
    const manifestRoot = path.join(a.homeDir, ".openclaw-worker", "manifests");
    const pristine = await readManifest(a.homeDir, a.sourceManifestRef);
    const completed = await readManifest(a.homeDir, a.preparedManifestRef);
    expect(pristine.entries.some((entry) => entry.path === "generated/result")).toBe(false);
    expect(completed.entries.some((entry) => entry.path === "generated/result")).toBe(true);
    expect(await readText(f.seed, "input.txt")).toBe("prepared base\n");
    expect(await readText(a.workspaceDir, "input.txt")).toBe("prepared base\nbuilt\n");
    expect((await prepare(f)).preparedWorkspace).toEqual(a);
    expect(await readText(a.homeDir, "count")).toBe("prepared base\nbuilt\n");
    await fs.writeFile(path.join(f.repository, "input.txt"), "changed B\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
    const projectB = await snapshot(f.repository);
    const b = (await prepare(f, { project: projectB, key: "b".repeat(64) })).preparedWorkspace!;
    expect(b.workspaceDir).toBe(a.workspaceDir);
    expect(b.preparedManifestRef).not.toBe(b.sourceManifestRef);
    expect(await readText(b.workspaceDir, "input.txt")).toBe("changed B\nbuilt\n");
    expect(
      await fs.stat(path.join(b.workspaceDir, "generated/only-a")).catch(() => undefined),
    ).toBeUndefined();
    expect(await readText(b.workspaceDir, "build/cache")).toBe("retained");
    expect(await fs.readdir(path.join(manifestRoot, "prepared"))).toEqual([
      b.sourceManifestRef.slice(7),
    ]);
    const completion = path.join(
      manifestRoot,
      "prepared",
      b.sourceManifestRef.slice(7),
      `${b.preparedManifestRef.slice(7)}.json`,
    );
    expect(await fs.readFile(completion, "utf8")).toBe(
      await fs.readFile(path.join(manifestRoot, `${b.preparedManifestRef.slice(7)}.json`), "utf8"),
    );
    await fs.rm(completion);
    // Matching root B/P artifacts cannot manufacture successful setup completion.
    await expect(prepare(f, { project: projectB, key: "b".repeat(64) })).rejects.toThrow(
      "completion artifact is invalid",
    );
    expect(await readText(b.homeDir, "count")).toBe("prepared base\nbuilt\nchanged B\nbuilt\n");
  });

  it.each(["missing", "corrupt"])(
    "refuses a %s retained object store before transferring B",
    async (damage) => {
      const f = await fixture();
      const prepared = (await prepare(f)).preparedWorkspace!;
      await fs.writeFile(path.join(f.repository, "input.txt"), "changed B\n");
      await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
      const b = await snapshot(f.repository);
      const packs = path.join(prepared.workspaceDir, ".git", "objects", "pack");
      const pack = path.join(
        packs,
        (await fs.readdir(packs)).find((file) => file.endsWith(".pack"))!,
      );
      if (damage === "missing") {
        await fs.rm(pack);
      } else {
        const bytes = await fs.readFile(pack);
        bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
        await fs.chmod(pack, 0o600);
        await fs.writeFile(pack, bytes);
      }
      const second = await f.preparedOperation(undefined, { project: b, key: "b".repeat(64) });
      await expect(second.project.prepare(f)).rejects.toThrow(
        "Prepared project Git verification failed",
      );
      second.close();
      expect(f.upload).toHaveBeenCalledTimes(1);
      expect(second.getPreparedWorkspace()).toBeUndefined();
    },
  );

  it("invalidates completed A before a failed B setup and refuses both retries", async () => {
    const f = await fixture(`#!/bin/sh
printf 'setup\\n' >> "$HOME/count"
! grep -q failure input.txt
`);
    const prepared = (await prepare(f)).preparedWorkspace!;
    await fs.writeFile(path.join(f.repository, "input.txt"), "failure B\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
    const b = await snapshot(f.repository);
    await expect(prepare(f, { project: b, key: "b".repeat(64) })).rejects.toThrow(
      "Prepared project setup failed",
    );
    for (const project of [b, f.project]) {
      await expect(prepare(f, { project })).rejects.toThrow();
    }
    expect(await readText(prepared.homeDir, "count")).toBe("setup\nsetup\n");
    expect(await manifestFiles(prepared.homeDir)).toEqual([]);
  });

  it("settles successful setup descendants before publishing the prepared workspace", async () => {
    const f = await fixture(`#!/bin/sh
sleep 300 &
printf '%s' "$!" > "$HOME/setup-child"
`);
    const operation = await f.preparedOperation();
    const childFile = preparedPath(f.home, "home", "setup-child");
    try {
      expect((await operation.project.prepare(f)).preparedWorkspace).toBeDefined();
      const pid = Number(await fs.readFile(childFile, "utf8"));
      expectSetupProcessStopped(pid);
    } finally {
      operation.close();
      const pid = Number(await fs.readFile(childFile, "utf8").catch(() => ""));
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    }
  });

  it.each(["completion", "workspace", "seed"])(
    "rejects a completed preparation with changed %s without rerunning setup",
    async (changed) => {
      const f = await fixture('#!/bin/sh\nprintf "setup\\n" >> "$HOME/count"\n');
      const prepared = (await prepare(f)).preparedWorkspace!;
      const target =
        changed === "completion"
          ? path.join(
              prepared.homeDir,
              ".openclaw-worker",
              "manifests",
              `${prepared.sourceManifestRef.slice(7)}.json`,
            )
          : path.join(changed === "workspace" ? prepared.workspaceDir : f.seed, "input.txt");
      await fs.writeFile(target, "changed\n");
      const second = await f.preparedOperation();
      await expect(second.project.prepare(f)).rejects.toThrow();
      expect(second.getPreparedWorkspace()).toBeUndefined();
      second.close();
      expect(await readText(prepared.homeDir, "count")).toBe("setup\n");
    },
  );

  it.each([
    ...[0, Number.NaN, Infinity, 2_147_483_648].map((timeoutMs) => ({
      timeoutMs,
      action: "true",
      error: "command budget exhausted",
      started: false,
    })),
    {
      timeoutMs: 1_000,
      action:
        "node -e 'setTimeout(() => {}, 2000)' &\nprintf '%s' \"$!\" > \"$HOME/setup-child\"\nwait",
      error: /timed out|command budget exhausted/u,
      // The command includes verification: exhausted-before-spawn is valid under load.
      started: undefined,
    },
    ...["SIGTERM", "SIGINT"].map((signal) => ({
      timeoutMs: 30_000,
      action: `kill -${signal.slice(3)} "$PPID"\nsleep 2`,
      error: `interrupted by ${signal}`,
      started: true,
    })),
    ...[
      { action: "exit 17", error: "Prepared project setup failed" },
      { action: "printf '#' >> .openclaw/worktree-setup.sh", error: "recipe changed during setup" },
    ].map(({ action, error }) => ({ action, error, timeoutMs: 30_000, started: true })),
  ])(
    "retains incomplete setup with budget $timeoutMs after $error",
    async ({ timeoutMs, action, error, started }) => {
      const f = await fixture(`#!/bin/sh
printf '%s' "$$" > "$HOME/setup-pid"
printf 'setup\\n' >> "$HOME/count"
${action}
`);
      const seed = f.operation();
      await seed.project.prepare(f);
      seed.close();
      const operation = await f.preparedOperation();
      try {
        await expect(
          operation.project.prepare({
            ...f,
            runScriptWithBudget: (createScript) => f.runScript(createScript(timeoutMs)),
          }),
        ).rejects.toThrow(error);
      } finally {
        operation.close();
      }
      const home = preparedPath(f.home, "home");
      const files = await fs.readdir(home);
      const count = files.includes("count") ? await readText(home, "count") : "";
      if (started === undefined) {
        expect(["", "setup\n"]).toContain(count);
      } else {
        expect(count).toBe(started ? "setup\n" : "");
      }
      for (const file of ["setup-pid", "setup-child"]) {
        if (files.includes(file)) {
          expectSetupProcessStopped(Number(await readText(home, file)));
        }
      }
      expect(await manifestFiles(home)).toEqual([]);
      await expect(prepare(f)).rejects.toThrow();
      expect(await readText(home, "count").catch(() => "")).toBe(count);
      expect(await manifestFiles(home)).toEqual([]);
    },
  );

  it("requires administrator authority for a pinned setup and rechecks the owner after seed installation", async () => {
    const f = await fixture('#!/bin/sh\nprintf setup > "$HOME/count"\n');
    const setupRecipe = (await readWorkerProjectEnvironmentRecipe(f.project)).identity;
    expect(setupRecipe).toMatch(/^[a-f0-9]{40}$/u);
    expect(() =>
      createWorkerProjectPreparation({
        project: f.project,
        namespace: "gateway",
        preparation: {
          purpose: "session",
          demandAtMs: 1_000,
          key: "a".repeat(64),
          cacheKey: "c".repeat(64),
          setupRecipe,
        },
        requireCurrent: () => {},
      }),
    ).toThrow("operator.admin");
    const seed = f.operation();
    await seed.project.prepare(f);
    seed.close();
    let current = true;
    const prepared = await f.preparedOperation(() => {
      if (!current) {
        throw new Error("owner replaced");
      }
    });
    await expect(
      prepared.project.prepare({
        upload: f.upload,
        runScriptWithBudget: (createScript) => f.runScriptWithBudget(createScript),
        runScript: async (script) => {
          const output = await f.runScript(script);
          current = false;
          return output;
        },
      }),
    ).rejects.toThrow("owner replaced");
    prepared.close();
    expect(
      await fs.stat(path.join(f.home, ".openclaw-worker", "prepared")).catch(() => undefined),
    ).toBeUndefined();
  });

  it("requires a budgeted transport before transferring a new prepared workspace", async () => {
    const f = await fixture();
    const operation = await f.preparedOperation();
    await expect(
      operation.project.prepare({ runScript: f.runScript, upload: f.upload }),
    ).rejects.toThrow("Prepared workspaces require a provider command budget");
    operation.close();
    expect(f.runScript).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });
});
