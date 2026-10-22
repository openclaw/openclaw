import { afterAll, beforeAll } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";

export let tuiFixtureReceipts: FixtureReceiptChannel;
beforeAll(async () => {
  tuiFixtureReceipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await tuiFixtureReceipts.close();
});

export function tuiFixtureRecordSource(): string {
  return `
      ${fixtureReceiptClientSource(tuiFixtureReceipts.endpoint)}
      import { appendFileSync } from "node:fs";
      const actionLogPath = process.env.OPENCLAW_TUI_PTY_LOG_PATH;
      function record(method: string, payload?: unknown) {
        if (!actionLogPath) {
          return;
        }
        const line = JSON.stringify({ method, payload });
        // Commit before reporting: terminal output and receipts use separate transports.
        appendFileSync(actionLogPath, line + "\\n", "utf8");
        sendReceipt(actionLogPath, line);
      }
  `;
}
