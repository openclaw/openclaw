import fs from "node:fs/promises";
import { afterAll, beforeAll } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { hasErrnoCode } from "./errno.js";

export function useHandoffFixtureReceipts() {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts.close();
  });
  return {
    clientSource: () => fixtureReceiptClientSource(receipts.endpoint),
    async startedBeforeSettlement(markerPath: string, operation: PromiseLike<unknown>) {
      // The fixture publishes its durable marker before the out-of-band receipt.
      const settled = Promise.resolve(operation).then(async () => {
        const started = await fs.readFile(markerPath, "utf8").catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return "";
          }
          throw error;
        });
        if (!started) {
          throw new Error(`Updater exited before writing ${markerPath}`);
        }
      });
      await Promise.race([receipts.waitFor(markerPath, "started"), settled]);
    },
  };
}

export async function waitForOrphanExit(pid: number, signal: AbortSignal): Promise<void> {
  // The killed helper cannot join its surviving updater; no ChildProcess handle remains.
  while (isPidAlive(pid)) {
    try {
      await withinTest(
        new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        }),
        signal,
      );
    } catch (cause) {
      throw new Error(`Test aborted waiting for orphan updater ${pid} to exit`, { cause });
    }
  }
}

export function scopeWrapperSource(helperExitPath: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [command, scriptPath, paramsPath] = process.argv.slice(-3);
const helper = spawn(command, [scriptPath, paramsPath], { stdio: ["pipe", "pipe", "ignore"] });
let helperAlive = true;
helper.stdin.on("error", () => {});
helper.stdout.pipe(process.stdout, { end: false });
helper.once("exit", () => {
  helperAlive = false;
  fs.writeFileSync(${JSON.stringify(helperExitPath)}, String(helper.pid));
  process.stdout.write("helper-exited\\n");
});
process.stdin.on("data", (chunk) => {
  if (helperAlive) {
    helper.stdin.write(chunk);
  } else if (chunk.toString().includes("cancel\\n")) {
    process.stdout.write("cancelled\\n", () => process.exit(0));
  }
});
`;
}
