import type { Page } from "playwright";
import { waitForControlUiGatewayReady } from "./control-ui-e2e-readiness.ts";

/** Acquire and consume a fresh handoff for this page; never cache a single-use dashboard URL. */
export async function pairControlUiPage(
  page: Page,
  runCli: (args: string[]) => Promise<string>,
): Promise<void> {
  const handoff: { ok: boolean; browserUrl?: string; reason?: string } = JSON.parse(
    await runCli(["dashboard", "--json"]),
  );
  if (!handoff.ok || !handoff.browserUrl) {
    throw new Error(handoff.reason ?? "Dashboard did not issue a browser pairing link");
  }
  await page.goto(handoff.browserUrl);
  await waitForControlUiGatewayReady(page);
}
