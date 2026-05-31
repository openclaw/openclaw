import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

type StatusJsonCommandOptions = {
  deep?: boolean;
  usage?: boolean;
  timeoutMs?: number;
  all?: boolean;
};

/**
 * Runs the injectable JSON status flow used by the CLI and tests, then writes
 * the resolved payload through the runtime JSON sink.
 */
export async function runStatusJsonCommand(params: {
  opts: StatusJsonCommandOptions;
  runtime: RuntimeEnv;
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
  scanStatusJsonFast: (
    opts: { timeoutMs?: number; all?: boolean },
    runtime: RuntimeEnv,
  ) => Promise<Parameters<typeof resolveStatusJsonOutput>[0]["scan"]>;
}) {
  const scan = await params.scanStatusJsonFast(
    { timeoutMs: params.opts.timeoutMs, all: params.opts.all },
    params.runtime,
  );
  writeRuntimeJson(
    params.runtime,
    await resolveStatusJsonOutput({
      scan,
      opts: params.opts,
      includeSecurityAudit: params.includeSecurityAudit,
      includePluginCompatibility: params.includePluginCompatibility,
      suppressHealthErrors: params.suppressHealthErrors,
    }),
  );
}
