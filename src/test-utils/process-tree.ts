import fs from "node:fs/promises";
import path from "node:path";
import { fixtureReceiptClientSource } from "../../test/helpers/fixture-receipts.js";
import { isPidAlive } from "../shared/pid-alive.js";

export async function writeForkingNoOutputScript(
  dir: string,
  receiptEndpoint: string,
): Promise<string> {
  const scriptPath = path.join(dir, "fork-no-output.sh");
  const childPath = path.join(dir, "fork-no-output.mjs");
  // The descendant publishes its PID after installing its keepalive, so callers
  // can trigger the idle deadline only after a live process tree is ready. It
  // stays silent: later output refreshes the idle timer and cancels a deadline
  // the caller already fired.
  await fs.writeFile(
    childPath,
    [
      fixtureReceiptClientSource(receiptEndpoint),
      'import { writeFileSync } from "node:fs";',
      "setInterval(() => {}, 1000);",
      "writeFileSync(process.env.PID_FILE, String(process.pid));",
      'sendReceipt(process.env.PID_FILE, "ready");',
    ].join("\n"),
  );
  await fs.writeFile(
    scriptPath,
    ["#!/bin/sh", `"$NODE_BINARY" ${JSON.stringify(childPath)} &`, "wait"].join("\n"),
    "utf8",
  );
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

export async function waitForPidToExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !isPidAlive(pid);
}

export async function readPidFile(pidPath: string): Promise<number> {
  return Number((await fs.readFile(pidPath, "utf8")).trim());
}

export function killPidIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // The process can exit after the liveness probe; ESRCH already satisfies cleanup.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") {
      throw error;
    }
  }
}
