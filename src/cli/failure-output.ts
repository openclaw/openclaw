import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { resolveCliName } from "./cli-name.js";
import { formatCliCommand } from "./command-format.js";
import { productizeUserCopy } from "./product-surface.js";

type FormatCliFailureOptions = {
  title: string;
  error: unknown;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  includeDoctorHint?: boolean;
};

function hasDebugArg(argv: string[] | undefined): boolean {
  return Boolean(argv?.some((arg) => arg === "--debug" || arg === "--verbose"));
}

function shouldShowStack(argv: string[] | undefined, env: NodeJS.ProcessEnv): boolean {
  return hasDebugArg(argv) || isTruthyEnvValue(env.OPENCLAW_DEBUG);
}

function cliTag(env: NodeJS.ProcessEnv): string {
  return `[${resolveCliName([], env)}]`;
}

function pushPrefixed(out: string[], value: string, env: NodeJS.ProcessEnv): void {
  const tag = cliTag(env);
  for (const line of value.split("\n")) {
    if (line.trim().length > 0) {
      out.push(`${tag} ${line}`);
    }
  }
}

export function formatCliFailureLines(options: FormatCliFailureOptions): string[] {
  const env = options.env ?? process.env;
  const tag = cliTag(env);
  const lines = [
    `${tag} ${productizeUserCopy(options.title, env)}`,
    `${tag} Reason: ${formatErrorMessage(options.error)}`,
  ];

  if (shouldShowStack(options.argv, env)) {
    lines.push(`${tag} Stack:`);
    pushPrefixed(lines, formatUncaughtError(options.error), env);
  } else {
    lines.push(`${tag} Debug: set OPENCLAW_DEBUG=1 to include the stack trace.`);
  }

  if (options.includeDoctorHint !== false) {
    lines.push(`${tag} Try: ${formatCliCommand("openclaw doctor", env)}`);
  }
  lines.push(`${tag} Help: ${formatCliCommand("openclaw --help", env)}`);
  return lines;
}
