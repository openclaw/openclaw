import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createProcessSupervisor } from "./supervisor.js";

const { fallbackAttempts } = vi.hoisted(() => ({ fallbackAttempts: [] as boolean[] }));

vi.mock("../spawn-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../spawn-utils.js")>();
  return {
    ...original,
    spawnWithFallback: (params: Parameters<typeof original.spawnWithFallback>[0]) =>
      original.spawnWithFallback({
        ...params,
        spawnImpl: (command, args, options) => {
          fallbackAttempts.push(options.detached === true);
          if (options.detached) {
            throw Object.assign(new Error("fixture detached spawn failure"), { code: "EBADF" });
          }
          return spawn(command, args, options);
        },
      }),
  };
});

type Identity = { pid: number; starttime: string };
const identities: Identity[] = [];
const identityFiles = new Set<string>();
const tempDirs = createTempDirTracker();
const signalProcess = process.kill.bind(process);
const childExits = new Map<number, Promise<unknown>>();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function readInstance(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    return { pid, state: fields[0], ppid: Number(fields[1]), starttime: fields[19] };
  } catch {
    return undefined;
  }
}

function stillRunning(identity: Identity): boolean {
  const current = readInstance(identity.pid);
  return current?.starttime === identity.starttime && current.state !== "Z";
}

function readIdentity(file: string): Identity | undefined {
  try {
    const identity = JSON.parse(readFileSync(file, "utf8")) as Identity;
    if (
      Number.isSafeInteger(identity.pid) &&
      identity.pid > 0 &&
      /^\d+$/u.test(identity.starttime)
    ) {
      return identity;
    }
  } catch {
    // The fixture has not published its identity yet.
  }
  return undefined;
}

function heartbeatSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function createFixture(cwd: string, workerThread: boolean) {
  const leafPath = path.join(cwd, "leaf.mjs");
  const leafIdentityPath = path.join(cwd, "leaf.json");
  const leafTicksPath = path.join(cwd, "leaf.ticks");
  const rootPath = path.join(cwd, "root.cjs");
  const foreignIdentityPath = path.join(cwd, "foreign.json");
  const foreignTicksPath = path.join(cwd, "foreign.ticks");
  identityFiles.add(leafIdentityPath);
  identityFiles.add(foreignIdentityPath);
  await writeFile(
    leafPath,
    `
      import fs from "node:fs";
      ${fixtureReceiptClientSource(receipts.endpoint)}
      process.on("SIGTERM", () => {});
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);
      fs.writeFileSync(process.argv[2], JSON.stringify({pid: process.pid, starttime: fields[19]}));
      let tick = 0;
      setInterval(() => {
        fs.appendFileSync(process.argv[3], ".");
        sendReceipt(process.argv[3], "tick");
        if (++tick === 1) process.send?.("ready");
      }, 25);
    `,
  );
  const spawnLeaf = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const leaf = spawn(process.execPath, [${JSON.stringify(leafPath)}, ${JSON.stringify(leafIdentityPath)},
        ${JSON.stringify(leafTicksPath)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: false });
      const stat = fs.readFileSync("/proc/" + leaf.pid + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);
      fs.writeFileSync(${JSON.stringify(leafIdentityPath)}, JSON.stringify({pid: leaf.pid, starttime: fields[19]}));
      leaf.once("message", () => {
        leaf.disconnect();
        process.send?.("ready");
      });
      setInterval(() => {}, 1000);
    `;
  await writeFile(
    rootPath,
    `
      process.on("SIGTERM", () => process.exit(0));
      ${
        workerThread
          ? `new (require("node:worker_threads").Worker)(${JSON.stringify(spawnLeaf)}, {eval: true});`
          : spawnLeaf
      }
    `,
  );
  return {
    leafPath,
    leafIdentityPath,
    leafTicksPath,
    rootPath,
    foreignIdentityPath,
    foreignTicksPath,
  };
}

async function waitForFixtureExit(identity: Identity, signal: AbortSignal) {
  // Attached-tree escalation retains identities but exposes no descendant exit join.
  while (stillRunning(identity)) {
    await delay(10, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`Fixture process ${identity.pid} did not exit`, { cause: error });
    });
  }
}

function tickBeforeSettlement(file: string, operation: Promise<unknown>) {
  return Promise.race([
    receipts.waitFor(file, "tick"),
    operation.then(
      () => {
        if (heartbeatSize(file) === 0) {
          throw new Error(`Fixture exited before its first tick: ${file}`);
        }
      },
      (error: unknown) => {
        if (heartbeatSize(file) === 0) {
          throw error;
        }
      },
    ),
  ]);
}

afterEach(async ({ signal }) => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const file of identityFiles) {
    const identity = readIdentity(file);
    if (identity && !identities.some((entry) => entry.pid === identity.pid)) {
      identities.push(identity);
    }
  }
  for (const identity of identities) {
    if (stillRunning(identity)) {
      try {
        signalProcess(identity.pid, "SIGKILL");
      } catch {
        // The exact fixture instance exited after the identity check.
      }
    }
  }
  try {
    await Promise.all(
      identities.map(
        (identity) => childExits.get(identity.pid) ?? waitForFixtureExit(identity, signal),
      ),
    );
  } finally {
    childExits.clear();
    identities.length = 0;
    identityFiles.clear();
    fallbackAttempts.length = 0;
    tempDirs.cleanup();
  }
});

describe.skipIf(process.platform !== "linux")("Linux no-detach cancellation", () => {
  it.for([false, true])(
    "kills a TERM-resistant descendant after root settlement, worker thread: %s",
    { timeout: 30_000 },
    async (workerThread, { signal: testSignal }) => {
      vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
      const cwd = tempDirs.make("openclaw-no-detach-proof-");
      const {
        leafPath,
        leafIdentityPath,
        leafTicksPath,
        rootPath,
        foreignIdentityPath,
        foreignTicksPath,
      } = await createFixture(cwd, workerThread);

      const foreign = spawn(process.execPath, [leafPath, foreignIdentityPath, foreignTicksPath], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: false,
      });
      const foreignReady = createDeferred();
      foreign.once("message", () => {
        foreign.disconnect();
        foreignReady.resolve();
      });
      const foreignExit = new Promise<void>((resolve, reject) => {
        foreign.once("error", reject);
        foreign.once("exit", () => resolve());
      });
      childExits.set(foreign.pid!, foreignExit);
      expect(foreign.pid).toBeDefined();
      const foreignInstance = readInstance(foreign.pid!);
      expect(foreignInstance?.starttime).toBeDefined();
      identities.push({ pid: foreign.pid!, starttime: foreignInstance!.starttime! });

      const signals: Array<{ pid: number; signal: Parameters<typeof process.kill>[1] }> = [];
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        signals.push({ pid, signal });
        // A broken group-signaling implementation must fail the test, not kill its host.
        if (pid < 0) {
          throw new Error("fixture forbids signaling the host process group");
        }
        return signalProcess(pid, signal);
      });
      const supervisor = createProcessSupervisor();
      const run = await supervisor.spawn({
        mode: "child",
        argv: [process.execPath, rootPath],
        exactEnv: true,
        cwd,
      });
      const root = readInstance(run.pid!);
      expect(root?.starttime).toBeDefined();
      identities.push({ pid: run.pid!, starttime: root!.starttime! });

      try {
        await withinTest(tickBeforeSettlement(leafTicksPath, run.wait()), testSignal);
        const leaf = readIdentity(leafIdentityPath)!;
        expect(leaf).toBeDefined();
        identities.push(leaf);
        expect(readInstance(leaf.pid)?.ppid).toBe(run.pid);
        expect(heartbeatSize(leafTicksPath)).toBeGreaterThan(0);
        await withinTest(
          awaitGateBeforeSettlement(
            foreignReady.promise,
            foreignExit,
            "Foreign control exited before its first tick",
          ),
          testSignal,
        );
        expect(heartbeatSize(foreignTicksPath)).toBeGreaterThan(0);
        expect(fallbackAttempts).toEqual([true, false]);

        const cancelledAt = Date.now();
        run.cancel("manual-cancel");
        const result = await withinTest(run.wait(), testSignal);
        const rootSettledAt = Date.now();
        expect(result.reason).toBe("manual-cancel");
        expect(stillRunning(leaf)).toBe(true);
        const afterSettlementTicks = heartbeatSize(leafTicksPath);
        await withinTest(
          receipts.waitFor(leafTicksPath, "tick", afterSettlementTicks + 1),
          testSignal,
        );
        expect(heartbeatSize(leafTicksPath)).toBeGreaterThan(afterSettlementTicks);
        await waitForFixtureExit(leaf, testSignal);
        expect(stillRunning(identities[0]!)).toBe(true);
        expect(signals.some(({ pid }) => pid < 0)).toBe(false);
        expect(signals.some(({ pid, signal }) => pid === foreign.pid && signal !== 0)).toBe(false);
        expect(signals.some(({ pid, signal }) => pid === leaf.pid && signal === "SIGKILL")).toBe(
          true,
        );
        console.log(
          JSON.stringify({
            proof: "no-detach-supervisor-root-settled",
            platform: process.platform,
            workerThread,
            root,
            leaf,
            foreign: identities[0],
            cancelledAt,
            rootSettledAt,
            descendantStoppedAt: Date.now(),
            fallbackAttempts,
            signals,
          }),
        );
      } finally {
        run.cancel();
        foreign.kill("SIGKILL");
        await Promise.all([supervisor.shutdown(), foreignExit]);
      }
    },
  );

  it("finishes retained escalation before an otherwise idle cancellation host exits", async ({
    signal,
  }) => {
    const cwd = tempDirs.make("openclaw-idle-cancellation-proof-");
    const { rootPath, leafIdentityPath, leafTicksPath } = await createFixture(cwd, false);
    const rootIdentityPath = path.join(cwd, "root.json");
    identityFiles.add(rootIdentityPath);
    const helperUrl = new URL(
      "../../../packages/agent-core/src/harness/env/kill-tree.ts",
      import.meta.url,
    ).href;
    const host = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
      import { spawn } from "node:child_process";
      import fs from "node:fs";
      import { killProcessTree } from ${JSON.stringify(helperUrl)};
      const root = spawn(process.execPath, [${JSON.stringify(rootPath)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const ready = new Promise(resolve => root.once("message", resolve));
      const stat = fs.readFileSync("/proc/" + root.pid + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);
      fs.writeFileSync(${JSON.stringify(rootIdentityPath)}, JSON.stringify({pid: root.pid, starttime: fields[19]}));
      await ready;
      root.disconnect();
      killProcessTree(root.pid, { detached: false, graceMs: 200 });
      // No more host work. Closing the root's handle must not cancel escalation.
    `,
      ],
      { stdio: "ignore" },
    );
    const hostInstance = readInstance(host.pid!);
    expect(hostInstance?.starttime).toBeDefined();
    identities.push({ pid: host.pid!, starttime: hostInstance!.starttime! });
    const exit = new Promise<number | null>((resolve, reject) => {
      host.once("error", reject);
      host.once("exit", resolve);
    });
    childExits.set(host.pid!, exit);
    try {
      await withinTest(tickBeforeSettlement(leafTicksPath, exit), signal);
      const leaf = readIdentity(leafIdentityPath)!;
      expect(leaf).toBeDefined();
      identities.push(leaf);
      expect(await withinTest(exit, signal)).toBe(0);
      await waitForFixtureExit(leaf, signal);
      console.log(
        JSON.stringify({
          proof: "idle-cancellation-host-exit",
          host: host.pid,
          leaf,
          stopped: true,
        }),
      );
    } finally {
      host.kill("SIGKILL");
      await exit;
    }
  }, 20_000);
});
