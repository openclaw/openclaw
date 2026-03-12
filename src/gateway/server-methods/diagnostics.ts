import { loadConfig } from "../../config/config.js";
import { buildQueueDiagnosticsSnapshot } from "../../infra/queue-diagnostics.js";
import { resolveStuckSessionWarnMs } from "../../logging/diagnostic.js";
import type { GatewayRequestHandlers } from "./types.js";

export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.queue": async ({ respond, params }) => {
    const config = loadConfig();
    respond(
      true,
      buildQueueDiagnosticsSnapshot({
        includeIdle: params?.all === true,
        stuckSessionWarnMs: resolveStuckSessionWarnMs(config),
      }),
      undefined,
    );
  },
};
