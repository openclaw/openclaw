import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { resolveStateDir } from "../config/paths.js";
import {
  redactSupportDiagnosticLine,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";

const NPM_FAILURE_CODES = [
  "EACCES",
  "EPERM",
  "ENOTEMPTY",
  "EEXIST",
  "ENOENT",
  "E404",
  "ETARGET",
  "ENOSPC",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "E401",
  "E403",
  "EOTP",
  "ERESOLVE",
  "EBADENGINE",
  "EINTEGRITY",
  "EUSAGE",
  "EOVERRIDE",
  "EINVALIDTAGNAME",
  "EUNSUPPORTEDPROTOCOL",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "unknown",
] as const;
type NpmFailureCode = (typeof NPM_FAILURE_CODES)[number];
type NpmFailureFact = UpdateFailureFact & { check: "npm"; code: NpmFailureCode };

function npmFailureCode(value: string | undefined): NpmFailureCode {
  return NPM_FAILURE_CODES.find((code) => code === value) ?? "unknown";
}

function sanitizeNpmLine(line: string, context: SupportRedactionContext): string {
  return truncateUtf8Prefix(
    redactSupportDiagnosticLine(line, context).replace(
      /^(npm (?:ERR!|error) code)\s+\S+/u,
      (_match, prefix: string) => `${prefix} ${npmFailureCode(line.split(/\s+/u)[3])}`,
    ),
    200,
  );
}

/** Capture npm's error lines before command tails or permission guidance replace them. */
export function createNpmFailureFacts(
  stdout: string,
  stderr: string,
  env: NodeJS.ProcessEnv = process.env,
): NpmFailureFact[] {
  const lines = stripAnsi(`${stderr}\n${stdout}`)
    .split(/[\r\n\u2028\u2029]/u)
    .map((line) => line.trim())
    .filter((line) => /^npm (?:ERR!|error)(?:\s|$)/u.test(line));
  const code = npmFailureCode(
    lines.map((line) => /^npm (?:ERR!|error) code (\S+)/u.exec(line)?.[1]).find(Boolean),
  );
  const context = { env, stateDir: resolveStateDir(env) };
  // The existing ledger admits five 200-character facts. Stay within that contract
  // and a stricter UTF-8 budget instead of introducing a second diagnostic store.
  return (lines.length ? lines.slice(0, 5) : ["npm error (no error lines captured)"]).map(
    (line) => ({ check: "npm", code, message: sanitizeNpmLine(line, context) }),
  );
}

export function formatNpmFailureFacts(
  facts: readonly UpdateFailureFact[],
  context: SupportRedactionContext,
): string[] {
  const npm = facts.filter((fact) => fact.check === "npm").slice(0, 5);
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
          ? "Check the configured npm registry and requested package version or tag, then retry the update."
          : undefined;
  return [
    `npm failure code: ${code}`,
    ...npm.flatMap((fact) => (fact.message ? [sanitizeNpmLine(fact.message, context)] : [])),
    ...(remedy ? [`Next step: ${remedy}`] : []),
  ];
}
