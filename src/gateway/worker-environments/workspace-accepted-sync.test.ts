import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { waitForDead, waitForFile } from "../../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerWorkspaceCommand,
} from "./tunnel-contract.js";
import { BUNDLE_HASH, prepareLocalWorkspaceRsyncBoundary, success } from "./tunnel.test-support.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import {
  createAcceptedWorkspacePublisher,
  recoverAcceptedWorkspacePublication,
} from "./workspace-accepted-sync.js";
import { workspaceManifest } from "./workspace-manifest-fixtures.test-support.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { workerWorkspaceRsyncReceiverEntryPath } from "./workspace-sync-helpers.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";

const lifetime = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await lifetime.cleanup();
    cleanup();
  }),
);
function createGateRelease(gate: FileHandle, newline = false) {
  let releasing: Promise<void> | undefined;
  return (message = "release") =>
    (releasing ??= gate.write(message + (newline ? "\n" : "")).then(() => gate.close()));
}
const RECEIVER_ENTRY_PATH = workerWorkspaceRsyncReceiverEntryPath(BUNDLE_HASH);
const RECEIVER_CLEANUP_MS = { release: 10_000, termination: 1_000 };

function observeChild(
  child: ReturnType<typeof spawn>,
  onReady?: () => void,
  testSignal?: AbortSignal,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  if (!child.stderr) {
    throw new Error("fixture child has no stderr pipe");
  }
  let stderr = "";
  const lines = createInterface({ input: child.stderr });
  lines.on("line", (line) => {
    if (onReady && line === "openclaw-test:apply-ready") {
      onReady();
    } else {
      stderr += `${line}\n`;
    }
  });
  return new Promise((resolve, reject) => {
    // An assertion can enter finally before timeout; retain cancellation until close.
    const onAbort = () => child.kill("SIGTERM");
    child.once("error", reject);
    child.once("close", (code, signal) => {
      testSignal?.removeEventListener("abort", onAbort);
      lines.close();
      resolve({ code, signal, stderr });
    });
    testSignal?.addEventListener("abort", onAbort, { once: true });
    if (testSignal?.aborted) {
      onAbort();
    }
  });
}

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return { ...success(), ...overrides };
}

function commandFailure(operation: string, code = 255) {
  return result({ code, stderr: `${operation} ${code === 255 ? "transport lost" : "rejected"}` });
}

const manifest = (content: string) => workspaceManifest({ "result.txt": content });

function manifestRef(value: WorkerWorkspaceManifest): string {
  return `sha256:${createHash("sha256").update(serializeWorkerWorkspaceManifest(value)).digest("hex")}`;
}

function settlement(outcome: "begun" | "rolled-back" | "applied" | "committed"): SpawnResult {
  return result({ stdout: `${JSON.stringify({ version: 1, outcome })}\n` });
}

const remote = manifest("worker\n");
const accepted = manifest("local\n");
const acceptedRef = manifestRef(accepted);
const acceptedPublication = {
  manifestRef: acceptedRef,
  manifest: accepted,
  conflictPaths: ["result.txt"],
};
type PublisherParams = Omit<
  Parameters<typeof createAcceptedWorkspacePublisher>[0],
  "hashMemo" | "remoteManifest" | "initialRemoteRef"
>;

function remoteManifestResult(command: WorkerWorkspaceCommand) {
  if (command.argv[5] === "publish") {
    return result();
  }
  const output =
    command.argv.at(-1) === "memo-v1"
      ? JSON.stringify({
          version: 1,
          manifestRef: acceptedRef,
          memo: [],
          metrics: {
            contentHashCount: 0,
            memoHitCount: 0,
            memoTruncatedCount: 0,
          },
        })
      : acceptedRef;
  return result({ stdout: `${output}\n` });
}
const resultContents = (directory: string) =>
  fs.readFile(path.join(directory, "result.txt"), "utf8");

