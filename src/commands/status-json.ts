import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

export async function statusJsonCommand(
  opts: {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const scan = await scanStatusJsonFast({ timeoutMs: opts.timeoutMs, all: opts.all }, runtime);
  writeRuntimeJson(
    runtime,
    await resolveStatusJsonOutput({
      scan,
      opts,
      includeSecurityAudit: opts.all === true,
      suppressHealthErrors: true,
    }),
  );
}
