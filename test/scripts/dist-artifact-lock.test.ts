import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fileLock from "@openclaw/fs-safe/file-lock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireDistArtifactOwnership,
  DistArtifactOwnershipBusyError,
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-lock.mts";
import { parseLinuxProcStat } from "../../scripts/lib/dist-artifact-owner-census.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { waitForDead } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";

vi.mock("@openclaw/fs-safe/file-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/file-lock")>()),
  acquireFileLock: vi.fn(),
}));
const actual = await vi.importActual<typeof import("@openclaw/fs-safe/file-lock")>(
  "@openclaw/fs-safe/file-lock",
);
const acquire = vi.mocked(fileLock.acquireFileLock);
const callback = vi.fn();
let root: string;
let ownerPath: string;
let controller: AbortController;
beforeEach(() => {
  acquire.mockReset().mockImplementation(actual.acquireFileLock);
  callback.mockReset();
  root = fs.realpathSync(fixture.createTempDir("openclaw-lock-cancel-"));
  // Keep checkout discovery from selecting an ancestor of the temporary fixture.
  fs.mkdirSync(path.join(root, ".git"));
  ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  controller = new AbortController();
});
const fixture = createFixtureLifetime();
const lockModule = pathToFileURL(path.resolve("scripts/lib/dist-artifact-lock.mts")).href;
const ownedPids = new Set<number>();
afterEach(async () => {
  vi.restoreAllMocks();
  const signal = AbortSignal.timeout(10_000);
  await Promise.all(
    [...ownedPids].map(async (pid) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited; the wait below still reaps our own children.
      }
      await waitForDead(pid, signal, "reject");
    }),
  );
  ownedPids.clear();
  await fixture.cleanup();
});
const readOwner = () => fs.readFileSync(ownerPath, "utf8");

it("waits for an empty ownership record being published before acquiring", async () => {
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  fs.writeFileSync(ownerPath, "");
  acquire.mockImplementation(async (...args) => {
    try {
      return await actual.acquireFileLock(...args);
    } catch (error) {
      // Finish the creator's release after a real contention attempt observes
      // the empty file exposed between exclusive creation and payload write.
      fs.unlinkSync(ownerPath);
      acquire.mockImplementation(actual.acquireFileLock);
      throw error;
    }
  });
  await withDistArtifactOwnership(root, callback, controller.signal);
  expect(callback).toHaveBeenCalledOnce();
  expect(fs.existsSync(ownerPath)).toBe(false);
});

it("cancels an already contended same-process waiter without disturbing the owner", async () => {
  const enteredOwner = createDeferred();
  const releaseOwner = createDeferred();
  const owner = withDistArtifactOwnership(root, async () => {
    enteredOwner.resolve();
    await releaseOwner.promise;
  });
  await enteredOwner.promise;
  const originalOwner = readOwner();
  const attempted = createDeferred();
  acquire.mockImplementation(async (...args) => {
    try {
      return await actual.acquireFileLock(...args);
    } catch (error) {
      // Observe a real completed contention attempt, not merely waiter startup.
      attempted.resolve();
      throw error;
    }
  });
  const waiter = withDistArtifactOwnership(root, callback, controller.signal).catch(
    (error: unknown) => error,
  );
  try {
    await attempted.promise;
    controller.abort();
    expect(await waiter).toBe(controller.signal.reason);
    expect(callback).not.toHaveBeenCalled();
    expect(readOwner()).toBe(originalOwner);
  } finally {
    controller.abort();
    releaseOwner.resolve();
    await Promise.all([owner, waiter]);
  }
  await withDistArtifactOwnership(root, async () => {});
  expect(fs.existsSync(ownerPath)).toBe(false);
});

