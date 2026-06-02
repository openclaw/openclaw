import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ValidationError } from "../../../packages/gateway-protocol/src/index.js";
export { safeParseJson } from "../server-json.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";

type ValidatorFn = ((value: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

export function respondInvalidParams(params: {
  respond: RespondFn;
  /** Gateway method name used to make validation failures actionable. */
  method: string;
  /** Compiled validator whose errors are formatted into the protocol error. */
  validator: ValidatorFn;
}) {
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${params.method} params: ${formatValidationErrors(params.validator.errors)}`,
    ),
  );
}

export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    // Node/device operations fail as transient Gateway unavailability, not
    // invalid requests, because callers can often retry after reconnect.
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
}

/** Converts node invoke result envelopes into Gateway UNAVAILABLE responses. */
export function respondUnavailableOnNodeInvokeError<T extends { ok: boolean; error?: unknown }>(
  respond: RespondFn,
  res: T,
): res is T & { ok: true } {
  if (res.ok) {
    return true;
  }
  const nodeError =
    res.error && typeof res.error === "object"
      ? (res.error as { code?: unknown; message?: unknown })
      : null;
  const nodeCode = normalizeOptionalString(nodeError?.code) ?? "";
  const nodeMessage = normalizeOptionalString(nodeError?.message) ?? "node invoke failed";
  const message = nodeCode ? `${nodeCode}: ${nodeMessage}` : nodeMessage;
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: { nodeError: res.error ?? null },
    }),
  );
  return false;
}
