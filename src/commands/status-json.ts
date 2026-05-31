import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

/**
 * CLI entrypoint for `openclaw status --json`; `--all` opts into the heavier
 * security audit while health probe failures stay encoded in the JSON payload.
 */
export async function statusJsonCommand(
  opts: {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  await runStatusJsonCommand({
    opts,
    runtime,
    scanStatusJsonFast,
    includeSecurityAudit: opts.all === true,
    suppressHealthErrors: true,
  });
}
