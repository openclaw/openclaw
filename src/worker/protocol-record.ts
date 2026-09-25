import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

export const workerProtocolIdentifier = (label: string, maxChars = 256) =>
  z.custom<string>(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxChars &&
      value.trim() === value &&
      !value.includes("\0"),
    { error: `INVALID_REQUEST: ${label} must be a bounded non-empty identifier` },
  );

export const WorkerGatewayNamespace = workerProtocolIdentifier("gatewayNamespace").refine(
  (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value),
  { error: "INVALID_REQUEST: gatewayNamespace must be a safe bounded path component" },
);

export function hasExactOwnKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    optional.every((key) => Object.hasOwn(value, key) || !Reflect.has(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** Validate the received object's own keys before schema parsing copies its properties. */
export function workerProtocolObject<Shape extends Record<string, z.ZodType>>(shape: Shape) {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    (schema.isOptional() ? optional : required).push(key);
  }
  return z
    .custom<Record<string, unknown>>(
      (value) => isRecord(value) && hasExactOwnKeys(value, required, optional),
    )
    .pipe(z.object(shape));
}
