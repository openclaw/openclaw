import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForPidFile } from "../../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  PWD_COMMAND,
  SSH,
  fakeRunner,
  git,
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  rsyncReceiverNonce,
  sshResetNonce,
  startConnectedTunnel,
  success,
  workspaceSetup,
} from "./tunnel.test-support.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-ssh-argv.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  adoptStagedWorkerWorkspaceHistory,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";
import {
  writeWorkspaceFiles as writeFiles,
  expectWorkspaceFiles as expectFiles,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = createTempDirTracker();
const RECEIVER_CLEANUP_MS = 10_000;
const attachmentDirectory = "openclaw-inbound-12345678-1234-4234-8234-123456789abc";
const userDirectories = [
  "openclaw-inbound-project",
  "openclaw-inbound-12345678-1234-4234-8234-123456789ab-",
];
type TunnelHandle = Awaited<ReturnType<typeof startConnectedTunnel>>["handle"];
type SyncRequest = Parameters<TunnelHandle["syncWorkspace"]>[0];
const quiescence = { assertActive: async () => {}, resume: async () => {} };
const handles: TunnelHandle[] = [];
afterEach(() =>
  Promise.all(handles.splice(0).map((handle) => handle.stop())).finally(tempDirs.cleanup),
);

async function startTunnel(...args: Parameters<typeof startConnectedTunnel>) {
  const connected = await startConnectedTunnel(...args);
  handles.push(connected.handle);
  return connected;
}

async function localWorkspace(prefix: string) {
  const root = tempDirs.make(prefix);
  const localPath = path.join(root, "local");
  const remoteHome = path.join(root, "remote-home");
  await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome)]);
  return { root, localPath, remoteHome };
}

function sync(
  handle: TunnelHandle,
  localPath: string,
  session: string,
  generation = 1,
  options: Partial<SyncRequest> = {},
) {
  return handle.syncWorkspace({
    source: { kind: "local", path: localPath },
    sessionId: `session:${session}`,
    generation,
    ...options,
  });
}

function manifestPath(home: string, ref: string) {
  return path.join(home, ".openclaw-worker/manifests", `${ref.slice("sha256:".length)}.json`);
}

function projectFiles(files: Record<string, string | null>) {
  return Object.fromEntries(
    userDirectories.flatMap((directory) =>
      Object.entries(files).map(([name, content]) => [`${directory}/${name}`, content]),
    ),
  );
}

async function initializeGit(root: string, ...staged: string[]) {
  await git(root, "init");
  await git(root, "config", "user.name", "Worker Sync Test");
  await git(root, "config", "user.email", "worker-sync@example.invalid");
  await git(root, "add", ...staged);
  return git(root, "commit", "-m", "base");
}

function workspaceTransfers(fake: ReturnType<typeof fakeRunner>) {
  return fake.runs.filter(
    ({ argv }) => argv[0] === "rsync" && argv.some((arg) => arg.startsWith("--files-from=")),
  );
}

function hasCommand(fake: ReturnType<typeof fakeRunner>, fragment: string) {
  return fake.runs.some(({ argv }) => argv.at(-1)?.includes(fragment));
}

function isSetup(input: unknown) {
  return typeof input === "string" && input.includes("unsafe worker workspace directory");
}

function plainRunner(
  environment: string,
  session: string,
  generation: number,
  run: Parameters<typeof fakeRunner>[0],
) {
  const setup = workspaceSetup("/home/worker", environment, `session:${session}`, generation);
  return fakeRunner(
    (argv, options) =>
      run?.(argv, options) ??
      (argv[0] === "git"
        ? { ...success(), code: 128 }
        : isSetup(options.input)
          ? success(setup.stdout)
          : undefined),
  );
}

