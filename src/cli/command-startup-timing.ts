import type { OpenClawConfig } from "../config/types.openclaw.js";
import { measureGatewayBootstrapStep } from "./startup-trace.js";

type DiagnosticsTimelineModule = typeof import("../infra/diagnostics-timeline.js");

type CliCommandStartupTimingOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

let diagnosticsTimelineModulePromise: Promise<DiagnosticsTimelineModule> | undefined;

function hasDiagnosticsTimelinePath(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH?.trim());
}

function loadDiagnosticsTimelineModule(): Promise<DiagnosticsTimelineModule> {
  diagnosticsTimelineModulePromise ??= import("../infra/diagnostics-timeline.js");
  return diagnosticsTimelineModulePromise;
}

/** Measures command-specific work hidden inside Commander parse/action dispatch. */
export async function measureCliCommandStartup<T>(
  stage: string,
  run: () => Promise<T> | T,
  options: CliCommandStartupTimingOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const tracedRun = stage.startsWith("doctor.config-preflight.")
    ? run
    : () => measureGatewayBootstrapStep(`cli.command.${stage}`, run);
  if (!hasDiagnosticsTimelinePath(env)) {
    return await tracedRun();
  }
  const { measureDiagnosticsTimelineSpan } = await loadDiagnosticsTimelineModule();
  return await measureDiagnosticsTimelineSpan("cli.command-startup", tracedRun, {
    config: options.config,
    env,
    phase: "cli.command-startup",
    attributes: { stage },
  });
}
