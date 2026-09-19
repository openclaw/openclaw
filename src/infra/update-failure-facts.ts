import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
  readErrorName,
} from "./errors.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { isPublicUpdateFailureCode } from "./update-failure-public-identifiers.js";
import type { UpdateFailureFactSchema } from "./update-run-schema.js";

export type UpdateFailureFact = z.infer<typeof UpdateFailureFactSchema>;

function readErrorMetadata<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function createUpdateErrorFact(
  check: string,
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact {
  // The formatter must never reach raw cause identities or stringify private object metadata.
  const errors = collectErrorGraphCandidates(error ?? String(error), (current) => [
    ...(readErrorMetadata(() => readErrorCauses(current)) ?? []),
    readErrorMetadata(() => current.cause),
  ]).map((current) => {
    const rawName = readErrorMetadata(() =>
      current instanceof Error ? current.constructor.name : readErrorName(current),
    );
    const name =
      typeof rawName === "string" && isPublicUpdateFailureCode(rawName) ? rawName : "Error";
    const code = extractErrorCode(current);
    const detail = readErrorMetadata(() =>
      isRecord(current)
        ? current.message
        : typeof current === "object" || typeof current === "function"
          ? undefined
          : formatErrorMessage(current),
    );
    const { message } = createUpdateFailureFact(
      {
        check,
        code: name,
        errorName: name,
        message: typeof detail === "string" && detail ? detail : name,
      },
      env,
    );
    return Object.assign(new Error(message), {
      name,
      code: code && isPublicUpdateFailureCode(code) ? code : undefined,
    });
  });
  const primary = errors[0];
  const stack = readErrorMetadata(() => (error instanceof Error ? error.stack : undefined));
  const root = readErrorMetadata(() =>
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
  );
  const prefixes = root
    ? [`${root.replaceAll("\\", "/")}/`, pathToFileURL(`${root}${path.sep}`).href]
    : [];
  let location: string | undefined;
  for (const frame of typeof stack === "string" ? stack.split("\n").slice(1) : []) {
    const file = /((?:file:\/\/)?(?:\/|[A-Z]:[\\/])[^()\r\n]+:\d+:\d+)\)?$/u
      .exec(frame)?.[1]
      ?.replaceAll("\\", "/");
    const prefix = prefixes.find((candidate) => file?.startsWith(candidate));
    const local = prefix && file ? path.posix.normalize(file.slice(prefix.length)) : null;
    // Private plugin and dependency directories are not public application locations.
    if (
      local &&
      !local.includes("/node_modules/") &&
      /^(?:src|dist|packages|extensions)\/[A-Za-z0-9_./-]+:\d+:\d+$/u.test(local)
    ) {
      location = local;
      break;
    }
  }
  return createUpdateFailureFact(
    {
      check,
      code: primary?.code ?? primary?.name ?? "Error",
      errorName: primary?.name ?? "Error",
      location: location ?? null,
      message: formatErrorMessage(new AggregateError(errors, primary?.message)),
    },
    env,
  );
}

/** Capture diagnostics before output is reduced to a command tail. */
export function createUpdateFailureFact(
  fact: UpdateFailureFact,
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact {
  const context = { env, stateDir: resolveStateDir(env) };
  const line = (value: string, limit: number) => redactSupportDiagnosticLine(value, context, limit);
  // Redact credentials and complete email addresses before replacing their host suffixes.
  const diagnostic = fact.message ? line(fact.message, Number.MAX_SAFE_INTEGER) : undefined;
  const message = fact.errorName
    ? diagnostic
        ?.replace(
          /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z][a-zA-Z0-9-]*(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|(?<!\w)(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.%]*/gu,
          "[redacted-host]",
        )
        .replace(
          /\b(host(?:name)?|server|endpoint)\s*[=:]\s*["']?[A-Za-z0-9-]+["']?/giu,
          "$1=[redacted-host]",
        )
    : diagnostic;
  const location =
    fact.location &&
    /^(?:src|dist|packages|extensions)\/[A-Za-z0-9_./-]+:\d+:\d+$/u.test(fact.location)
      ? line(fact.location, 160)
      : null;
  return {
    check: line(fact.check, 128),
    code: line(fact.code, 80),
    ...(message ? { message: line(message, 200) } : {}),
    ...(fact.errorName ? { errorName: line(fact.errorName, 80) } : {}),
    ...(fact.location !== undefined ? { location } : {}),
    ...(fact.affectedKey ? { affectedKey: line(fact.affectedKey, 128) } : {}),
    ...(fact.pluginId ? { pluginId: line(fact.pluginId, 80) } : {}),
  };
}

export function normalizeUpdateFailureFacts(
  facts: readonly UpdateFailureFact[],
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact[] {
  return facts.slice(0, 5).map((fact) => createUpdateFailureFact(fact, env));
}

/** Config validation issues are more specific than the CLI's failure envelope. */
export function parseConfigFailureFacts(
  stdout: string,
  env: NodeJS.ProcessEnv,
): UpdateFailureFact[] {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    // A failed command may exit before it writes its configuration report.
    return [];
  }
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    return [];
  }
  return normalizeUpdateFailureFacts(
    report.issues.flatMap((issue) =>
      isRecord(issue) && typeof issue.message === "string"
        ? [
            {
              check: "config",
              code: "candidate-config-failed",
              message: issue.message,
              affectedKey: typeof issue.path === "string" ? issue.path : undefined,
            },
          ]
        : [],
    ),
    env,
  );
}
