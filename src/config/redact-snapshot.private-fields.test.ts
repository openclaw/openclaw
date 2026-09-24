import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
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
      runtimeIgnoredPaths: [["private-validation-receipt"]],
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
    expect(result).not.toHaveProperty("runtimeIgnoredPaths");
    expect(serialized).not.toContain("private-validation-receipt");
    expect(result).toMatchObject({ path: snapshot.path, hash: "abc123", exists: true, valid });
    const expectedConfig = valid
      ? { gateway: { auth: { token: REDACTED_SENTINEL } }, plugins: { allow: ["demo"] } }
      : {};
    expect(result.config).toEqual(expectedConfig);
    expect(result.sourceConfig).toEqual(expectedConfig);
    expect(snapshot).toEqual(original);
  });

  it.each([true, false])(
    "omits pre-migration credentials without mutating source (valid=%s)",
    (valid) => {
      const source = makeSnapshot({
        channels: { discord: { token: "synthetic-discord-token" } },
        models: {
          providers: {
            inline: { apiKey: "synthetic-provider-key", models: [] },
            referenced: {
              apiKey: { source: "env", provider: "default", id: "SYNTHETIC_PROVIDER_KEY" },
              models: [],
            },
          },
        },
      });
      const snapshot = {
        ...makeSnapshot({}),
        valid,
        sourceConfigBeforeMigrations: source.sourceConfig,
      };
      const before = structuredClone(snapshot);

      const result = redactConfigSnapshot(snapshot, mainSchemaHints);

      expect(snapshot).toEqual(before);
      expect(result).not.toHaveProperty("sourceConfigBeforeMigrations");
      for (const secret of [
        "synthetic-discord-token",
        "synthetic-provider-key",
        "SYNTHETIC_PROVIDER_KEY",
      ]) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    },
  );
});
