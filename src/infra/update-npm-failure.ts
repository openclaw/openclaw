import { UPDATE_NPM_ERROR_CODES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/paths.js";
import {
  redactSupportDiagnosticLine,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import {
  npmFailureCode,
  npmFailurePackageSpec,
  parseNpmErrorCode,
  type NpmFailureCode,
} from "./npm-error.js";
import { createUpdateFailureFact, type UpdateFailureFact } from "./update-failure-facts.js";

type NpmFailureFact = UpdateFailureFact & { check: "npm" | "bun"; code: NpmFailureCode };

function sanitizeNpmLines(lines: readonly string[], context: SupportRedactionContext): string[] {
  const marker = " …[truncated]";
  return lines.slice(0, 5).map((line) => {
    const message = redactSupportDiagnosticLine(line, context, Number.MAX_SAFE_INTEGER).replace(
      /^(npm (?:ERR!|error) code)\s+\S+/u,
      (_match, prefix: string) => `${prefix} ${npmFailureCode(line.split(/\s+/u)[3])}`,
    );
    return Buffer.byteLength(message) > 200
      ? `${truncateUtf8Prefix(message, 200 - Buffer.byteLength(marker))}${marker}`
      : message;
  });
}

/** Capture npm's error lines before command tails or permission guidance replace them. */
export function createNpmFailureFacts(
  stdout: string,
  stderr: string,
  env: NodeJS.ProcessEnv = process.env,
  manager: "npm" | "bun" = "npm",
): NpmFailureFact[] {
  const lines = stripAnsi(`${stderr}\n${stdout}`)
    .split(/[\r\n\u2028\u2029]/u)
    .map((line) => line.trim())
    .filter((line) =>
      manager === "npm" ? /^npm (?:ERR!|error)(?:\s|$)/u.test(line) : /^error:/u.test(line),
    );
  const code = parseNpmErrorCode(stripAnsi(`${stderr}\n${stdout}`));
  const npmErrorCode = UPDATE_NPM_ERROR_CODES.find((entry) => entry === code) ?? "unknown";
  const packageSpec = npmFailurePackageSpec(stripAnsi(stderr));
  const context = { env, stateDir: resolveStateDir(env) };
  // The existing ledger admits five 200-character facts. Stay within that contract
  // and a stricter UTF-8 budget instead of introducing a second diagnostic store.
  return sanitizeNpmLines(
    lines.length ? lines : [`${manager} error (no error lines captured)`],
    context,
  ).map((message, index) => ({
    ...createUpdateFailureFact(
      {
        check: manager,
        code,
        message,
        ...(index === 0 ? { npmErrorCode, ...(packageSpec ? { packageSpec } : {}) } : {}),
      },
      env,
    ),
    check: manager,
    code,
  }));
}

export function formatNpmFailureFacts(
  facts: readonly UpdateFailureFact[],
  context: SupportRedactionContext,
): string[] {
  const npm = facts.filter((fact) => fact.check === "npm" || fact.check === "bun").slice(0, 5);
  if (!npm.length) {
    return [];
  }
  const code = npmFailureCode(npm[0]?.code);
  const remedy =
    code === "EACCES" || code === "EPERM"
      ? "Check the npm global prefix and run the update as its owning account: https://docs.openclaw.ai/cli/update."
      : code === "ENOSPC"
        ? "Free disk space on the npm prefix and cache volumes, then retry the update."
        : code === "E404" || code === "ETARGET"
          ? `Run npm cache verify, check the configured npm registry/mirror, and run npm view ${npm[0]?.packageSpec ? quoteCliArg(npm[0].packageSpec) : "<spec>"} version before retrying the update.`
          : undefined;
  return [
    `${npm[0]?.check} failure code: ${code}`,
    ...sanitizeNpmLines(
      npm.flatMap((fact) => (fact.message ? [fact.message] : [])),
      context,
    ),
    ...(remedy ? [`Next step: ${remedy}`] : []),
  ];
}
