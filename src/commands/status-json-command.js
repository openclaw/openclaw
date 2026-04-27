import { writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";
export async function runStatusJsonCommand(params) {
    const scan = await params.scanStatusJsonFast({ timeoutMs: params.opts.timeoutMs, all: params.opts.all }, params.runtime);
    writeRuntimeJson(params.runtime, await resolveStatusJsonOutput({
        scan,
        opts: params.opts,
        includeSecurityAudit: params.includeSecurityAudit,
        includePluginCompatibility: params.includePluginCompatibility,
        suppressHealthErrors: params.suppressHealthErrors,
    }));
}
