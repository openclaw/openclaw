import { resolveNodeStartupTlsEnvironment } from "./bootstrap/node-startup-env.js";
import { shouldSkipRespawnForArgv } from "./cli/respawn-policy.js";
import { isTruthyEnvValue } from "./infra/env.js";

export const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
export const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";
export const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";

export function hasExperimentalWarningSuppressed(
  params: {
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
  } = {},
): boolean {
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) {
    return true;
  }
  return execArgv.some((arg) => arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings");
}

export function buildCliRespawnPlan(
  params: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    execPath?: string;
    autoNodeExtraCaCerts?: string | undefined;
  } = {},
): { argv: string[]; env: NodeJS.ProcessEnv } | null {
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const execPath = params.execPath ?? process.execPath;

  if (shouldSkipRespawnForArgv(argv) || isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)) {
    return null;
  }

  const childEnv: NodeJS.ProcessEnv = { ...env };
  const childExecArgv = [...execArgv];
  let needsRespawn = false;

  const autoNodeExtraCaCerts =
    params.autoNodeExtraCaCerts ??
    resolveNodeStartupTlsEnvironment({
      env,
      execPath,
      includeDarwinDefaults: false,
    }).NODE_EXTRA_CA_CERTS;
  if (
    autoNodeExtraCaCerts &&
    !isTruthyEnvValue(env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]) &&
    !env.NODE_EXTRA_CA_CERTS
  ) {
    childEnv.NODE_EXTRA_CA_CERTS = autoNodeExtraCaCerts;
    childEnv[OPENCLAW_NODE_EXTRA_CA_CERTS_READY] = "1";
    needsRespawn = true;
  }

  if (
    !isTruthyEnvValue(env[OPENCLAW_NODE_OPTIONS_READY]) &&
    !hasExperimentalWarningSuppressed({ env, execArgv })
  ) {
    childEnv[OPENCLAW_NODE_OPTIONS_READY] = "1";
    childExecArgv.unshift(EXPERIMENTAL_WARNING_FLAG);
    needsRespawn = true;
  }

  if (!needsRespawn) {
    return null;
  }

  return {
    argv: [...childExecArgv, ...argv.slice(1)],
    env: childEnv,
  };
}
