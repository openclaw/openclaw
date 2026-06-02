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

/** Converts gateway-protocol validator errors into a uniform JSON-RPC error response. */
export function respondInvalidParams(params: {
  respond: RespondFn;
  method: string;
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

/** Runs a handler body and reports thrown runtime failures as UNAVAILABLE. */
export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
}

/** Bridges node invoke result objects into gateway UNAVAILABLE responses. */
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
  // Keep the public error message compact, but preserve the raw node error in
  // details so operator tooling can inspect provider-specific failure payloads.
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: { nodeError: res.error ?? null },
    }),
  );
  return false;
}
