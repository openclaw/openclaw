import type { ErrorObject } from "ajv";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";

type ValidatorFn = ((value: unknown) => boolean) & {
  errors?: ErrorObject[] | null;
};

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

export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  }
}

export function uniqueSortedStrings(values: unknown[]) {
  return [...new Set(values.filter((v) => typeof v === "string"))]
    .map((v) => v.trim())
    .filter(Boolean)
    .toSorted();
}

export function safeParseJson(value: string | null | undefined): unknown {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { payloadJSON: value };
  }
}

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
  const nodeCode = typeof nodeError?.code === "string" ? nodeError.code.trim() : "";
  const nodeMessage =
    typeof nodeError?.message === "string" && nodeError.message.trim().length > 0
      ? nodeError.message.trim()
      : "node invoke failed";
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
