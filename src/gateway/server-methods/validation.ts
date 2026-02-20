import type { ErrorObject } from "ajv";
import type { RespondFn } from "./types.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";

export type Validator<T> = ((params: unknown) => params is T) & {
  errors?: ErrorObject[] | null;
};

export function assertValidParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
  respond: RespondFn,
): params is T {
  if (validate(params)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
  return false;
}
