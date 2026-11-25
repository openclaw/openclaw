import { existsSync } from "node:fs";
import type { FixtureReceiptChannel } from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";

export function waitForFixtureReceipt(
  receipts: FixtureReceiptChannel,
  file: string,
  operation: Promise<unknown>,
  signal: AbortSignal,
  message: string,
) {
  // The socket receipt may lag settlement; the child's file is durable readiness evidence.
  const requireFile = (error: unknown) => {
    if (!existsSync(file)) {
      throw error;
    }
  };
  return withinTest(
    Promise.race([
      receipts.waitFor(file, "ready"),
      operation.then(() => requireFile(new Error(message)), requireFile),
    ]),
    signal,
  );
}
