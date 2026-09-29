import { getPreparedModelRuntimeMocks } from "../agents/prepared-model-runtime.test-harness.js";

const mocks = getPreparedModelRuntimeMocks();

export const model = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "openai",
  api: "openai-chatgpt-responses" as const,
};
export function configureAuthFixture(
  kind: "secret-ref" | "external-oauth" | "unresolved-secret-ref",
  catalogAuthRejected = false,
) {
  if (kind === "external-oauth") {
    return;
  }
  const apiKeyModel = { ...model, api: "openai-responses" as const };
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [apiKeyModel],
    routeVariants: [apiKeyModel],
    ...(catalogAuthRejected
      ? {
          providerOutcomes: [
            {
              provider: "openai",
              profileId: "openai:default",
              rejectionScope: "catalog",
              status: "auth-rejected",
            },
          ],
        }
      : {}),
  });
  mocks.authStorage.getAll.mockReturnValue({
    openai: { type: "api_key", key: "openclaw-secret-ref-configured" },
  });
  mocks.preparedAuthStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "file", provider: "round4-file", id: "value" },
        ...(kind === "secret-ref" ? { key: "resolved-at-runtime" } : {}),
      },
    },
  };
}

export function configureHarnessOwnedUnresolvedAuth() {
  mocks.authStorage.getAll.mockReturnValue({
    openai: { type: "api_key", key: "openclaw-secret-ref-configured" },
  });
  mocks.preparedAuthStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  };
}
