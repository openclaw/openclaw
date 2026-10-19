import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { waitForDead, waitForFile } from "../../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { BUNDLE_HASH, prepareLocalWorkspaceRsyncReceiver } from "./tunnel.test-support.js";
import { REMOTE_GIT_WORKSPACE_RETRY_RESET_JS } from "./workspace-mutation-remote-script.js";
import {
  createWorkerWorkspaceRsyncReceiverPathFactory,
  WORKER_WORKSPACE_RSYNC_DESTINATION,
  workerWorkspaceRsyncReceiverEntryPath,
} from "./workspace-sync-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RECEIVER_CLEANUP_MS = 10_000;
const receiverNonce = "b".repeat(32);
const resetNonce = "c".repeat(32);

function spawnTransaction(argv: string[], env: NodeJS.ProcessEnv, withReady = false) {
  const child = spawn(process.execPath, argv, {
    env,
    stdio: withReady ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const ready = createDeferred();
  child.stdio[3]?.once("data", () => ready.resolve());
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (chunk: string) => {
      output[stream] += chunk;
    });
  }
  const exited = new Promise<
    { code: number | null; signal: NodeJS.Signals | null } & typeof output
  >((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, ...output }));
  });
  return { child, pid: child.pid, ready: ready.promise, exited };
}

function waitForReady(transaction: ReturnType<typeof spawnTransaction>, signal: AbortSignal) {
  const ready = awaitGateBeforeSettlement(
    transaction.ready,
    transaction.exited,
    "transaction exited before ready",
  );
  return withinTest(ready, signal);
}

async function writeGate(gate: string, value = "release\n", nonblocking = false) {
  const flags = nonblocking ? fsConstants.O_WRONLY | fsConstants.O_NONBLOCK : "w";
  const writer = await fs.open(gate, flags);
  try {
    await writer.write(value);
  } finally {
    await writer.close();
  }
}

async function receiverFixture(rsync: string, preloadSource: string) {
  const root = tempDirs.make("openclaw-workspace-receiver-");
  const bin = path.join(root, "bin");
  await Promise.all([fs.mkdir(path.join(root, "home")), fs.mkdir(bin)]);
  const gate = path.join(root, "gate");
  const marker = path.join(root, "marker");
  const contenderMarker = path.join(root, "contender-marker");
  const preload = path.join(root, "preload.cjs");
  expect((await runCommandWithTimeout(["mkfifo", gate], { timeoutMs: 10_000 })).code).toBe(0);
  await Promise.all([
    fs.writeFile(path.join(bin, "rsync"), rsync, { mode: 0o755 }),
    fs.writeFile(preload, preloadSource),
  ]);
  const home = await fs.realpath(path.join(root, "home"));
  const relative = ".openclaw-worker/workspaces/env/session/1";
  const workspace = path.join(home, relative);
  await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspace, "current.txt"), "current\n"),
    fs.writeFile(path.join(workspace, "node_modules/cache"), "keep\n"),
  ]);
  const receiverCommand = createWorkerWorkspaceRsyncReceiverPathFactory({
    receiverEntryPath: workerWorkspaceRsyncReceiverEntryPath(BUNDLE_HASH),
    remoteWorkspaceDir: workspace,
    canonicalHome: home,
    remoteRelative: relative,
  })("workspace-root");
  const [node, entry, mode, context] = receiverCommand.split(" ");
  expect(node).toBe("node");
  await prepareLocalWorkspaceRsyncReceiver(path.join(home, entry!));
  const receiverArgv = (nonce: string) => [
    path.join(home, entry!),
    mode!,
    context!,
    nonce,
    "--server",
    ".",
    WORKER_WORKSPACE_RSYNC_DESTINATION,
  ];
  const resetArgv = (nonce: string) => [
    "-e",
    REMOTE_GIT_WORKSPACE_RETRY_RESET_JS,
    workspace,
    home,
    relative,
    nonce,
  ];
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const workspaceKey = createHash("sha256").update(workspace).digest("hex");
  const lock = path.join(path.dirname(workspace), `.openclaw-accepted-lock-${workspaceKey}`);
  return { workspace, receiverArgv, resetArgv, env, lock, gate, marker, contenderMarker, preload };
}

