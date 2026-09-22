import { types } from "node:util";
import { projectDiagnosticValue } from "@openclaw/ai/diagnostics";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { collectErrorGraphCandidates } from "../infra/errors.js";
import { serializeRedactedFileLogRecord } from "./redact.js";
import type { SubsystemLogger } from "./subsystem.js";

const MAX_RUN_ERROR_DIAGNOSTIC_CHARS = 100_000;
const nativeErrorStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

function collectErrorStacks(error: unknown): string[] {
  let remaining = 63;
  const candidates = collectErrorGraphCandidates(error, (candidate) => {
    const children: unknown[] = [];
    const append = (value: unknown) => {
      if (remaining > 0 && value !== null && typeof value === "object") {
        children.push(value);
        remaining -= 1;
      }
    };
    try {
      append(Object.getOwnPropertyDescriptor(candidate, "cause")?.value);
      const errors = Object.getOwnPropertyDescriptor(candidate, "errors")?.value;
      if (remaining > 0 && Array.isArray(errors)) {
        const length = Object.getOwnPropertyDescriptor(errors, "length")?.value;
        const limit = Math.min(typeof length === "number" ? length : 0, remaining);
        for (let index = 0; index < limit; index += 1) {
          append(Object.getOwnPropertyDescriptor(errors, String(index))?.value);
        }
      }
    } catch {
      // Opaque causes do not prevent retaining readable sibling stacks.
    }
    return children;
  });
  return candidates.flatMap((candidate) => {
    try {
      if (!types.isNativeError(candidate)) {
        return [];
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, "stack");
      if (typeof descriptor?.value === "string") {
        return [descriptor.value];
      }
      if (!nativeErrorStackGetter || descriptor?.get !== nativeErrorStackGetter) {
        return [];
      }
      // Node 26 exposes its own lazy stack accessor. Only invoke that known getter,
      // and do not let its name/message formatting invoke error-owned accessors.
      for (const key of ["name", "message"]) {
        let owner: object | null = candidate;
        for (let depth = 0; owner; depth += 1) {
          if (depth === 16) {
            return [];
          }
          const label = Object.getOwnPropertyDescriptor(owner, key);
          if (label) {
            if (
              !("value" in label) ||
              (label.value !== undefined && typeof label.value !== "string")
            ) {
              return [];
            }
            break;
          }
          owner = Object.getPrototypeOf(owner);
        }
      }
      const stack: unknown = nativeErrorStackGetter.call(candidate);
      return typeof stack === "string" ? [stack] : [];
    } catch {
      return [];
    }
  });
}

/** Record the original failure before a terminal owner reduces it to public copy. */
export function logRunError(
  logger: Pick<SubsystemLogger, "isEnabled" | "error">,
  message: string,
  params: { runId: string; error: unknown },
): void {
  try {
    if (!logger.isEnabled("error")) {
      return;
    }
    // Put stacks first so large provider metadata cannot displace the native stack.
    // Redact the complete snapshot before clipping; never split an unmasked credential.
    const diagnostic = serializeRedactedFileLogRecord({
      stacks: projectDiagnosticValue(collectErrorStacks(params.error)),
      error: projectDiagnosticValue(params.error, { omitField: (key) => key === "toJSON" }),
    });
    logger.error(message, {
      runId: params.runId,
      diagnostic: truncateUtf16Safe(diagnostic, MAX_RUN_ERROR_DIAGNOSTIC_CHARS),
      diagnosticTruncated: diagnostic.length > MAX_RUN_ERROR_DIAGNOSTIC_CHARS,
    });
  } catch {
    // Best-effort diagnostics must not replace the original terminal outcome.
  }
}
