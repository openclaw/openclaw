// Web search credential tests cover precedence between configured credentials,
// SecretRefs, and ambient environment fallbacks.
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { resolveWebSearchProviderCredential } from "./web-search-provider-credentials.js";

describe("resolveWebSearchProviderCredential", () => {
  it("uses configured literal credentials before ambient env fallback", () => {
    withEnv({ TEST_WEB_SEARCH_KEY: "ambient-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: "configured-test-value",
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBe("configured-test-value");
    });
  });

  it("resolves configured env SecretRefs", () => {
    withEnv({ TEST_WEB_SEARCH_REF_KEY: "ref-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: {
            source: "env",
            provider: "default",
            id: "TEST_WEB_SEARCH_REF_KEY",
          },
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBe("ref-test-value");
    });
  });

  it("does not override missing env SecretRefs with ambient env fallback", () => {
    // An explicit SecretRef means "use this credential"; falling back to a
    // different env var can silently route requests through the wrong account.
    withEnv(
      { TEST_WEB_SEARCH_REF_KEY: undefined, TEST_WEB_SEARCH_KEY: "ambient-test-value" },
      () => {
        expect(
          resolveWebSearchProviderCredential({
            credentialValue: {
              source: "env",
              provider: "default",
              id: "TEST_WEB_SEARCH_REF_KEY",
            },
            path: "tools.web.search.provider.apiKey",
            envVars: ["TEST_WEB_SEARCH_KEY"],
          }),
        ).toBeUndefined();
      },
    );
  });

  it("does not override non-env SecretRefs with ambient env fallback", () => {
    withEnv({ TEST_WEB_SEARCH_KEY: "ambient-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: {
            source: "file",
            provider: "vault",
            id: "/providers/web-search/api-key",
          },
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBeUndefined();
    });
  });

  it("falls back to ambient env when no credential is configured", () => {
    withEnv({ TEST_WEB_SEARCH_KEY: "ambient-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: undefined,
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBe("ambient-test-value");
    });
  });

  it("notifies callers when a configured env SecretRef is unavailable", () => {
    const unavailableRefs: unknown[] = [];

    expect(
      resolveWebSearchProviderCredential({
        credentialValue: {
          source: "env",
          provider: "default",
          id: "TEST_WEB_SEARCH_REF_KEY",
        },
        path: "tools.web.search.provider.apiKey",
        envVars: ["TEST_WEB_SEARCH_KEY"],
        env: { TEST_WEB_SEARCH_KEY: "ambient-test-value" },
        onUnavailableConfiguredRef: (ref) => {
          unavailableRefs.push(ref);
        },
      }),
    ).toBeUndefined();
    expect(unavailableRefs).toEqual([
      {
        source: "env",
        provider: "default",
        id: "TEST_WEB_SEARCH_REF_KEY",
      },
    ]);
  });

  it("notifies callers when a non-env SecretRef is unavailable", () => {
    expect(() =>
      resolveWebSearchProviderCredential({
        credentialValue: {
          source: "file",
          provider: "vault",
          id: "/providers/web-search/api-key",
        },
        path: "tools.web.search.provider.apiKey",
        envVars: ["TEST_WEB_SEARCH_KEY"],
        env: { TEST_WEB_SEARCH_KEY: "ambient-test-value" },
        onUnavailableConfiguredRef: (ref) => {
          throw new Error(`${ref.source}:${ref.id}`);
        },
      }),
    ).toThrow("file:/providers/web-search/api-key");
  });

  it("lets provider normalizers reject marker strings before ambient fallback", () => {
    expect(
      resolveWebSearchProviderCredential({
        credentialValue: "TEST_WEB_SEARCH_KEY",
        path: "tools.web.search.provider.apiKey",
        envVars: ["TEST_WEB_SEARCH_KEY"],
        env: { TEST_WEB_SEARCH_KEY: "ambient-test-value" },
        normalizeCredential: (value) =>
          value === "TEST_WEB_SEARCH_KEY" ? undefined : String(value),
      }),
    ).toBe("ambient-test-value");
  });
});