it.for([
  { direct: false, fails: true },
  { direct: true, fails: false },
])(
  "joins acquisition-race release before rejecting (direct=$direct, release fails=$fails)",
  async ({ direct, fails }) => {
    const entered = createDeferred();
    const acquired = createDeferred<fileLock.FileLockHandle>();
    const releasing = createDeferred();
    const released = createDeferred();
    const failure = new Error("release failed");
    const release = vi.fn(async () => {
      releasing.resolve();
      await released.promise;
      if (fails) {
        throw failure;
      }
    });
    acquire.mockImplementation(async () => {
      entered.resolve();
      return await acquired.promise;
    });
    let settled = false;
    const waiter = (
      direct
        ? acquireDistArtifactOwnership(root, true, controller.signal)
        : withDistArtifactOwnership(root, callback, controller.signal)
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    controller.abort();
    acquired.resolve({
      lockPath: resolveDistArtifactLockPath(root),
      normalizedTargetPath: root,
      verifyStillHeld: async () => true,
      release,
      [Symbol.asyncDispose]: release,
    });
    await releasing.promise;
    expect(callback).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    released.resolve();
    expect(await waiter).toBe(fails ? failure : controller.signal.reason);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("preserves an acquisition cleanup failure racing cancellation", async () => {
  const failure = new Error("acquisition cleanup failed");
  acquire.mockImplementation(async () => {
    controller.abort();
    throw failure;
  });
  await expect(withDistArtifactOwnership(root, callback, controller.signal)).rejects.toMatchObject({
    cause: failure,
    message: expect.stringContaining("filesystem error"),
  });
  expect(callback).not.toHaveBeenCalled();
});

it("does not acquire for an already cancelled waiter", async () => {
  const signal = AbortSignal.abort();
  await expect(withDistArtifactOwnership(root, callback, signal)).rejects.toBe(signal.reason);
  expect(acquire).not.toHaveBeenCalled();
});

it("keeps the published two-argument wait inside one native acquisition", async () => {
  const failure = Object.assign(new Error("native timeout"), { code: "file_lock_timeout" });
  acquire.mockRejectedValue(failure);
  await expect(withDistArtifactOwnership(root, callback)).rejects.toMatchObject({
    cause: failure,
  });
  expect(acquire).toHaveBeenCalledOnce();
  expect(acquire.mock.calls[0]?.[1]?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
});

describe("retained records from interrupted owners", () => {
  const nodeProcess = (
    script: string,
    args: string[],
    cwd = root,
    env: NodeJS.ProcessEnv = process.env,
  ) => {
    const child = spawn(resolveTestNodeExecPath(), ["--input-type=module", "-e", script, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    ownedPids.add(child.pid!);
    return child;
  };
  const firstLine = async (child: ChildProcess) => {
    const [data] = (await once(child.stdout!, "data")) as [Buffer];
    return data.toString().trim();
  };
  const exited = (child: ChildProcess) =>
    child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "close");
  const sigkill = async (child: ChildProcess) => {
    const closed = exited(child);
    child.kill("SIGKILL");
    await closed;
  };
  /** A process that takes real ownership, and optionally leaves a detached descendant. */
  const startHolder = async (descendantCwd?: string) => {
    const holder = nodeProcess(
      `import { spawn } from "node:child_process";
      import { acquireDistArtifactOwnership } from ${JSON.stringify(lockModule)};
      await acquireDistArtifactOwnership(${JSON.stringify(root)});
      const descendant = process.argv[1]
        ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            cwd: process.argv[1], detached: true, stdio: "ignore",
          })
        : undefined;
      descendant?.unref();
      console.log(JSON.stringify({ descendant: descendant?.pid }));
      setInterval(() => {}, 1000);`,
      descendantCwd ? [descendantCwd] : [],
    );
    const { descendant } = JSON.parse(await firstLine(holder)) as { descendant?: number };
    if (descendant) {
      ownedPids.add(descendant);
    }
    return { holder, descendant };
  };
  const unrelatedProcess = async () => {
    const child = nodeProcess(`console.log("ready"); setInterval(() => {}, 1000);`, []);
    await firstLine(child);
    return child;
  };
  const deadPid = async () => {
    const child = nodeProcess("", []);
    await exited(child);
    return child.pid!;
  };
  const writeOwner = (content: string) => {
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(ownerPath, content);
  };
  const lockFile = (name: string) => path.join(path.dirname(ownerPath), name);
  const readToken = () => (JSON.parse(readOwner()) as { token: string }).token;
  const expectBusy = async () => {
    const before = readOwner();
    const failure = await acquireDistArtifactOwnership(root, { timeoutMs: 600 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DistArtifactOwnershipBusyError);
    const { message } = failure as Error;
    expect(message).toContain("no manual removal is needed");
    expect(message).not.toMatch(/rm -rf|Remove-Item/u);
    expect(readOwner()).toBe(before);
    return message;
  };
  const expectRecovered = async () => {
    const onRecovered = vi.fn();
    const lock = await acquireDistArtifactOwnership(root, false, undefined, onRecovered);
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(JSON.parse(readOwner())).toMatchObject({ pid: process.pid });
    await lock.release();
    expect(fs.existsSync(ownerPath)).toBe(false);
  };

  it("recovers from a SIGKILLed holder without waiting or operator action", async () => {
    const { holder } = await startHolder();
    await sigkill(holder);
    const startedAt = performance.now();
    await expectRecovered();
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(process.env.OPENCLAW_DIST_ARTIFACT_OWNERS).toBeUndefined();
  });

  it.for([
    {
      name: "the recorded incident shape",
      record: (pid: number) => JSON.stringify({ pid, startedAt: new Date().toISOString() }),
    },
    { name: "an unparseable record", record: () => "{" },
    { name: "an out-of-range PID", record: () => '{"pid":2147483648}' },
    { name: "an abandoned empty record", record: () => "" },
  ])("recovers $name and retires its markers", async ({ record }) => {
    const pid = await deadPid();
    writeOwner(record(pid));
    fs.utimesSync(ownerPath, new Date(0), new Date(0));
    fs.writeFileSync(lockFile("unjoined"), "Unverified child cleanup.\n");
    fs.writeFileSync(lockFile(`child-${pid}`), "Awaiting child completion.\n");
    await withDistArtifactOwnership(root, callback);
    expect(callback).toHaveBeenCalledOnce();
    // A retained marker would make this release keep the lock for the next run.
    expect(fs.readdirSync(path.dirname(ownerPath))).toEqual([]);
  });

  it("does not let an abandoned reclaim guard block recovery", async () => {
    const pid = await deadPid();
    writeOwner(JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    fs.writeFileSync(`${ownerPath}.reclaim`, JSON.stringify({ pid }));
    await expectRecovered();
    expect(fs.existsSync(`${ownerPath}.reclaim`)).toBe(false);
  });

  it("never steals from a live holder and reports bounded progress", async () => {
    const { holder } = await startHolder();
    const progress = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = await expectBusy();
    expect(message).toContain(`retained by PID ${holder.pid}`);
    expect(message).toContain("is still running");
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining("waiting for checkout ownership"),
    );
    expect(holder.exitCode).toBeNull();
    await sigkill(holder);
    await expectRecovered();
  });

  it.for([
    { name: "with a start identity", identity: true },
    { name: "without a start identity", identity: false },
  ])("treats a reused PID as a dead owner $name", async ({ identity }) => {
    const unrelated = await unrelatedProcess();
    const lastHour = new Date(Date.now() - 3_600_000).toISOString();
    writeOwner(
      JSON.stringify({
        pid: unrelated.pid,
        startedAt: lastHour,
        ...(identity ? { startIdentity: lastHour } : {}),
      }),
    );
    await expectRecovered();
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  });

  it("holds ownership for a detached descendant that outlives its owner", async () => {
    const { holder, descendant } = await startHolder(path.dirname(root));
    await sigkill(holder);
    // Its cwd is outside the checkout, so only inherited owner identity can find it.
    expect(await expectBusy()).toContain(`descendant PIDs ${descendant}`);
    process.kill(descendant!, "SIGKILL");
    await waitForDead(descendant!, AbortSignal.timeout(5_000), "reject");
    await expectRecovered();
  });

  it.runIf(process.platform === "darwin")(
    "finds an orphan working in the checkout when the record predates owner tokens",
    async () => {
      const { holder, descendant } = await startHolder(root);
      await sigkill(holder);
      const { pid, startedAt } = JSON.parse(readOwner()) as { pid: number; startedAt: string };
      writeOwner(JSON.stringify({ pid, startedAt }));
      expect(await expectBusy()).toContain(`descendant PIDs ${descendant}`);
      process.kill(descendant!, "SIGKILL");
      await waitForDead(descendant!, AbortSignal.timeout(5_000), "reject");
      await expectRecovered();
    },
  );

  it.for([
    { name: "holds for a member started under the record", recordedAgoMs: 60_000, held: true },
    { name: "ignores a member older than the record", recordedAgoMs: -60_000, held: false },
  ])("checks the recorded process group: $name", async ({ recordedAgoMs, held }) => {
    const leader = spawn(resolveTestNodeExecPath(), ["-e", "setInterval(() => {}, 1000)"], {
      cwd: path.dirname(root),
      detached: true,
      stdio: "ignore",
    });
    ownedPids.add(leader.pid!);
    writeOwner(
      JSON.stringify({
        pid: await deadPid(),
        pgid: leader.pid,
        startedAt: new Date(Date.now() - recordedAgoMs).toISOString(),
      }),
    );
    if (held) {
      expect(await expectBusy()).toContain(`descendant PIDs ${leader.pid}`);
    } else {
      await expectRecovered();
    }
    expect(leader.exitCode).toBeNull();
  });

  it("holds ownership while a child entry claim is live", async () => {
    const claimant = await unrelatedProcess();
    const pid = await deadPid();
    writeOwner(JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    fs.writeFileSync(lockFile(`child-${claimant.pid}`), "Awaiting child completion.\n");
    expect(await expectBusy()).toContain(`child PIDs ${claimant.pid}`);
    await sigkill(claimant);
    await expectRecovered();
    expect(fs.existsSync(lockFile(`child-${claimant.pid}`))).toBe(false);
  });

  it("never mistakes a directory named gateway for a Gateway it may ignore", async () => {
    const { holder, descendant } = await startHolder(path.dirname(root));
    await sigkill(holder);
    const named = path.join(root, "gateway", "compiler.mjs");
    fs.mkdirSync(path.dirname(named));
    fs.writeFileSync(named, "setInterval(() => {}, 1000);");
    const lookalike = spawn(resolveTestNodeExecPath(), [named], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OPENCLAW_DIST_ARTIFACT_OWNERS: readToken() },
    });
    ownedPids.add(lookalike.pid!);
    process.kill(descendant!, "SIGKILL");
    await waitForDead(descendant!, AbortSignal.timeout(5_000), "reject");
    expect(await expectBusy()).toContain(`descendant PIDs ${lookalike.pid}`);
  });

  it("ignores a real Gateway that outlived the build which started it", async () => {
    const { holder, descendant } = await startHolder(path.dirname(root));
    await sigkill(holder);
    // argv[1] is the gateway subcommand; node -e leaves it in the visible command line.
    const gateway = spawn(
      resolveTestNodeExecPath(),
      ["-e", "setInterval(() => {}, 1000)", "gateway", "run"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, OPENCLAW_DIST_ARTIFACT_OWNERS: readToken() },
      },
    );
    ownedPids.add(gateway.pid!);
    process.kill(descendant!, "SIGKILL");
    await waitForDead(descendant!, AbortSignal.timeout(5_000), "reject");
    await expectRecovered();
    expect(gateway.exitCode).toBeNull();
  });

  // Where ps cannot run: Linux never needs it, other platforms warn that they checked less.
  const acquireWithoutPs = (expected: string) =>
    nodeProcess(
      `import { acquireDistArtifactOwnership } from ${JSON.stringify(lockModule)};
      const outcome = await acquireDistArtifactOwnership(${JSON.stringify(root)})
        .then((lock) => lock.release().then(() => "acquired"), (error) => String(error));
      console.log(outcome.startsWith(${JSON.stringify(expected)}) ? "matched" : outcome);`,
      [],
      root,
      { PATH: "/nonexistent" },
    );

  it("recovers a dead owner when ps cannot run", async () => {
    writeOwner(JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
    expect(await firstLine(acquireWithoutPs("acquired"))).toBe("matched");
    expect(fs.existsSync(ownerPath)).toBe(false);
  });

  it("does not steal from a live owner when ps cannot run", async () => {
    const { holder } = await startHolder();
    expect(await firstLine(acquireWithoutPs("DistArtifactOwnershipBusyError"))).toBe("matched");
    expect(holder.exitCode).toBeNull();
    expect(JSON.parse(readOwner())).toMatchObject({ pid: holder.pid });
  });

  it.runIf(process.platform === "linux")(
    "finds a surviving descendant through /proc when ps cannot run",
    async () => {
      const { holder } = await startHolder(path.dirname(root));
      await sigkill(holder);
      expect(await firstLine(acquireWithoutPs("DistArtifactOwnershipBusyError"))).toBe("matched");
    },
  );

  it("parses Linux process facts around a hostile command name", () => {
    const stat = "4242 (node (a) b) S 1 77 77 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 500 0 0 0";
    expect(parseLinuxProcStat(4242, stat, 1_000_000)).toEqual({
      pid: 4242,
      ppid: 1,
      pgid: 77,
      state: "S",
      startMs: 1_005_000,
    });
  });

  it("admits one owner at a time when several processes recover the same record", async () => {
    const { holder } = await startHolder();
    await sigkill(holder);
    const log = path.join(root, "owners.log");
    const contender = () =>
      nodeProcess(
        `import fs from "node:fs";
        import { withDistArtifactOwnership } from ${JSON.stringify(lockModule)};
        await withDistArtifactOwnership(${JSON.stringify(root)}, async () => {
          fs.appendFileSync(${JSON.stringify(log)}, "enter\\n");
          await new Promise((resolve) => setTimeout(resolve, 100));
          fs.appendFileSync(${JSON.stringify(log)}, "exit\\n");
        });`,
        [],
      );
    const contenders = [contender(), contender(), contender()];
    await Promise.all(contenders.map(exited));
    expect(contenders.map((child) => child.exitCode)).toEqual([0, 0, 0]);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "enter",
      "exit",
      "enter",
      "exit",
      "enter",
      "exit",
    ]);
    expect(fs.existsSync(ownerPath)).toBe(false);
  });
});
