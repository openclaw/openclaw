import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("mixed SecretRef failures", () => {
  it.each([
    { separateProviders: false, redactedFirst: false },
    { separateProviders: false, redactedFirst: true },
    { separateProviders: true, redactedFirst: false },
    { separateProviders: true, redactedFirst: true },
  ])(
    "makes only the redacted owner cold with $separateProviders separate providers and $redactedFirst redacted first",
    async ({ separateProviders, redactedFirst }) => {
      const missingRef = { source: "env", provider: "default", id: "MISSING_KEY" } as const;
      const redactedRef = {
        source: "env",
        provider: separateProviders ? "other" : "default",
        id: "REDACTED_KEY",
      } as const;
      const healthyRef = { source: "env", provider: "default", id: "HEALTHY_KEY" } as const;
      const firstRef = redactedFirst ? redactedRef : missingRef;
      const secondRef = redactedFirst ? missingRef : redactedRef;
      const config = asConfig({
        agents: { list: [{ id: "main", default: true }] },
        secrets: { providers: { other: { source: "env" } } },
        models: {
          providers: {
            mixed: {
              apiKey: firstRef,
              headers: { "X-Secret": secondRef },
              baseUrl: "https://mixed.example.invalid/v1",
              models: [],
            },
            missing: {
              apiKey: missingRef,
              baseUrl: "https://missing.example.invalid/v1",
              models: [],
            },
            healthy: {
              apiKey: healthyRef,
              baseUrl: "https://healthy.example.invalid/v1",
              models: [],
            },
          },
        },
      });
      const options = {
        config,
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: new Map(),
      };
      const active = await prepareSecretsRuntimeSnapshot({
        ...options,
        env: {
          MISSING_KEY: "missing-old",
          REDACTED_KEY: "redacted-old",
          HEALTHY_KEY: "healthy-old",
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: active,
        refreshContext: null,
        refreshHandler: null,
      });

      const candidate = await prepareSecretsRuntimeSnapshot({
        ...options,
        env: { REDACTED_KEY: REDACTED_SENTINEL, HEALTHY_KEY: "healthy-new" },
      });

      expect(candidate.config.models?.providers?.mixed?.apiKey).toEqual(firstRef);
      expect(candidate.config.models?.providers?.mixed?.headers?.["X-Secret"]).toEqual(secondRef);
      expect(candidate.config.models?.providers?.missing?.apiKey).toBe("missing-old");
      expect(candidate.config.models?.providers?.healthy?.apiKey).toBe("healthy-new");
      expect(candidate.degradedOwners).toMatchObject([
        {
          ownerId: "mixed",
          degradationState: "cold",
          reason: "resolved secret value is a redaction placeholder",
        },
        { ownerId: "missing", degradationState: "stale", reason: "secret reference was not found" },
      ]);
      expect(candidate.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SECRETS_OWNER_UNAVAILABLE",
            message: expect.stringContaining("resolved secret value is a redaction placeholder"),
          }),
        ]),
      );
    },
  );
});