function commitCase(
  name: string,
  outcome: "committed" | "applied" | "begun",
  expected: "success" | "pending" | "rollback",
  secondCommit = result(),
) {
  return { name, outcome, expected, secondCommit, retry: outcome === "applied" };
}
type TransactionCall = { action: string; nonce: string } & Partial<
  Pick<WorkerWorkspaceCommand, "transportRetry">
>;
function expectTransactions(
  calls: TransactionCall[],
  actions: string[],
  transportRetry?: WorkerWorkspaceCommand["transportRetry"],
) {
  expect(calls.map(({ action }) => action)).toEqual(actions);
  expect(new Set(calls.map(({ nonce }) => nonce)).size).toBe(1);
  if (transportRetry) {
    expect(calls.every((call) => call.transportRetry === transportRetry)).toBe(true);
  }
}

type TransactionOutcome = SpawnResult | Error;
function mockPublication(
  outcomes: Record<string, TransactionOutcome | TransactionOutcome[]>,
  verifyManifest = false,
) {
  const transactionCalls: Array<{ action: string; nonce: string }> = [];
  const publisher = createPublisher({
    runWorkspaceCommand: async (command) => {
      if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
        return verifyManifest ? remoteManifestResult(command) : result();
      }
      const action = command.argv[3]!;
      transactionCalls.push({ action, nonce: command.argv[5]! });
      if (action === "begin") {
        return result({ stdout: "/remote/staging\n" });
      }
      const configured = outcomes[action];
      const outcome = Array.isArray(configured)
        ? configured.length > 1
          ? configured.shift()
          : configured[0]
        : configured;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome ?? result();
    },
  });
  return {
    actions: () => transactionCalls.map(({ action }) => action),
    transactionCalls,
    publishing: publisher.publishAcceptedManifest(acceptedPublication),
  };
}

function observeSettlement(promise: Promise<unknown>) {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void promise.then(markSettled, markSettled);
  return () => settled;
}

function createPublisher(
  params: Pick<PublisherParams, "runWorkspaceCommand"> & Partial<PublisherParams>,
) {
  return createAcceptedWorkspacePublisher({
    receiverEntryPath: RECEIVER_ENTRY_PATH,
    scpTarget: "test",
    localPath: "/local",
    remoteWorkspaceDir: "/remote",
    runRsync: async () => result(),
    ...params,
    remoteManifest: remote,
    initialRemoteRef: manifestRef(remote),
    hashMemo: new Map(),
  });
}

