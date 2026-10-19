import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";

type Identity = { pid: number; starttime: string };
const identityFiles = new Set<string>();
const tempDirs = createTempDirTracker();
const signalProcess = process.kill.bind(process);
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
    return { pid, state: fields[0], starttime: fields[19] };
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
    return Number.isSafeInteger(identity.pid) &&
      identity.pid > 0 &&
      /^\d+$/u.test(identity.starttime)
      ? identity
      : undefined;
  } catch {
    // The fixture has not published its identity yet.
  }
  return undefined;
}

async function createFixture(cwd: string) {
  const leafPath = path.join(cwd, "leaf.mjs");
  const leafIdentityPath = path.join(cwd, "leaf.json");
  const leafTicksPath = path.join(cwd, "leaf.ticks");
  const rootPath = path.join(cwd, "root.cjs");
  identityFiles.add(leafIdentityPath);
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
  await writeFile(
    rootPath,
    `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      process.on("SIGTERM", () => process.exit(0));
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
    `,
  );
  return { leafIdentityPath, leafTicksPath, rootPath };
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
  const requireTick = (error: unknown) => {
    if (!statSync(file, { throwIfNoEntry: false })?.size) {
      throw error;
    }
  };
  return Promise.race([
    receipts.waitFor(file, "tick"),
    operation.then(
      () => requireTick(new Error(`Fixture exited before its first tick: ${file}`)),
      requireTick,
    ),
  ]);
}

afterEach(async ({ signal }) => {
  const identities = [...identityFiles]
    .map(readIdentity)
    .filter((identity) => identity !== undefined);
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
    await Promise.all(identities.map((identity) => waitForFixtureExit(identity, signal)));
  } finally {
    identityFiles.clear();
    tempDirs.cleanup();
  }
});

describe.skipIf(process.platform !== "linux")("Linux no-detach cancellation", () => {
  it("finishes retained escalation before an otherwise idle cancellation host exits", async ({
    signal,
  }) => {
    const cwd = tempDirs.make("openclaw-idle-cancellation-proof-");
    const { rootPath, leafIdentityPath, leafTicksPath } = await createFixture(cwd);
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
    const exit = new Promise<number | null>((resolve, reject) => {
      host.once("error", reject);
      host.once("exit", resolve);
    });
    try {
      expect(readInstance(host.pid!)?.starttime).toBeDefined();
      await withinTest(tickBeforeSettlement(leafTicksPath, exit), signal);
      const leaf = readIdentity(leafIdentityPath)!;
      expect(leaf).toBeDefined();
      expect(await withinTest(exit, signal)).toBe(0);
      await waitForFixtureExit(leaf, signal);
    } finally {
      host.kill("SIGKILL");
      await exit;
    }
  }, 20_000);
});