async function expectFile(workspace: string, file: string, contents: string) {
  await expect(fs.readFile(path.join(workspace, file), "utf8")).resolves.toBe(contents);
}

async function expectResetWorkspace(workspace: string, removed: string) {
  await expect(fs.access(path.join(workspace, removed))).rejects.toThrow();
  await expectFile(workspace, "node_modules/cache", "keep\n");
  expect(
    (await fs.readdir(path.dirname(workspace))).filter((name) =>
      name.startsWith(".openclaw-accepted-"),
    ),
  ).toEqual([]);
}

function parseReceiverOwner(name: string) {
  const match = /^owner\.receiver\.[a-f0-9]{32}\.([1-9][0-9]*)\.([1-9][0-9]*)\.[a-f0-9]{32}$/u.exec(
    name,
  );
  if (!match) {
    throw new Error(`invalid receiver lock owner: ${name}`);
  }
  return { receiverPid: Number(match[1]), controllerPid: Number(match[2]) };
}

it.skipIf(process.platform === "win32")(
  "keeps receiver ownership after its controller dies while a descendant can still mutate",
  async ({ signal }) => {
    const fixture = await receiverFixture(
      '#!/bin/sh\nset -eu\n( : > "$OPENCLAW_TEST_RECEIVER_MARKER"; read -r _ < "$OPENCLAW_TEST_RECEIVER_GATE"; printf "late\\n" > "$OPENCLAW_TEST_RECEIVER_WORKSPACE/late.txt" ) </dev/null >/dev/null 2>&1 &\nexit 0\n',
      String.raw`const fs = require("node:fs");
const kill = process.kill.bind(process);
process.kill = function(pid, signal) {
  if (signal === 0 && pid < 0 && process.argv[4] === process.env.OPENCLAW_TEST_RESET_NONCE) {
    fs.writeFileSync(process.env.OPENCLAW_TEST_CONTENDER_MARKER, "");
  }
  return kill(pid, signal);
};
`,
    );
    const { workspace, receiverArgv, resetArgv, env: baseEnv, lock } = fixture;
    const { gate, marker: receiverMarker, contenderMarker, preload } = fixture;
    const env = {
      ...baseEnv,
      OPENCLAW_TEST_RECEIVER_GATE: gate,
      OPENCLAW_TEST_RECEIVER_MARKER: receiverMarker,
      OPENCLAW_TEST_RECEIVER_WORKSPACE: workspace,
      OPENCLAW_TEST_RESET_NONCE: resetNonce,
      OPENCLAW_TEST_CONTENDER_MARKER: contenderMarker,
    };
    const receiver = spawnTransaction(receiverArgv(receiverNonce), env);
    let receiverGateReady = false;
    let gateReleased = false;
    let reset: ReturnType<typeof runCommandWithTimeout> | undefined;
    try {
      await waitForFile(receiverMarker, signal);
      receiverGateReady = true;
      const [ownerName] = await fs.readdir(lock);
      const { receiverPid, controllerPid } = parseReceiverOwner(ownerName!);
      expect(Number.isSafeInteger(receiverPid)).toBe(true);
      expect(controllerPid).toBe(receiver.pid);
      await waitForDead(receiverPid, signal);
      process.kill(controllerPid, "SIGKILL");
      expect(await withinTest(receiver.exited, signal)).toMatchObject({
        code: null,
        signal: "SIGKILL",
        stderr: "",
      });

      reset = runCommandWithTimeout(
        [process.execPath, "--require", preload, ...resetArgv(resetNonce)],
        { timeoutMs: 10_000, baseEnv: env },
      );
      await waitForFile(contenderMarker, signal);
      await expectFile(workspace, "current.txt", "current\n");

      await writeGate(gate);
      gateReleased = true;
      expect(await reset).toMatchObject({ code: 0, stdout: `reset ${resetNonce}\n`, stderr: "" });
      await expectResetWorkspace(workspace, "late.txt");
    } finally {
      if (!gateReleased && receiverGateReady) {
        await writeGate(gate, "cleanup\n");
      } else if (!gateReleased && receiver.pid !== undefined) {
        process.kill(receiver.pid, "SIGKILL");
      }
      // Cleanup hang guard after release or SIGKILL, not a readiness race.
      await withinTest(receiver.exited, AbortSignal.timeout(RECEIVER_CLEANUP_MS)).catch(
        () => undefined,
      );
      await reset?.catch(() => undefined);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps receiver ownership while its live controller is releasing a dead receiver group",
  async ({ signal }) => {
    const fixture = await receiverFixture(
      "#!/bin/sh\nexit 0\n",
      String.raw`const fs = require("node:fs");
const renameSync = fs.renameSync.bind(fs);
fs.renameSync = function(source, destination) {
  if (
    process.argv[4] === process.env.OPENCLAW_TEST_RECEIVER_NONCE &&
    destination.includes(".released.")
  ) {
    fs.writeFileSync(process.env.OPENCLAW_TEST_RELEASE_MARKER, "");
    fs.writeSync(3, "ready");
    if (fs.readFileSync(process.env.OPENCLAW_TEST_RELEASE_GATE, "utf8").trim() !== "release") {
      throw new Error("invalid receiver controller release gate");
    }
  }
  return renameSync(source, destination);
};
const kill = process.kill.bind(process);
process.kill = function(pid, signal) {
  const result = kill(pid, signal);
  if (
    signal === 0 &&
    process.argv[4] === process.env.OPENCLAW_TEST_RESET_NONCE &&
    pid === Number(process.env.OPENCLAW_TEST_CONTROLLER_PID)
  ) {
    fs.writeSync(3, "ready");
  }
  return result;
};
`,
    );
    const { workspace, receiverArgv, resetArgv, env: baseEnv, lock } = fixture;
    const { gate: releaseGate, marker: releaseMarker, preload } = fixture;
    const env = {
      ...baseEnv,
      OPENCLAW_TEST_RECEIVER_NONCE: receiverNonce,
      OPENCLAW_TEST_RESET_NONCE: resetNonce,
      OPENCLAW_TEST_RELEASE_GATE: releaseGate,
      OPENCLAW_TEST_RELEASE_MARKER: releaseMarker,
    };
    const receiver = spawnTransaction(
      ["--require", preload, ...receiverArgv(receiverNonce)],
      env,
      true,
    );
    let releaseGateOpened = false;
    let reset: ReturnType<typeof spawnTransaction> | undefined;
    try {
      await waitForReady(receiver, signal);
      const [ownerName] = await fs.readdir(lock);
      const owner = parseReceiverOwner(ownerName!);
      expect(owner.controllerPid).toBe(receiver.pid);
      // Release starts only after the controller joins receiver close and drains its group.
      expect(() => process.kill(owner.receiverPid, 0)).toThrow();

      let resetSettled = false;
      reset = spawnTransaction(
        ["--require", preload, ...resetArgv(resetNonce)],
        { ...env, OPENCLAW_TEST_CONTROLLER_PID: String(owner.controllerPid) },
        true,
      );
      const markSettled = () => {
        resetSettled = true;
      };
      void reset.exited.then(markSettled, markSettled);
      await waitForReady(reset, signal);
      expect(resetSettled).toBe(false);
      await expectFile(workspace, "current.txt", "current\n");
      await expect(fs.readdir(lock)).resolves.toEqual([ownerName]);

      await writeGate(releaseGate);
      releaseGateOpened = true;
      expect(await withinTest(receiver.exited, signal)).toMatchObject({
        code: 0,
        signal: null,
        stderr: "",
      });
      expect(await withinTest(reset.exited, signal)).toMatchObject({
        code: 0,
        stdout: `reset ${resetNonce}\n`,
        stderr: "",
      });
      await expectResetWorkspace(workspace, "current.txt");
    } finally {
      if (!releaseGateOpened) {
        try {
          await fs.access(releaseMarker);
          // Cleanup cannot wait for a FIFO reader after an early controller exit.
          await writeGate(releaseGate, "release\n", true);
        } catch {
          receiver.child.kill("SIGKILL");
        }
      }
      if (signal.aborted) {
        receiver.child.kill("SIGKILL");
        reset?.child.kill("SIGKILL");
      }
      await receiver.exited.catch(() => undefined);
      await reset?.exited.catch(() => undefined);
    }
  },
);