async function gatedApplyFixture(signal: AbortSignal, deadline = false) {
  const root = tempDirs.make("openclaw-accepted-apply-");
  const local = path.join(root, "local");
  let workspace = path.join(root, "workspace");
  const gate = path.join(root, "gate.fifo");
  const applyStarted = createDeferred();
  const settleStarted = createDeferred();
  const preload = path.join(root, "gate.cjs");
  const settlePreload = path.join(root, "settle-clock.cjs");
  await Promise.all([fs.mkdir(local), fs.mkdir(workspace)]);
  workspace = await fs.realpath(workspace);
  await Promise.all([
    fs.writeFile(path.join(local, "result.txt"), "local\n"),
    fs.writeFile(path.join(workspace, "result.txt"), "worker\n"),
  ]);
  expect((await runCommandWithTimeout(["mkfifo", gate], { timeoutMs: 10_000 })).code).toBe(0);
  const releaseApply = createGateRelease(await fs.open(gate, "r+"));
  await fs.writeFile(
    preload,
    `const fs = require("node:fs");
const path = require("node:path");
const renameSync = fs.renameSync;
let gated = false;
fs.renameSync = function(source, destination) {
  const value = renameSync.apply(this, arguments);
  if (!gated && process.argv[1] === "apply" && source === process.env.OPENCLAW_TEST_GATE_SOURCE && destination.includes(path.sep + "backup" + path.sep)) {
    gated = true;
    // Open before readiness so an immediate release cannot discard the FIFO bytes.
    const gateReader = fs.openSync(process.env.OPENCLAW_TEST_GATE, "r");
    fs.writeSync(2, "openclaw-test:apply-ready\\n");
    fs.readFileSync(gateReader);
    fs.closeSync(gateReader);
  }
  return value;
};
`,
  );
  if (deadline) {
    await fs.writeFile(
      settlePreload,
      `let now = 0;
Date.now = () => now;
Atomics.wait = function(waitArray, index, value, timeout) {
  now += 9 * 60 * 1000 + Number(timeout || 0) + 1;
  return "timed-out";
};
`,
    );
  }
  const env = {
    ...process.env,
    OPENCLAW_TEST_GATE: gate,
    OPENCLAW_TEST_GATE_SOURCE: path.join(workspace, "result.txt"),
  };
  const transactionCalls: TransactionCall[] = [];
  const manifestCalls: Array<WorkerWorkspaceCommand["transportRetry"]> = [];
  let stagingRoot: string | undefined;
  let applyExited: ReturnType<typeof observeChild> | undefined;
  const runWorkspaceCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
    signal.throwIfAborted();
    const transactionAction =
      command.argv[2] === REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS ? command.argv[3] : undefined;
    if (!transactionAction) {
      if (deadline) {
        return result();
      }
      expect(command.argv[2]).toBe(REMOTE_WORKSPACE_MANIFEST_JS);
      manifestCalls.push(command.transportRetry);
      return remoteManifestResult(command);
    }
    transactionCalls.push({
      action: transactionAction,
      nonce: command.argv[5]!,
      transportRetry: command.transportRetry,
    });
    if (transactionAction === "settle") {
      settleStarted.resolve();
    }
    if (transactionAction === "apply") {
      const child = spawn(process.execPath, ["--require", preload, ...command.argv.slice(1)], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(command.input);
      applyExited = observeChild(child, () => applyStarted.resolve(), signal);
      await withinTest(
        awaitGateBeforeSettlement(
          applyStarted.promise,
          applyExited,
          `timeout waiting for ${path.join(root, "apply-started")}`,
        ),
        signal,
      );
      return result({ code: 255, stderr: "connection lost after remote apply started" });
    }
    const commandResult = await runCommandWithTimeout(
      [
        process.execPath,
        ...(deadline && transactionAction === "settle" ? ["--require", settlePreload] : []),
        ...command.argv.slice(1),
      ],
      {
        timeoutMs: 10_000,
        baseEnv: env,
        input: command.input,
      },
    );
    if (transactionAction === "begin" && commandResult.code === 0) {
      stagingRoot = commandResult.stdout.trim();
    }
    return commandResult;
  };
  const runRsync = async (): Promise<SpawnResult> => {
    if (!stagingRoot) {
      throw new Error("accepted transaction did not begin before transfer");
    }
    await fs.copyFile(path.join(local, "result.txt"), path.join(stagingRoot, "result.txt"));
    return result();
  };
  const publisher = createPublisher({
    runWorkspaceCommand,
    runRsync,
    localPath: local,
    remoteWorkspaceDir: workspace,
  });

  return {
    root,
    local,
    workspace,
    settleStarted,
    transactionCalls,
    manifestCalls,
    releaseApply,
    publisher,
    recover: () =>
      recoverAcceptedWorkspacePublication({
        runWorkspaceCommand,
        remoteWorkspaceDir: workspace,
      }),
    async expectApplied() {
      if (!applyExited) {
        throw new Error("remote apply process was not started");
      }
      await expect(withinTest(applyExited, signal)).resolves.toMatchObject({
        code: 0,
        signal: null,
        stderr: "",
      });
    },
    async expectNoTransactionArtifacts() {
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-")),
      ).toEqual([]);
    },
    get applyExited() {
      return applyExited;
    },
  };
}

