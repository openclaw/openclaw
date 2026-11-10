import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, onTestFinished } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";

type Identity = { pid: number; starttime: string };
const signalProcess = process.kill.bind(process);

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
  } catch {}
  return undefined;
}

async function createFixture(signal: AbortSignal) {
  const tempDirs = createTempDirTracker();
  const cwd = tempDirs.make("openclaw-idle-cancellation-proof-");
  const leafPath = path.join(cwd, "leaf.mjs");
  const leafIdentityPath = path.join(cwd, "leaf.json");
  const leafTicksPath = path.join(cwd, "leaf.ticks");
  const rootIdentityPath = path.join(cwd, "root.json");
  onTestFinished(async () => {
    const identities = [leafIdentityPath, rootIdentityPath]
      .map(readIdentity)
      .filter((identity) => identity !== undefined);
    try {
      for (const identity of identities) {
        if (stillRunning(identity)) {
          try {
            signalProcess(identity.pid, "SIGKILL");
          } catch {
            // The exact fixture instance exited after the identity check.
          }
        }
      }
      await Promise.all(identities.map((identity) => waitForFixtureExit(identity, signal)));
    } finally {
      tempDirs.cleanup();
    }
  });
  await writeFile(
    leafPath,
    `
      import fs from "node:fs";
      process.on("SIGTERM", () => {});
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);
      fs.writeFileSync(process.argv[2], JSON.stringify({pid: process.pid, starttime: fields[19]}));
      let tick = 0;
      setInterval(() => {
        fs.appendFileSync(process.argv[3], ".");
        if (++tick === 1) process.send?.("ready");
      }, 25);
    `,
  );
  const rootSource = `
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
    `;
  return { leafIdentityPath, rootIdentityPath, leafTicksPath, rootSource };
}

async function waitForFixtureExit(identity: Identity, signal: AbortSignal) {
  while (stillRunning(identity)) {
    await delay(10, undefined, { signal });
  }
}

it.skipIf(process.platform !== "linux")(
  "finishes retained escalation before an otherwise idle cancellation host exits",
  async ({ signal }) => {
    const { rootSource, leafIdentityPath, rootIdentityPath, leafTicksPath } =
      await createFixture(signal);
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
      const root = spawn(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(rootSource)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
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
      // Host cancellation starts only after the leaf's first tick and IPC acknowledgement.
      expect(await withinTest(exit, signal)).toBe(0);
      expect(statSync(leafTicksPath).size).toBeGreaterThan(0);
      const leaf = readIdentity(leafIdentityPath)!;
      expect(leaf).toBeDefined();
      await waitForFixtureExit(leaf, signal);
    } finally {
      host.kill("SIGKILL");
      await exit;
    }
  },
  20_000,
);
