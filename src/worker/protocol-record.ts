import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

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
