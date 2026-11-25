import fs from "node:fs";
import { setTimeout as tick } from "node:timers/promises";
import type { FixtureReceiptChannel } from "../helpers/fixture-receipts.js";

// Unlike isPidAlive, this includes zombies: these fixtures require OS reaping.
export function isProcessPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessObservation(
  observed: () => boolean,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  while (!observed()) {
    await tick(5, undefined, { signal }).catch((cause: unknown) => {
      throw new Error(`test aborted waiting for ${label}`, { cause });
    });
  }
}

export async function fixtureReadyBeforeSettlement(
  receipts: FixtureReceiptChannel,
  file: string,
  operation: PromiseLike<unknown>,
  recorded = () => fs.existsSync(file),
) {
  // Publication precedes the receipt; completion and receipts use different pipes.
  const verify = (error: unknown) => {
    if (!recorded()) {
      throw error;
    }
  };
  const settled = Promise.resolve(operation).then(
    () => verify(new Error(`fixture exited before ${file} was ready`)),
    verify,
  );
  await Promise.race([receipts.waitFor(file, "ready"), settled]);
}