describe("accepted workspace publication", () => {
  it("applies and rolls back an accepted change set above 25,000 paths", async () => {
    const root = await fs.realpath(tempDirs.make("accepted-large-change-set-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const paths = Array.from(
      { length: 26_000 },
      (_, index) => `file-${String(index).padStart(5, "0")}`,
    );
    await fs.writeFile(path.join(workspace, paths[0]!), "preserve on rollback");
    await fs.writeFile(path.join(workspace, "unrelated"), "keep");
    const nonce = "a".repeat(32);
    const run = async (action: string, input?: string) => {
      const commandResult = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
          action,
          workspace,
          nonce,
        ],
        { input, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
      );
      expect(commandResult.code, commandResult.stderr).toBe(0);
    };
    await run("begin", JSON.stringify(paths));
    await run("apply");
    await expect(fs.stat(path.join(workspace, paths[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await run("rollback");
    expect(await fs.readFile(path.join(workspace, paths[0]!), "utf8")).toBe("preserve on rollback");
    expect(await fs.readFile(path.join(workspace, "unrelated"), "utf8")).toBe("keep");
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "waits for the staging receiver group before promoting its inodes live",
    async ({ signal }) => {
      const root = tempDirs.make("openclaw-accepted-receiver-lock-");
      let home = path.join(root, "home");
      const local = path.join(root, "local");
      const workspaceRelative = ".openclaw-worker/workspaces/env/session/1";
      const bin = path.join(root, "bin");
      const gate = path.join(root, "receiver-gate");
      const receiverMarker = path.join(root, "receiver-marker");
      const applyMarker = path.join(root, "apply-marker");
      await Promise.all([fs.mkdir(home), fs.mkdir(local), fs.mkdir(bin)]);
      home = await fs.realpath(home);
      const workspace = path.join(home, workspaceRelative);
      await fs.mkdir(workspace, { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(local, "result.txt"), "local\n"),
        fs.writeFile(path.join(workspace, "result.txt"), "worker\n"),
      ]);
      expect((await runCommandWithTimeout(["mkfifo", gate], { timeoutMs: 10_000 })).code).toBe(0);
      const releaseReceiver = createGateRelease(await fs.open(gate, "r+"), true);
      await fs.writeFile(
        path.join(bin, "rsync"),
        '#!/bin/sh\nset -eu\nfor destination do :; done\nprintf "staged\\n" > "$destination/result.txt"\n( : > "$OPENCLAW_TEST_RECEIVER_MARKER"; read -r _ < "$OPENCLAW_TEST_RECEIVER_GATE"; printf "local\\n" > "$destination/result.txt" ) </dev/null >/dev/null 2>&1 &\nexit 0\n',
        { mode: 0o755 },
      );

      const actions: string[] = [];
      let receiverChild: ReturnType<typeof spawn> | undefined;
      let receiverExited: ReturnType<typeof observeChild> | undefined;
      const env = {
        ...process.env,
        HOME: home,
        OPENCLAW_TEST_RECEIVER_PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_TEST_RECEIVER_GATE: gate,
        OPENCLAW_TEST_RECEIVER_MARKER: receiverMarker,
      };
      const runWorkspaceCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
        if (command.argv[2] !== REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS) {
          return remoteManifestResult(command);
        }
        const action = command.argv[3]!;
        actions.push(action);
        if (action === "apply") {
          await fs.writeFile(applyMarker, "");
        }
        return await runCommandWithTimeout([process.execPath, ...command.argv.slice(1)], {
          timeoutMs: 10_000,
          baseEnv: env,
          input: command.input,
        });
      };
      const publisher = createPublisher({
        runWorkspaceCommand,
        runRsync: async (argvForSsh) => {
          const boundary = await prepareLocalWorkspaceRsyncBoundary(home, argvForSsh("ssh"));
          receiverChild = spawn(boundary.argv[0]!, boundary.argv.slice(1), {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          });
          // Subscribe at spawn so teardown can join it after the test aborts.
          receiverExited = observeChild(receiverChild);
          await Promise.race([
            waitForFile(receiverMarker, signal),
            receiverExited.then(({ stderr: receiverError }) => {
              throw new Error(receiverError || "accepted staging receiver exited too early");
            }),
          ]);
          return result();
        },
        localPath: local,
        remoteWorkspaceDir: workspace,
      });

      const publishing = publisher.publishAcceptedManifest(acceptedPublication);
      const publishingSettled = observeSettlement(publishing);
      try {
        await waitForFile(applyMarker, signal);
        const workspaceKey = createHash("sha256").update(workspace).digest("hex");
        const lock = path.join(path.dirname(workspace), `.openclaw-accepted-lock-${workspaceKey}`);
        const [ownerName] = await fs.readdir(lock);
        const receiverPid = Number(
          /^owner\.receiver\.[a-f0-9]{32}\.([1-9][0-9]*)\.[1-9][0-9]*\.[a-f0-9]{32}$/u.exec(
            ownerName!,
          )?.[1],
        );
        expect(Number.isSafeInteger(receiverPid)).toBe(true);
        await waitForDead(receiverPid, signal);
        expect(actions).toEqual(["begin", "apply"]);
        expect(publishingSettled()).toBe(false);
        await expect(resultContents(workspace)).resolves.toBe("worker\n");

        await releaseReceiver("release");
        if (!receiverExited) {
          throw new Error("accepted staging receiver did not start");
        }
        const receiverExit = await withinTest(receiverExited, signal);
        expect(receiverExit.signal).toBeNull();
        expect(receiverExit.code).not.toBe(0);
        await expect(publishing).resolves.toBeUndefined();
        expect(actions).toEqual(["begin", "apply", "commit"]);
        await expect(resultContents(workspace)).resolves.toBe("local\n");
      } finally {
        await releaseReceiver("cleanup").catch(() => undefined);
        if (receiverExited) {
          // Cleanup hang guard after release was signalled, not a readiness race.
          await withinTest(receiverExited, AbortSignal.timeout(RECEIVER_CLEANUP_MS.release)).catch(
            () => undefined,
          );
        }
        if (receiverChild?.exitCode === null && receiverChild.signalCode === null) {
          receiverChild.kill("SIGTERM");
          if (receiverExited) {
            // Cleanup hang guard after SIGTERM, not a readiness race.
            await withinTest(
              receiverExited,
              AbortSignal.timeout(RECEIVER_CLEANUP_MS.termination),
            ).catch(() => undefined);
          }
        }
      }
    },
  );

  it.for([false, true])(
    "settles a still-running apply after losing SSH status (lock deadline: %s)",
    (deadline, { signal }) =>
      lifetime.run(async () => {
        const fixture = await gatedApplyFixture(signal, deadline);
        const {
          root,
          local,
          workspace,
          settleStarted,
          transactionCalls,
          manifestCalls,
          releaseApply,
          publisher,
        } = fixture;
        const publishing = publisher.publishAcceptedManifest(acceptedPublication);
        const publishingSettled = observeSettlement(publishing);
        try {
          if (deadline) {
            await expect(withinTest(publishing, signal)).rejects.toBeInstanceOf(
              AcceptedWorkspacePublicationIndeterminateError,
            );
            expectTransactions(transactionCalls, ["begin", "apply", "settle"]);
          } else {
            await withinTest(
              awaitGateBeforeSettlement(
                settleStarted.promise,
                publishing,
                `timeout waiting for ${path.join(root, "apply-started")}`,
              ),
              signal,
            );
            expectTransactions(transactionCalls, ["begin", "apply", "settle"], "never");
            expect(manifestCalls).toEqual(["idempotent"]);
            expect(publishingSettled()).toBe(false);
          }
          await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
          await releaseApply();
          if (!deadline) {
            await expect(withinTest(publishing, signal)).resolves.toBeUndefined();
          }
          await fixture.expectApplied();
          await expect(resultContents(workspace)).resolves.toBe("local\n");
          if (!deadline) {
            expectTransactions(transactionCalls, ["begin", "apply", "settle", "commit"], "never");
            expect(manifestCalls).toEqual(["idempotent", "idempotent"]);
            await expect(resultContents(local)).resolves.toBe("local\n");
          }
          await fixture.recover();
          if (deadline) {
            await expect(resultContents(workspace)).resolves.toBe("worker\n");
          } else {
            expect(transactionCalls.map((entry) => entry.action)).toEqual([
              "begin",
              "apply",
              "settle",
              "commit",
              "recover",
            ]);
            expect(transactionCalls.at(-1)?.transportRetry).toBe("never");
          }
          await fixture.expectNoTransactionArtifacts();
        } finally {
          await releaseApply().catch(() => undefined);
          await fixture.applyExited?.catch(() => undefined);
          await publishing.catch(() => undefined);
        }
      }),
  );

  it("keeps an unobservable apply pending when settlement is unobservable", async () => {
    const { actions, publishing } = mockPublication({
      apply: commandFailure("apply"),
      settle: new WorkerTunnelOwnerDisconnectedError(),
    });
    const thrown = await publishing.catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AcceptedWorkspacePublicationIndeterminateError);
    expect(thrown).toMatchObject({
      message: "Accepted workspace publication is indeterminate and requires recovery",
      operation: "apply",
      cause: expect.objectContaining({
        message: "Worker workspace sync failed: apply transport lost",
      }),
    });
    expect(actions()).toEqual(["begin", "apply", "settle"]);
  });

  it.each([
    {
      name: "an ordinary observed failure",
      apply: commandFailure("apply", 1),
      settle: undefined,
      actions: ["begin", "apply", "rollback"],
    },
    {
      name: "settlement observes the begun phase",
      apply: commandFailure("apply"),
      settle: settlement("begun"),
      actions: ["begin", "apply", "settle", "rollback"],
    },
  ])("uses the safe rollback path after $name", async ({ apply, settle, actions: expected }) => {
    const { actions, publishing } = mockPublication({
      apply,
      settle: settle ?? new Error("unexpected settlement"),
    });
    await expect(publishing).rejects.toThrow(/apply (?:rejected|transport lost)/u);
    expect(actions()).toEqual(expected);
  });

  it("keeps an ambiguous apply pending when settlement output is malformed", async () => {
    const { actions, publishing } = mockPublication({
      apply: commandFailure("apply"),
      settle: result({ stdout: '{"version":1,"outcome":"applied","extra":true}\n' }),
    });
    await expect(publishing).rejects.toBeInstanceOf(AcceptedWorkspacePublicationIndeterminateError);
    expect(actions()).toEqual(["begin", "apply", "settle"]);
  });

  it.each([
    commitCase("committed phase", "committed", "success"),
    commitCase("applied phase; retry succeeds", "applied", "success"),
    commitCase("retry is unobservable", "applied", "pending", commandFailure("retry")),
    commitCase("begun phase", "begun", "rollback"),
    commitCase("retry is rejected", "applied", "rollback", commandFailure("retry", 1)),
  ])(
    "handles an ambiguous commit when $name",
    async ({ outcome, retry, secondCommit, expected }) => {
      const { transactionCalls, publishing } = mockPublication(
        {
          commit: [commandFailure("commit"), secondCommit],
          settle: settlement(outcome),
        },
        true,
      );

      if (expected === "success") {
        await expect(publishing).resolves.toBeUndefined();
      } else if (expected === "pending") {
        await expect(publishing).rejects.toBeInstanceOf(
          AcceptedWorkspacePublicationIndeterminateError,
        );
      } else {
        await expect(publishing).rejects.toThrow(/commit transport lost|retry rejected/u);
      }
      expectTransactions(transactionCalls, [
        "begin",
        "apply",
        "commit",
        "settle",
        ...(retry ? ["commit"] : []),
        ...(expected === "rollback" ? ["rollback"] : []),
      ]);
    },
  );
});
