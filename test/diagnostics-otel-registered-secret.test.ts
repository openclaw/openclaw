import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_OTEL_LOG_BODY_CHARS,
  normalizeOtelLogString,
} from "../extensions/diagnostics-otel/test-api.js";
import { registerSecretValueForRedaction } from "../src/logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../src/logging/secret-redaction-registry.test-support.js";

// Plugins have no API that registers an arbitrary value, so this case lives at the root: the
// registered value must itself read as an open quoted secret.
const REGISTERED = 'synthetic-private-prefix password="opaque-value';

afterEach(() => {
  resetSecretRedactionRegistryForTest();
});

describe("diagnostics-otel export of a registered value that reads as an open secret", () => {
  // 20,000 characters keep the log body within the budget for redacting it whole; 100,000 put it
  // past that, where the window masks registered values before it looks for open secrets.
  it.each([20_000, 100_000])(
    "masks it whole at the start of a log body followed by %i ordinary characters",
    (tailChars) => {
      registerSecretValueForRedaction(REGISTERED);

      const exported = normalizeOtelLogString(
        `${REGISTERED}${"o".repeat(tailChars)}`,
        MAX_OTEL_LOG_BODY_CHARS,
      );

      expect(exported).not.toContain("private-prefix");
      expect(exported.startsWith("synthe…alue")).toBe(true);
      expect(exported).toContain("oooo");
    },
  );
});
