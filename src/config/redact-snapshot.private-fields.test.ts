import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot } from "./redact-snapshot.test-helpers.js";

describe("redactConfigSnapshot", () => {
  it.each([true, false])("omits private snapshot fields when valid=%s", (valid) => {
    const token = "synthetic-canonical-token-canary";
    const authoredToken = "synthetic-authored-token-canary";
    const preMigrationToken = "synthetic-pre-migration-token-canary";
    const snapshot = {
      ...makeSnapshot({
        gateway: { auth: { token } },
        plugins: {
          allow: ["demo"],
        },
      }),
      valid,
      authoredConfig: { gateway: { auth: { token: authoredToken } } },
      sourceConfigBeforeMigrations: makeSnapshot({
        gateway: { auth: { token: preMigrationToken } },
      }).sourceConfig,
      pluginMetadataSnapshot: {
        manifestRegistry: {
          plugins: [
            {
              id: "demo",
              rootDir: "/private/plugin/root",
              manifestPath: "/private/plugin/root/openclaw.plugin.json",
            },
          ],
          diagnostics: [],
        },
      },
    };
    const original = structuredClone(snapshot);

    const result = redactConfigSnapshot(snapshot);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(preMigrationToken);
    expect(serialized).not.toContain(authoredToken);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("/private/plugin/root");
    expect("sourceConfigBeforeMigrations" in result).toBe(false);
    expect("authoredConfig" in result).toBe(false);
    expect("pluginMetadataSnapshot" in result).toBe(false);
    expect(result).toMatchObject({ path: snapshot.path, hash: "abc123", exists: true, valid });
    const expectedConfig = valid
      ? { gateway: { auth: { token: REDACTED_SENTINEL } }, plugins: { allow: ["demo"] } }
      : {};
    expect(result.config).toEqual(expectedConfig);
    expect(result.sourceConfig).toEqual(expectedConfig);
    expect(snapshot).toEqual(original);
  });
});
