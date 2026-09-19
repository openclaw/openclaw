// Matrix account SecretRef redaction through generated channel metadata.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchemaCore } from "./schema.js";

describe("Matrix account SecretRef generated-metadata redaction", () => {
  it("preserves account SecretRef identity via generated channel metadata hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    expect(hints["channels.matrix.accounts.*.password"]?.sensitive).toBe(true);
    expect(hints["channels.matrix.accounts.*.accessToken"]?.sensitive).toBe(true);

    const snapshot = makeSnapshot({
      channels: {
        matrix: {
          accounts: {
            work: {
              password: {
                source: "store",
                provider: "default",
                id: "MATRIX_WORK_PASSWORD",
              },
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<
      string,
      { accounts?: Record<string, { password?: Record<string, string> }> }
    >;
    const password = expectDefined(
      channels.matrix?.accounts?.work?.password,
      "matrix account password",
    );
    expect(password).toEqual({
      source: "store",
      provider: "default",
      id: REDACTED_SENTINEL,
    });

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.channels.matrix.accounts.work.password).toEqual({
      source: "store",
      provider: "default",
      id: "MATRIX_WORK_PASSWORD",
    });
  });
});
