import { UPDATE_NPM_ERROR_CODES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeSupportDiagnosticErrorCode,
  redactSupportDiagnosticLine,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { npmFailurePackageSpec, parseNpmErrorCode } from "./npm-error.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import { updatePreflightDetailMessage } from "./update-preflight-details.js";

function sanitizeNpmLines(lines: readonly string[], context: SupportRedactionContext): string[] {
  const marker = " …[truncated]";
  return lines.slice(0, 5).map((line) => {
    const message = redactSupportDiagnosticLine(line, context, Number.MAX_SAFE_INTEGER).replace(
      /^(npm (?:ERR!|error) code)\s+\S+/u,
      (_match, prefix: string) =>
        `${prefix} ${normalizeSupportDiagnosticErrorCode(line.split(/\s+/u)[3]) ?? "unknown"}`,
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
): UpdateFailureFact[] {
  const output = stripAnsi(`${stderr}\n${stdout}`);
  const lines = output
    .split(/[\r\n\u2028\u2029]/u)
    .map((line) => line.trim())
    .filter((line) =>
      manager === "npm" ? /^npm (?:ERR!|error)(?:\s|$)/u.test(line) : line.startsWith("error:"),
    );
  const code = normalizeSupportDiagnosticErrorCode(parseNpmErrorCode(output)) ?? "unknown";
  const npmErrorCode = UPDATE_NPM_ERROR_CODES.find((entry) => entry === code) ?? "unknown";
  const packageSpec = npmFailurePackageSpec(output);
  const context = { env, stateDir: resolveStateDir(env) };
  // The existing ledger admits five 200-character facts. Stay within that contract
  // and a stricter UTF-8 budget instead of introducing a second diagnostic store.
  return sanitizeNpmLines(
    lines.length ? lines : [`${manager} error (no error lines captured)`],
    context,
  ).map((message, index) => ({
    check: manager,
    code,
    message,
    npmErrorCode: index === 0 ? npmErrorCode : undefined,
    packageSpec: index === 0 ? packageSpec : undefined,
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
  const code = normalizeSupportDiagnosticErrorCode(npm[0]?.code) ?? "unknown";
  const remedy = updatePreflightDetailMessage(
    `npm-${code === "EPERM" ? "EACCES" : code === "E404" ? "ETARGET" : code}`,
  )?.replace("<spec>", npm[0]?.packageSpec ? quoteCliArg(npm[0].packageSpec) : "<spec>");
  return [
    `${npm[0]?.check} failure code: ${code}`,
    ...sanitizeNpmLines(
      npm.flatMap((fact) => (fact.message ? [fact.message] : [])),
      context,
    ),
    ...(remedy ? [`Next step: ${remedy}`] : []),
  ];
}
