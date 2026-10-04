// Startup policy helpers for config guards, plugin loading, banners, and CLI path checks.
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

export function resolveCliStartupPolicy(params: {
  argv?: string[];
  /** Commander-owned option values, available after parsing. */
  options?: Readonly<Record<string, unknown>>;
  commandPath: string[];
  jsonOutputMode: boolean;
  machineOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Set only by the parsed, registered native capability action. */
  nativeUpdateExecutorCheck?: boolean;
}) {
  const commandPolicy = resolveCliCommandPathPolicy(params.commandPath);
  const nativeCheck = params.nativeUpdateExecutorCheck === true;
  const machineOutputMode =
    nativeCheck || params.jsonOutputMode || params.machineOutputMode === true;
  // Protocol commands own stdout from process startup, before their action installs later routing.
  const suppressDoctorStdout = machineOutputMode || commandPolicy.ownsProtocolStdout;
  const configGuard =
    typeof commandPolicy.configGuard === "function"
      ? commandPolicy.configGuard({
          argv: params.argv ?? [],
          commandPath: params.commandPath,
          options: params.options,
        })
      : commandPolicy.configGuard;
  const env = params.env ?? process.env;
  const hideBanner = machineOutputMode || commandPolicy.hideBanner;
  return {
    suppressDoctorStdout,
    hideBanner: hideBanner || isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER),
    skipConfigGuard: nativeCheck || configGuard === "skip" || configGuard === "defer",
    // Deferred actions own full preparation; early routing/proxy reads need only core config.
    ...(configGuard === "validate" || configGuard === "defer" ? { validateConfigOnly: true } : {}),
    loadPlugins:
      !nativeCheck &&
      (typeof commandPolicy.loadPlugins === "function"
        ? commandPolicy.loadPlugins({
            argv: params.argv ?? [],
            commandPath: params.commandPath,
            jsonOutputMode: params.jsonOutputMode,
          })
        : commandPolicy.loadPlugins === "always"),
    pluginRegistry: commandPolicy.pluginRegistry,
  };
}
