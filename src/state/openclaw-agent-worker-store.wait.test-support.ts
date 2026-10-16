import fs from "node:fs";
import type { FixtureReceiptChannel } from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";

export async function waitForFixtureEntry(
  receipts: FixtureReceiptChannel,
  marker: string,
  work: Promise<unknown>,
  signal: AbortSignal,
) {
  // Worker replies and broadcast receipts are unordered; the durable marker is written first.
  const settled = work.then(
    () => {
      if (!fs.existsSync(marker)) {
        throw new Error("Worker settled before entering the fixture barrier");
      }
    },
    (error: unknown) => {
      if (!fs.existsSync(marker)) {
        throw error;
      }
    },
  );
  await withinTest(Promise.race([receipts.waitFor(marker, "entered"), settled]), signal);
}
