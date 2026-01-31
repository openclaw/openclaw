/**
 * Web-based onboarding UI entry point.
 *
 * Starts a standalone HTTP/WebSocket server for the web onboarding interface.
 */

import type { RuntimeEnv } from "../../runtime.js";
import type { OnboardOptions } from "../onboard-types.js";
import { startOnboardWebServer } from "./server.js";

const DEFAULT_WEB_PORT = 9887;

export async function runWebOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const port = opts.webPort ?? DEFAULT_WEB_PORT;
  const open = opts.webOpen ?? true;

  runtime.log(`Starting web-based onboarding UI on port ${port}...`);

  await startOnboardWebServer({
    port,
    open,
    runtime,
    opts,
  });
}
