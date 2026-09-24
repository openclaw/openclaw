import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot } from "./redact-snapshot.test-helpers.js";

describe("runtime projection redaction", () => {
  it("withholds raw secrets omitted from the runtime config without changing their source", () => {
    const sourceConfig = {
      futureToken: "synthetic-future-root-credential",
      gateway: {
        port: 18789,
        auth: {
          token: "synthetic-current-credential",
          futureToken: "synthetic-future-nested-credential",
        },
      },
    };
    const runtimeConfig = {
      gateway: { port: 18789, auth: { token: sourceConfig.gateway.auth.token } },
    };
    const raw = `// Keep authored unknown fields.\n${JSON.stringify(sourceConfig)}`;
    const snapshot = { ...makeSnapshot(sourceConfig, raw), config: runtimeConfig, runtimeConfig };

    const result = redactConfigSnapshot(snapshot, mainSchemaHints);

    expect(result.raw).toBeNull();
    for (const projection of [result.parsed, result.sourceConfig, result.resolved]) {
      expect(projection).toEqual({
        futureToken: REDACTED_SENTINEL,
        gateway: {
          port: 18789,
          auth: { token: REDACTED_SENTINEL, futureToken: REDACTED_SENTINEL },
        },
      });
    }
    expect(result.config).toEqual({
      gateway: { port: 18789, auth: { token: REDACTED_SENTINEL } },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-");
    expect(snapshot.raw).toBe(raw);
    expect(snapshot.parsed).toEqual(JSON5.parse(raw));
  });
});