describe("worker tunnel manager", () => {
  it.each(["setup", "rsync"] as const)(
    "fences sync after source revocation during %s without retiring the tunnel",
    async (boundary) => {
      const localPath = tempDirs.make("worker-sync-authority-");
      const environmentId = "worker:sync-authority";
      let current = true;
      const fake = plainRunner(environmentId, "one", 1, (argv, options) => {
        if (boundary === "setup" && isSetup(options.input)) {
          current = false;
        }
        if (argv[0] === "rsync") {
          current = false;
          return { ...success(), code: 255 };
        }
        return undefined;
      });
      const { handle } = await startTunnel(fake, environmentId, 1, {
        ssh: { ...SSH, fallbackPorts: [22] },
      });
      await expect(
        sync(handle, localPath, "one", 1, {
          authorize: () => {
            if (!current) {
              throw new Error("initiating source closed");
            }
          },
        }),
      ).rejects.toThrow("initiating source closed");
      expect(fake.runs.filter(({ argv }) => argv[0] === "rsync")).toHaveLength(
        boundary === "setup" ? 0 : 1,
      );
      expect(hasCommand(fake, "worker workspace symlink escapes")).toBe(false);
      await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    },
  );

  it("fails workspace sync before manifest creation when rsync fails", async () => {
    const fake = plainRunner("worker:sync-failure", "two", 2, (argv) =>
      argv[0] === "rsync" ? { ...success("", "transfer denied"), code: 23 } : undefined,
    );
    const { handle } = await startTunnel(fake, "worker:sync-failure", 2, {
      ssh: { ...SSH, fallbackPorts: [22] },
    });

    await expect(
      sync(handle, tempDirs.make("openclaw-worker-sync-failure-"), "two", 2),
    ).rejects.toThrow("Worker workspace sync failed: transfer denied");
    expect(hasCommand(fake, "worker workspace symlink escapes")).toBe(false);
    const rsyncCalls = fake.runs.filter((entry) => entry.argv[0] === "rsync");
    expect(rsyncCalls).toHaveLength(1);
    expect(rsyncArgvPort(rsyncCalls[0]!.argv)).toBe(2202);
    expect(rsyncReceiverNonce(rsyncCalls[0]!.argv)).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("rejects an unrelated setup path before transfer", async () => {
    const unrelated = await fs.realpath(tempDirs.make("openclaw-worker-unrelated-"));
    const attackerWorkspace = workspaceSetup(
      unrelated,
      "worker:malformed-setup",
      "session:malformed",
      1,
    ).remoteWorkspaceDir;
    await fs.mkdir(attackerWorkspace, { recursive: true });
    const sentinel = path.join(attackerWorkspace, "sentinel.txt");
    await fs.writeFile(sentinel, "keep\n");
    const localPath = tempDirs.make("openclaw-worker-malformed-setup-");
    await fs.writeFile(path.join(localPath, "local.txt"), "local\n");
    const fake = fakeRunner((_argv, options) =>
      isSetup(options.input)
        ? success(
            `${JSON.stringify({
              tag: "openclaw-workspace-setup-v1",
              canonicalHome: "/home/worker",
              canonicalWorkspace: attackerWorkspace,
            })}\n`,
          )
        : undefined,
    );
    const { handle } = await startTunnel(fake, "worker:malformed-setup", 1);
    await expect(sync(handle, localPath, "malformed")).rejects.toThrow(
      "Worker workspace setup returned an invalid response",
    );
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    expect(fake.runs.some((entry) => entry.argv[0] === "rsync")).toBe(false);
    expect(hasCommand(fake, "worker workspace mutation no longer matches")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "serializes fallback reset behind the live remote receiver",
    async ({ signal }) => {
      const { root, localPath, remoteHome } = await localWorkspace("worker-convergent-sync-");
      const bin = path.join(root, "bin");
      const receiverGate = path.join(root, "receiver-gate");
      const receiverMarker = path.join(root, "receiver-marker");
      await fs.mkdir(bin);
      const canonicalRemoteHome = await fs.realpath(remoteHome);
      const fifo = await runCommandWithTimeout(["mkfifo", receiverGate], { timeoutMs: 10_000 });
      expect(fifo.code).toBe(0);
      for (const directory of ["", ...userDirectories]) {
        await writeFiles(path.join(localPath, directory), {
          "current.txt": directory ? "user project\n" : "base\n",
          "stale.txt": "remove before fallback\n",
        });
      }
      await initializeGit(localPath, ".");
      const baseCommit = await git(localPath, "rev-parse", "HEAD");
      await fs.writeFile(path.join(localPath, "current.txt"), "current\n");

      const fakeRsync = path.join(bin, "rsync");
      await fs.writeFile(
        fakeRsync,
        '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$$" > "$OPENCLAW_TEST_RECEIVER_MARKER"\nread -r _ < "$OPENCLAW_TEST_RECEIVER_GATE"\nprintf \'late stale write\\n\' > "$OPENCLAW_TEST_RECEIVER_WORKSPACE/stale-late.txt"\n',
        { mode: 0o755 },
      );

      let primaryTransfer = true;
      let receiverChild: ChildProcess | undefined;
      type ReceiverExit = { code: number | null; signal: NodeJS.Signals | null };
      let receiverExited: Promise<ReceiverExit> | undefined;
      let receiverWorkspace: string | undefined;
      let receiverRelative: string | undefined;
      let receiverGroupPid: number | undefined;
      let receiverStderr = "";
      let resetAcknowledgement: { nonce: string; groupAlive: boolean } | undefined;
      const fake = localWorkspaceRunner(
        remoteHome,
        async (argv, localArgv, options, receiverTarget) => {
          const isWorkspaceTransfer = argv.some((arg) => arg.startsWith("--files-from="));
          if (!primaryTransfer || !isWorkspaceTransfer || rsyncArgvPort(argv) !== 2222) {
            return undefined;
          }
          primaryTransfer = false;
          if (!receiverTarget) {
            throw new Error("missing test rsync destination");
          }
          receiverWorkspace = receiverTarget.replace(/\/$/u, "");
          await writeFiles(receiverWorkspace, {
            "node_modules/worker-cache": "preserve\n",
            [`${attachmentDirectory}/worker-cache`]: "preserve\n",
          });
          const transferred = await runCommandWithTimeout(localArgv, options);
          if (transferred.termination !== "exit" || transferred.code !== 0) {
            throw new Error(transferred.stderr || "test rsync transfer failed");
          }
          for (const directory of ["", ...userDirectories]) {
            await fs.rm(path.join(localPath, directory, "stale.txt"));
          }
          receiverRelative = path
            .relative(canonicalRemoteHome, receiverWorkspace)
            .split(path.sep)
            .join("/");
          receiverChild = spawn(localArgv[0]!, localArgv.slice(1), {
            env: {
              ...process.env,
              HOME: canonicalRemoteHome,
              OPENCLAW_TEST_RECEIVER_PATH: `${bin}:${process.env.PATH ?? ""}`,
              OPENCLAW_TEST_RECEIVER_GATE: receiverGate,
              OPENCLAW_TEST_RECEIVER_MARKER: receiverMarker,
              OPENCLAW_TEST_RECEIVER_WORKSPACE: receiverTarget,
            },
            stdio: ["ignore", "ignore", "pipe"],
          });
          receiverChild.stderr?.setEncoding("utf8");
          receiverChild.stderr?.on("data", (chunk: string) => {
            receiverStderr += chunk;
          });
          const closed = createDeferred<ReceiverExit>();
          // Capture close at spawn so teardown can still join it after the test aborts.
          receiverChild.once("close", (code, exitSignal) =>
            closed.resolve({ code, signal: exitSignal }),
          );
          receiverExited = closed.promise;
          receiverGroupPid = await Promise.race([
            waitForPidFile(receiverMarker, signal),
            receiverExited.then(() => {
              throw new Error(receiverStderr || "test receiver exited before its marker");
            }),
          ]);
          return { ...transferred, code: 255, stderr: "primary transport disconnected" };
        },
        (argv, result) => {
          const acknowledged = /^reset ([a-f0-9]{32})\n$/u.exec(result.stdout)?.[1];
          if (acknowledged) {
            if (receiverGroupPid === undefined) {
              throw new Error("test receiver process group was not captured");
            }
            resetAcknowledgement = {
              nonce: acknowledged,
              groupAlive: isChildProcessTreeAlive({ pid: receiverGroupPid }),
            };
          }
        },
      );
      const resetDispatched = createDeferred<string>();
      const run = fake.runner.run.bind(fake.runner);
      fake.runner.run = (argv, options) => {
        const operation = run(argv, options);
        const nonce =
          receiverWorkspace !== undefined &&
          receiverRelative !== undefined &&
          argv[0] === "ssh" &&
          sshArgvPort(argv) === 22 &&
          sshResetNonce(argv, {
            workspace: receiverWorkspace,
            canonicalHome: canonicalRemoteHome,
            remoteRelative: receiverRelative,
          });
        if (nonce) {
          resetDispatched.resolve(nonce);
        }
        return operation;
      };
      const { handle } = await startConnectedTunnel(fake, "worker:convergent-sync", 1, {
        ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
      });

      try {
        const syncing = sync(handle, localPath, "convergent-sync", 1, {
          gitAuthor: { name: "Configured Author", email: "configured@example.invalid" },
        });
        let syncSettled = false;
        const markSettled = () => {
          syncSettled = true;
        };
        void syncing.then(markSettled, markSettled);
        const resetNonce = await withinTest(
          awaitGateBeforeSettlement(
            resetDispatched.promise,
            syncing,
            "workspace sync settled before fallback reset",
          ),
          signal,
        );
        const primaryTransfers = workspaceTransfers(fake);
        expect(primaryTransfers.map((entry) => rsyncArgvPort(entry.argv))).toEqual([2222]);
        expect(syncSettled).toBe(false);
        expect(isChildProcessTreeAlive({ pid: receiverGroupPid! })).toBe(true);
        expect(resetAcknowledgement).toBeUndefined();
        await expectFiles(receiverWorkspace!, {
          "stale.txt": "remove before fallback\n",
          "current.txt": "current\n",
        });
        const manifestDirectory = path.join(remoteHome, ".openclaw-worker/manifests");
        const publishedManifests = await fs.readdir(manifestDirectory).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        });
        expect(publishedManifests).toEqual([]);

        await fs.writeFile(receiverGate, "release\n");
        if (!receiverExited) {
          throw new Error("workspace receiver did not start");
        }
        const receiverExit = await withinTest(receiverExited, signal);
        expect(receiverExit.signal).toBeNull();
        expect(receiverExit.code).not.toBe(0);
        const result = await syncing;
        const remote = result.remoteWorkspaceDir;
        expect(resetAcknowledgement).toEqual({
          nonce: resetNonce,
          groupAlive: false,
        });
        expect(result.mode).toBe("git");
        expect(
          await Promise.all(
            ["name", "email"].map((key) =>
              git(remote, "config", "--local", "--get", `user.${key}`),
            ),
          ),
        ).toEqual(["Configured Author", "configured@example.invalid"]);
        await expectFiles(remote, {
          "current.txt": "current\n",
          "stale.txt": null,
          "node_modules/worker-cache": "preserve\n",
          [`${attachmentDirectory}/worker-cache`]: "preserve\n",
          ...projectFiles({ "current.txt": "user project\n", "stale.txt": null }),
        });

        const rawManifest = await fs.readFile(manifestPath(remoteHome, result.manifestRef), "utf8");
        const manifest = parseWorkerWorkspaceManifest(rawManifest, result.manifestRef);
        expect(manifest.entries.map((entry) => entry.path)).toEqual([
          "current.txt",
          ...userDirectories.map((directory) => `${directory}/current.txt`).toSorted(),
        ]);
        expect(await git(remote, "rev-parse", "HEAD")).toBe(baseCommit);
        await expectFiles(remote, { "stale-late.txt": null });

        const transfers = workspaceTransfers(fake);
        expect(transfers.map((entry) => rsyncArgvPort(entry.argv))).toEqual([2222, 22]);
        const residue = (await fs.readdir(path.dirname(remote))).filter((name) =>
          name.startsWith(".openclaw-accepted-"),
        );
        expect(residue).toEqual([]);
      } finally {
        if (receiverChild && receiverChild.exitCode === null && receiverChild.signalCode === null) {
          if (
            await fs.access(receiverMarker).then(
              () => true,
              () => false,
            )
          ) {
            await fs.writeFile(receiverGate, "cleanup\n");
          } else {
            receiverChild.kill("SIGTERM");
          }
          if (receiverExited) {
            // Cleanup hang guard after release or SIGTERM, not a readiness race.
            await withinTest(receiverExited, AbortSignal.timeout(RECEIVER_CLEANUP_MS));
          }
        }
        await handle.stop();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when the managed workspace owner drifts before fallback reset",
    async () => {
      const { root, localPath, remoteHome } = await localWorkspace("worker-retry-owner-");
      const unrelated = path.join(root, "unrelated");
      await writeFiles(localPath, { "current.txt": "current\n" });
      await writeFiles(unrelated, { "sentinel.txt": "keep\n" });
      await initializeGit(localPath, ".");

      let primaryTransfer = true;
      const fake = localWorkspaceRunner(
        remoteHome,
        async (argv, localArgv, options, receiverTarget) => {
          if (
            !primaryTransfer ||
            !argv.some((arg) => arg.startsWith("--files-from=")) ||
            rsyncArgvPort(argv) !== 2222
          ) {
            return undefined;
          }
          primaryTransfer = false;
          const workspace = receiverTarget?.replace(/\/$/u, "");
          if (!workspace) {
            throw new Error("missing test rsync destination");
          }
          const transferred = await runCommandWithTimeout(localArgv, options);
          if (transferred.termination !== "exit" || transferred.code !== 0) {
            throw new Error(transferred.stderr || "test rsync transfer failed");
          }
          await fs.rm(workspace, { recursive: true });
          await fs.symlink(unrelated, workspace, "dir");
          return { ...transferred, code: 255, stderr: "primary transport disconnected" };
        },
      );
      const { handle } = await startTunnel(fake, "worker:retry-owner", 1, {
        ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
      });

      await expect(sync(handle, localPath, "retry-owner")).rejects.toThrow("attested owner");
      await expectFiles(unrelated, { "sentinel.txt": "keep\n" });
      const transfers = workspaceTransfers(fake);
      expect(transfers.map((entry) => rsyncArgvPort(entry.argv))).toEqual([2222]);
      const resets = fake.runs.filter((entry) =>
        entry.argv.at(-1)?.includes("worker workspace mutation no longer matches"),
      );
      expect(resets).toHaveLength(1);
      expect(sshArgvPort(resets[0]!.argv)).toBe(22);
      expect(hasCommand(fake, "worker workspace symlink escapes")).toBe(false);
    },
  );

  it.each([
    { probe: "HEAD", failedArg: "--verify", message: "HEAD probe timed out" },
    { probe: "repository-root", failedArg: "--show-toplevel", message: "root probe timed out" },
  ])(
    "does not downgrade an operational $probe probe failure to plain sync",
    async ({ failedArg, message }) => {
      const localPath = tempDirs.make("openclaw-worker-probe-");
      await fs.mkdir(path.join(localPath, ".git"));
      const fake = plainRunner("worker:probe-failure", "probe", 1, (argv) => {
        if (argv.includes(failedArg)) {
          return { ...success("", message), code: null, killed: true, termination: "timeout" };
        }
        if (argv.includes("--show-toplevel")) {
          return success(`${localPath}\n`);
        }
        if (argv.includes("--verify")) {
          return success("0123456789abcdef0123456789abcdef01234567\n");
        }
        return undefined;
      });
      const { handle } = await startTunnel(fake, "worker:probe-failure", 1);

      await expect(sync(handle, localPath, "probe")).rejects.toThrow(
        `Worker workspace sync failed: ${message}`,
      );
      expect(fake.runs.some((entry) => entry.argv[0] === "rsync")).toBe(false);
    },
  );

  it("mirrors plain workspaces without private metadata or derived caches", async () => {
    const root = tempDirs.make("openclaw-worker-sync-modes-");
    const plainPath = path.join(root, "plain");
    const remoteHome = path.join(root, "remote-home");
    await fs.mkdir(remoteHome);
    await writeFiles(plainPath, {
      "hello.txt": "plain\n",
      "nested/.git/config": "private metadata\n",
      "__pycache__/fizzbuzz.pyc": "derived\n",
      ".mypy_cache": "derived name file\n",
      [`${attachmentDirectory}/report.pdf`]: "inbound original\n",
    });
    // Result staging stores refs in an unborn repository for a plain workspace.
    // A later dispatch must keep using plain-mode sync until the user creates HEAD.
    await git(plainPath, "init");
    for (const directory of userDirectories) {
      await writeFiles(path.join(plainPath, directory), { "report.txt": "user project\n" });
    }

    const fake = localWorkspaceRunner(remoteHome);
    const { handle } = await startTunnel(fake, "worker:real-sync-modes", 12);

    const plain = await sync(handle, plainPath, "plain-sync");
    expect(plain.mode).toBe("plain");
    const remote = plain.remoteWorkspaceDir;
    await expectFiles(remote, {
      "hello.txt": "plain\n",
      "nested/.git/config": null,
      "__pycache__/fizzbuzz.pyc": null,
      ".mypy_cache": null,
      [attachmentDirectory]: null,
      ...projectFiles({ "report.txt": "user project\n" }),
    });
  }, 60_000);
});

it("reclaims unchanged Git history and fences incoming workspace reconciliation", async () => {
  const { localPath, remoteHome } = await localWorkspace("openclaw-worker-git-reclaim-");
  await writeFiles(localPath, {
    "tracked.txt": "base\n",
    ".gitignore": "media/inbound/openclaw-staged-*/\n",
  });
  await initializeGit(localPath, ".");
  const baseCommit = await git(localPath, "rev-parse", "HEAD");
  const ownership = await createStagedInputOwnershipFixture(localPath);
  const localStatus = await git(localPath, "status", "--porcelain");
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
  const { handle } = await startTunnel(fake, "worker:git-reclaim", 1);
  const dispatched = await sync(handle, localPath, "git-reclaim");
  const remote = dispatched.remoteWorkspaceDir;
  for (const relative of ownership.unownedFiles) {
    await expect(fs.stat(path.join(remote, relative))).rejects.toMatchObject({ code: "ENOENT" });
  }
  for (const relative of ownership.ownedFiles) {
    await expect(fs.readFile(path.join(remote, relative))).resolves.toEqual(
      await fs.readFile(path.join(localPath, relative)),
    );
  }
  await git(remote, "commit", "--allow-empty", "-m", "worker checkpoint");
  const workerCommit = await git(remote, "rev-parse", "HEAD");
  const stagedResultRef = workerWorkspaceResultRef("git-reclaim");
  const reconcile = (id = "git-reclaim", baseManifestRef = dispatched.manifestRef) =>
    handle.reconcileWorkspace({
      source: {
        kind: "local",
        path: localPath,
        journal: memoryWorkspaceJournal(),
        stagedResult: { ref: workerWorkspaceResultRef(id), record: () => {} },
      },
      remoteWorkspaceDir: remote,
      baseManifestRef,
    });
  const reconciled = await reconcile();
  await verifyReconciledWorkspaceFinal(reconciled, quiescence);
  expect(reconciled.changed).toBe(false);
  expect(checkedPartialManifest).toBe(true);
  expect(await git(localPath, "rev-parse", "HEAD")).toBe(baseCommit);
  await expect(
    adoptStagedWorkerWorkspaceHistory({ root: localPath, stagedResultRef }),
  ).resolves.toBeUndefined();
  expect(await git(localPath, "rev-parse", "HEAD")).toBe(workerCommit);
  expect(await git(localPath, "status", "--porcelain")).toBe(localStatus);
  await fs.writeFile(path.join(remote, "tracked.txt"), "worker result\n");
  const changed = await reconcile("git-changed", reconciled.manifestRef);
  await verifyReconciledWorkspaceFinal(changed, quiescence);
  expect(changed.changed).toBe(true);
  await expectFiles(localPath, { "tracked.txt": "worker result\n" });
  await changed.verifyStable();
  await changed.verifyLocalStable();
  await git(remote, "commit", "--allow-empty", "-m", "late worker commit");
  await expect(changed.verifyStable()).rejects.toThrow(
    "Cloud workspace Git HEAD changed during final reconciliation",
  );
  await git(remote, "update-ref", "HEAD", workerCommit);
  await fs.writeFile(path.join(remote, "tracked.txt"), "late write\n");
  await expect(changed.verifyStable()).rejects.toThrow(
    "Cloud workspace changed during final reconciliation",
  );
  await fs.writeFile(path.join(localPath, "tracked.txt"), "local late write\n");
  await expect(changed.verifyLocalStable()).rejects.toThrow(
    "Gateway workspace changed after cloud reconciliation",
  );
  const manifestFile = manifestPath(remoteHome, dispatched.manifestRef);
  await fs.rm(manifestFile);
  await writeFiles(manifestFile, { "child.txt": "" });
  // Neither GNU rsync skipping the directory nor OpenRsync copying it admits a manifest.
  await expect(reconcile("git-invalid")).rejects.toThrow(
    new RegExp(
      `^(?:File not found: .*${dispatched.manifestRef.slice("sha256:".length)}\\.json|path must be a regular file)$`,
    ),
  );
}, 60_000);
