import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  git,
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  startConnectedTunnel,
} from "./tunnel.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";
import {
  expectWorkspaceFiles as expectFiles,
  writeWorkspaceFiles as writeFiles,
} from "./workspace-sync-scripts.test-support.js";

async function expectFile(root: string, relative: string, content: string) {
  await expect(fs.readFile(path.join(root, relative), "utf8")).resolves.toBe(content);
}

async function expectAbsent(root: string, ...paths: string[]) {
  for (const relative of paths) {
    await expect(fs.access(path.join(root, relative))).rejects.toThrow();
  }
}

it("materializes a large dirty git workspace as a credential-free commit-capable clone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-git-sync-"));
  const localPath = path.join(root, "local");
  const remoteHome = path.join(root, "remote-home");
  await Promise.all([
    fs.mkdir(path.join(localPath, "generated"), { recursive: true }),
    fs.mkdir(remoteHome, { recursive: true }),
  ]);
  await git(localPath, "init");
  await git(localPath, "config", "user.name", "Worker Sync Test");
  await git(localPath, "config", "user.email", "worker-sync@example.invalid");
  await writeFiles(localPath, {
    ".gitignore": "cache/**\nprivate/**\nmedia/inbound/openclaw-staged-*/\n",
    ".worktreeinclude": "cache/*.txt\n",
    "gone.txt": "delete me\n",
    "rename-old.txt": "rename me\n",
    "modified.txt": "before\n",
    "conflict.txt": "base\n",
  });
  const largeFiles = Array.from(
    { length: 1_800 },
    (_, index) => `generated/long-worker-file-name-${String(index).padStart(4, "0")}.txt`,
  );
  for (let offset = 0; offset < largeFiles.length; offset += 64) {
    await Promise.all(
      largeFiles
        .slice(offset, offset + 64)
        .map((file, index) => fs.writeFile(path.join(localPath, file), `${offset + index}\n`)),
    );
  }
  await git(localPath, "add", ".");
  await git(localPath, "commit", "-m", "base");
  const firstBase = await git(localPath, "rev-parse", "HEAD");
  await fs.mkdir(path.join(localPath, "vendor/sub/.git"), { recursive: true });
  await fs.writeFile(path.join(localPath, "vendor/sub/.git/secret"), "must not transfer\n");
  await git(localPath, "update-index", "--add", "--cacheinfo", `160000,${firstBase},vendor/sub`);
  await git(localPath, "commit", "-m", "record submodule");
  const baseCommit = await git(localPath, "rev-parse", "HEAD");

  await Promise.all([
    fs.rm(path.join(localPath, "gone.txt")),
    fs.rename(path.join(localPath, "rename-old.txt"), path.join(localPath, "rename-new.txt")),
    fs.writeFile(path.join(localPath, "modified.txt"), "after\n"),
    fs.mkdir(path.join(localPath, "cache"), { recursive: true }),
    fs.mkdir(path.join(localPath, "private"), { recursive: true }),
  ]);
  await writeFiles(localPath, {
    "cache/allowed.txt": "allowed\n",
    "private/ignored.txt": "private\n",
    "ordinary-untracked.txt": "before ignore\n",
  });

  const ownership = await createStagedInputOwnershipFixture(localPath);
  const inputDirectory = stagedInputDirectory("b".repeat(64));
  const privateInput = `${inputDirectory}/input-cache.pyc`;
  await ensureStagedInputDirectory(localPath, inputDirectory);
  await fs.writeFile(path.join(localPath, privateInput), "raw input bytes");
  let checkedPartialManifest = false;
  const fake = localWorkspaceRunner(remoteHome, async (argv, localArgv, options) => {
    if (checkedPartialManifest || !argv.at(-2)?.includes(":.openclaw-worker/manifests/")) {
      return undefined;
    }
    checkedPartialManifest = true;
    const destination = localArgv.at(-1)!;
    await fs.writeFile(destination, "partial manifest");
    const partial = await fs.stat(destination);
    const transferred = await runCommandWithTimeout(localArgv, options);
    expect(
      (await fs.stat(destination)).ino,
      "inbound manifest filenames stay stable while the quota scan observes them",
    ).toBe(partial.ino);
    return transferred;
  });
  const { handle } = await startConnectedTunnel(fake, "worker:real-git-sync", 11);

  try {
    const result = await handle.syncWorkspace({
      source: { kind: "local", path: localPath },
      sessionId: "session:real-git-sync",
      generation: 1,
    });
    const remote = result.remoteWorkspaceDir;
    expect(result.mode).toBe("git");
    for (const relative of ownership.unownedFiles) {
      await expect(fs.stat(path.join(remote, relative))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const relative of ownership.ownedFiles) {
      await expect(fs.readFile(path.join(remote, relative))).resolves.toEqual(
        await fs.readFile(path.join(localPath, relative)),
      );
    }
    await createStagedInputOwnershipFixture(remote);
    for (const relative of ownership.unownedFiles) {
      await fs.writeFile(path.join(remote, relative), "worker project bytes\n");
    }
    await expectFiles(remote, {
      [privateInput]: "raw input bytes",
      [largeFiles[0] ?? ""]: "0\n",
      [largeFiles.at(-1) ?? ""]: "1799\n",
      "rename-new.txt": "rename me\n",
      "cache/allowed.txt": "allowed\n",
    });
    await fs.writeFile(path.join(remote, privateInput), "edited input bytes");
    expect(result.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expectAbsent(remote, "gone.txt", "private/ignored.txt", "vendor/sub/.git/secret");
    expect(await git(remote, "rev-parse", "HEAD")).toBe(baseCommit);
    expect(await git(remote, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await git(remote, "remote")).toBe("");
    const status = await runCommandWithTimeout(["git", "-C", remote, "status", "--porcelain"], {
      timeoutMs: 30_000,
    });
    const statusLines = status.stdout.split("\n").filter(Boolean);
    expect(statusLines).toEqual(expect.arrayContaining([" D gone.txt", "?? rename-new.txt"]));
    await git(remote, "add", "-A");
    await git(remote, "commit", "-m", "worker commit");
    await git(remote, "merge-base", "--is-ancestor", baseCommit, "HEAD");
    await fs.mkdir(path.join(remote, "private"));
    await Promise.all([
      writeFiles(remote, {
        "modified.txt": "worker result\n",
        "conflict.txt": "worker result\n",
        "ordinary-untracked.txt": "still present after ignore\n",
        "worker-untracked.txt": "artifact\n",
        "cache/worker-allowed.txt": "allowed\n",
        "private/worker-secret.txt": "private\n",
      }),
      fs.appendFile(path.join(remote, ".gitignore"), "ordinary-untracked.txt\n"),
      fs.rm(path.join(remote, "rename-new.txt")),
      fs.symlink("modified.txt", path.join(remote, "worker-link")),
    ]);
    await fs.writeFile(path.join(localPath, "conflict.txt"), "local result\n");

    let acceptedManifestRef = result.manifestRef;
    const journal = memoryWorkspaceJournal((manifestRef) => {
      acceptedManifestRef = manifestRef;
    });
    const reconcile = (id: string, baseManifestRef = result.manifestRef, owner = journal) =>
      handle.reconcileWorkspace({
        source: {
          kind: "local",
          path: localPath,
          journal: owner,
          stagedResult: { ref: workerWorkspaceResultRef(id), record: () => {} },
        },
        remoteWorkspaceDir: remote,
        baseManifestRef,
      });
    const quiescence = { assertActive: async () => {}, resume: async () => {} };
    const reconciled = await reconcile("git-changed");
    await verifyReconciledWorkspaceFinal(reconciled, quiescence);
    expect(reconciled).toMatchObject({ changed: true });
    expect(checkedPartialManifest).toBe(true);
    for (const relative of ownership.unownedFiles) {
      await expectFile(localPath, relative, `fixture bytes: ${relative}\n`);
    }
    await expectFile(localPath, privateInput, "edited input bytes");
    expect(reconciled.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await reconciled.verifyStable();
    await reconciled.verifyLocalStable();
    await expectFiles(localPath, {
      "modified.txt": "worker result\n",
      "worker-untracked.txt": "artifact\n",
      "ordinary-untracked.txt": "still present after ignore\n",
      "cache/worker-allowed.txt": "allowed\n",
      "conflict.txt": "local result\n",
    });
    await expect(fs.readlink(path.join(localPath, "worker-link"))).resolves.toBe("modified.txt");
    await expectAbsent(localPath, "private/worker-secret.txt", "rename-new.txt");
    await expectFile(remote, "conflict.txt", "local result\n");
    await expectAbsent(remote, "private/ignored.txt");
    expect(await git(localPath, "rev-parse", "HEAD")).toBe(baseCommit);
    const unchanged = await reconcile("git-unchanged", acceptedManifestRef);
    await verifyReconciledWorkspaceFinal(unchanged, quiescence);
    expect(unchanged).toMatchObject({ manifestRef: acceptedManifestRef, changed: false });
    await unchanged.verifyStable();
    await unchanged.verifyLocalStable();
    await fs.writeFile(path.join(remote, "modified.txt"), "late write\n");
    await expect(unchanged.verifyStable()).rejects.toThrow(
      "Cloud workspace changed during final reconciliation",
    );
    await fs.writeFile(path.join(localPath, "modified.txt"), "local late write\n");
    await expect(unchanged.verifyLocalStable()).rejects.toThrow(
      "Gateway workspace changed after cloud reconciliation",
    );

    const manifestPath = path.join(
      remoteHome,
      ".openclaw-worker/manifests",
      `${result.manifestRef.slice("sha256:".length)}.json`,
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      entries: Array<{ path: string }>;
    };
    expect(manifest.entries.some((entry) => entry.path === ".git")).toBe(false);
    expect(manifest.entries.some((entry) => entry.path.startsWith(".git/"))).toBe(false);

    await fs.rm(manifestPath);
    await fs.mkdir(manifestPath);
    await fs.writeFile(path.join(manifestPath, "child.txt"), "");
    // GNU rsync skips the directory; OpenRsync can leave an empty directory.
    // Neither outcome may satisfy regular-file manifest admission.
    await expect(
      reconcile("git-invalid", result.manifestRef, memoryWorkspaceJournal()),
    ).rejects.toThrow(
      new RegExp(
        `^(?:File not found: .*${result.manifestRef.slice("sha256:".length)}\\.json|path must be a regular file)$`,
      ),
    );
  } finally {
    await handle.stop();
    await fs.rm(root, { recursive: true });
  }
}, 60_000);
