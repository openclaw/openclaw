import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Page } from "playwright";

/** The suite owns failure screenshots and RPC diagnostics; retain the interaction trace here. */
export async function withWidgetChromeDiagnostics(
  page: Page,
  artifactDir: () => string,
  run: () => Promise<void>,
): Promise<void> {
  const context = page.context();
  await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    await run();
  } catch (error) {
    try {
      await withTimeout(
        context.tracing.stop({ path: path.join(artifactDir(), "widget-chrome-trace.zip") }),
        5_000,
        "widget chrome trace capture",
      );
    } catch (captureError) {
      console.error(`[single-widget-chrome] trace capture failed: ${String(captureError)}`);
    }
    throw error;
  }
  await context.tracing.stop();
}
