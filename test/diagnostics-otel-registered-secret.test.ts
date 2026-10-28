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

  it.each([false, true])(
    "keeps registered prefixes masked after earlier masks shrink the export, registered=%s",
    (registered) => {
      if (registered) {
        registerSecretValueForRedaction(REGISTERED);
      }
      // Five synthetic tokens shrink 4,980 input characters to 60. The first
      // window contains only the first 40 characters of the registered value;
      // that partial value moves inside the export after the earlier masks.
      const head = `${Array.from({ length: 5 }, () => `sk-${"A1b2C3d4".repeat(124)}`).join(" ")} `;
      const text = `${head}${"x".repeat(8152 - head.length)}${REGISTERED}${"z".repeat(100_000)}`;

      const exported = normalizeOtelLogString(text, MAX_OTEL_LOG_BODY_CHARS);

      expect(exported.length).toBeLessThanOrEqual(
        MAX_OTEL_LOG_BODY_CHARS + "...(truncated)".length,
      );
      expect(exported).toContain("x".repeat(100));
      if (registered) {
        expect(exported).not.toContain("private-prefix");
        expect(exported).toContain("synthe…alue");
      } else {
        // This prefix is ordinary content when it has not been registered.
        expect(exported).toContain("private-prefix");
      }
    },
  );
});
