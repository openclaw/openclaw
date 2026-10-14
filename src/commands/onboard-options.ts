/**
 * Shared choice validation and rejection for `openclaw onboard` options.
 *
 * Lives above the local/remote split because both the outer command and the
 * non-interactive handlers reject options, and every one of them must honor --json.
 */
import { formatInvalidPortOption } from "../cli/error-format.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isGatewayDaemonRuntime } from "./daemon-runtime.js";
import { isNodeManagerChoice, isOnboardFlow, type OnboardOptions } from "./onboard-types.js";

/** Reports an invalid option and exits; returns false so validators can `return` it directly. */
export function rejectOnboardingOption(
  opts: { json?: boolean },
  runtime: RuntimeEnv,
  message: string,
): false {
  // --json promises exactly one machine-readable object per run, so a rejection has to emit one
  // too. Without this the caller sees an empty stdout and cannot tell a bad flag from a crash.
  if (opts.json) {
    writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), phase: "options", message });
  }
  runtime.error(message);
  runtime.exit(1);
  return false;
}

export function validateOnboardingChoiceOptions(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
): boolean {
  const reject = (message: string) => rejectOnboardingOption(opts, runtime, message);
  const choiceValidations: Array<readonly [string, string | undefined, readonly string[]]> = [
    ["--gateway-bind", opts.gatewayBind, ["loopback", "tailnet", "lan", "auto", "custom"]],
    ["--gateway-auth", opts.gatewayAuth, ["token", "password"]],
    ["--tailscale", opts.tailscale, ["off", "serve", "funnel"]],
    [
      "--custom-compatibility",
      opts.customCompatibility,
      ["openai", "openai-responses", "anthropic"],
    ],
  ];
  for (const [flag, value, allowed] of choiceValidations) {
    if (value !== undefined && !allowed.includes(value)) {
      return reject(
        `Invalid ${flag} ${JSON.stringify(value)}. Use ${allowed.map((choice) => JSON.stringify(choice)).join(", ")}.`,
      );
    }
  }
  if (opts.flow !== undefined && !isOnboardFlow(opts.flow)) {
    return reject('Invalid --flow. Use "quickstart", "advanced", "manual", or "import".');
  }
  if (opts.daemonRuntime !== undefined && !isGatewayDaemonRuntime(opts.daemonRuntime)) {
    return reject('Invalid --daemon-runtime. Use "node" or "bun".');
  }
  if (opts.nodeManager !== undefined && !isNodeManagerChoice(opts.nodeManager)) {
    return reject('Invalid --node-manager. Use "npm", "pnpm", or "bun".');
  }
  if (
    opts.gatewayPort !== undefined &&
    (!Number.isFinite(opts.gatewayPort) || opts.gatewayPort <= 0 || opts.gatewayPort > 65_535)
  ) {
    return reject(formatInvalidPortOption("--gateway-port"));
  }
  return true;
}
