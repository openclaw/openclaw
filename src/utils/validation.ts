/**
 * Input validation utilities for common patterns and formats.
 */

export type ValidationResult<T = string> =
  | { valid: true; value: T }
  | { valid: false; error: string };

/**
 * Validates that a string is not empty (after trimming).
 */
export function validateNonEmpty(
  value: unknown,
  fieldName = "Field",
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }
  return { valid: true, value: trimmed };
}

/**
 * Validates that a string matches a regular expression pattern.
 */
export function validatePattern(
  value: unknown,
  pattern: RegExp,
  errorMessage: string,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { valid: false, error: errorMessage };
  }
  if (!pattern.test(value)) {
    return { valid: false, error: errorMessage };
  }
  return { valid: true, value };
}

/**
 * Validates that a string has a minimum length.
 */
export function validateMinLength(
  value: unknown,
  minLength: number,
  fieldName = "Field",
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  if (value.length < minLength) {
    return {
      valid: false,
      error: `${fieldName} must be at least ${minLength} character${minLength === 1 ? "" : "s"}`,
    };
  }
  return { valid: true, value };
}

/**
 * Validates that a string has a maximum length.
 */
export function validateMaxLength(
  value: unknown,
  maxLength: number,
  fieldName = "Field",
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  if (value.length > maxLength) {
    return {
      valid: false,
      error: `${fieldName} must be at most ${maxLength} character${maxLength === 1 ? "" : "s"}`,
    };
  }
  return { valid: true, value };
}

/**
 * Validates that a string is within a length range.
 */
export function validateLength(
  value: unknown,
  minLength: number,
  maxLength: number,
  fieldName = "Field",
): ValidationResult<string> {
  const minResult = validateMinLength(value, minLength, fieldName);
  if (!minResult.valid) {
    return minResult;
  }
  const maxResult = validateMaxLength(minResult.value, maxLength, fieldName);
  return maxResult;
}

/**
 * Validates an email address format (basic pattern, not RFC-compliant).
 */
export function validateEmail(value: unknown, fieldName = "Email"): ValidationResult<string> {
  // Basic email pattern - matches most common email formats
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return validatePattern(value, emailPattern, `${fieldName} must be a valid email address`);
}

/**
 * Validates a URL format (restricted to http/https protocols).
 */
export function validateUrl(value: unknown, fieldName = "URL"): ValidationResult<string> {
  try {
    if (typeof value !== "string") {
      return { valid: false, error: `${fieldName} must be a string` };
    }
    const url = new URL(value);
    // Only allow http and https protocols for security
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { valid: false, error: `${fieldName} must use http or https protocol` };
    }
    return { valid: true, value };
  } catch {
    return { valid: false, error: `${fieldName} must be a valid URL` };
  }
}

/**
 * Validates that a value is one of the allowed options.
 */
export function validateOneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  fieldName = "Field",
): ValidationResult<T> {
  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  if (!options.includes(value as T)) {
    const optionsList = options.map((opt) => `"${opt}"`).join(", ");
    return {
      valid: false,
      error: `${fieldName} must be one of: ${optionsList}`,
    };
  }
  return { valid: true, value: value as T };
}

/**
 * Validates multiple rules in sequence, returning the first error.
 */
export function validateAll(
  value: unknown,
  validators: Array<(val: unknown) => ValidationResult>,
): ValidationResult<unknown> {
  if (validators.length === 0) {
    return { valid: true, value };
  }
  for (const validator of validators) {
    const result = validator(value);
    if (!result.valid) {
      return result;
    }
    // Update value for next validator (in case it transforms it)
    value = result.value;
  }
  // All validators passed; return the final transformed value
  return { valid: true, value };
}

/**
 * Validates that a number is within a range.
 */
export function validateNumberRange(
  value: unknown,
  min: number,
  max: number,
  fieldName = "Number",
): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { valid: false, error: `${fieldName} must be a finite number` };
  }
  if (value < min || value > max) {
    return {
      valid: false,
      error: `${fieldName} must be between ${min} and ${max}`,
    };
  }
  return { valid: true, value };
}

/**
 * Validates that a value is a positive integer.
 */
export function validatePositiveInteger(
  value: unknown,
  fieldName = "Number",
): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { valid: false, error: `${fieldName} must be an integer` };
  }
  if (value <= 0) {
    return { valid: false, error: `${fieldName} must be a positive integer` };
  }
  return { valid: true, value };
}
