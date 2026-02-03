/**
 * Venice API key validation during onboarding.
 *
 * Validates Venice API keys by making a test request to verify the key works.
 * Venice supports multiple key types (admin keys, inference keys) so we don't
 * filter by format - we just test if the key actually works.
 */

import { VENICE_BASE_URL } from "../agents/venice-models.js";

export interface VeniceKeyValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

/**
 * Check if the key is empty or whitespace-only.
 * We don't check format/prefix since Venice has multiple valid key types.
 *
 * @deprecated Use validateVeniceApiKey() for full validation. This function
 * only checks for empty strings and is kept for backwards compatibility.
 */
export function checkSuspiciousKeyFormat(key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return "API key is empty";
  }
  return undefined;
}

/**
 * Validate a Venice API key by making a minimal test request.
 *
 * Uses a minimal chat completion request to verify the key works.
 * This incurs a tiny cost (1 token) but is the most reliable way
 * to validate the key actually works for inference.
 *
 * Venice supports multiple key types (admin keys, inference keys) so we
 * don't filter by format - we just test if the key actually works.
 *
 * @param key - The Venice API key to validate
 * @param options - Optional configuration
 * @returns Validation result with valid status and any errors/warnings
 */
export async function validateVeniceApiKey(
  key: string,
  options?: {
    /** Timeout in milliseconds (default: 10000) */
    timeoutMs?: number;
    /** Skip the API validation and only check format (for testing) */
    skipApiCall?: boolean;
  },
): Promise<VeniceKeyValidationResult> {
  const trimmed = key.trim();

  // Check for empty key
  if (!trimmed) {
    return {
      valid: false,
      error: "API key is empty",
      warning: "Please get a valid API key from https://venice.ai/settings/api",
    };
  }

  // Skip API call if requested (for testing)
  if (options?.skipApiCall || process.env.NODE_ENV === "test" || process.env.VITEST) {
    return { valid: true };
  }

  // Make a minimal test request to validate the key
  try {
    const timeoutMs = options?.timeoutMs ?? 10000;
    const response = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.2-3b",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401) {
      return {
        valid: false,
        error: "This API key is invalid or has been revoked.",
        warning: "Please get a valid API key from https://venice.ai/settings/api",
      };
    }

    if (response.status === 403) {
      return {
        valid: false,
        error: "This API key doesn't have permission to use the inference API.",
        warning: "Please check your Venice account settings and API key permissions.",
      };
    }

    if (response.status === 429) {
      // Rate limited but key is valid
      return {
        valid: true,
        warning: "Your API key is rate limited. Consider upgrading your Venice plan.",
      };
    }

    // For other errors, we assume the key might be valid but there's a temporary issue
    // Better to let users proceed than block on transient issues
    return {
      valid: true,
      warning: `Venice API returned status ${response.status}. Key might be valid but there could be a temporary issue.`,
    };
  } catch (error) {
    // Network errors - don't block onboarding, just warn
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("timeout") || message.includes("TimeoutError")) {
      return {
        valid: true,
        warning: "Could not verify API key (request timed out). Proceeding anyway.",
      };
    }

    return {
      valid: true,
      warning: `Could not verify API key: ${message}. Proceeding anyway.`,
    };
  }
}

/**
 * Create a validation function for the prompter that validates Venice API keys.
 * Returns an error message if invalid, undefined if valid.
 */
export function createVeniceKeyValidator(options?: {
  skipApiCall?: boolean;
}): (value: string) => Promise<string | undefined> {
  return async (value: string): Promise<string | undefined> => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "API key is required";
    }

    const result = await validateVeniceApiKey(trimmed, options);

    if (!result.valid) {
      // Return the error message for the prompter
      return result.error ?? "Invalid API key";
    }

    // Valid key - no error
    return undefined;
  };
}
