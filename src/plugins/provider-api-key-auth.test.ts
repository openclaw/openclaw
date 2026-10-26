import { describe, expect, it, vi } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createProviderApiKeyAuthMethod } from "./provider-api-key-auth.js";
import type { ProviderAuthMethodNonInteractiveContext } from "./types.js";

function method(options: Partial<Parameters<typeof createProviderApiKeyAuthMethod>[0]> = {}) {
  return createProviderApiKeyAuthMethod({
    providerId: "example",
    methodId: "api-key",
    label: "Example",
    optionKey: "exampleApiKey",
    flagName: "--example-api-key",
    envVar: "EXAMPLE_API_KEY",
    promptMessage: "Example API key",
    ...options,
  });
}

function context(overrides: Partial<ProviderAuthMethodNonInteractiveContext> = {}) {
  return {
    authChoice: "example-api-key",
    config: {},
    baseConfig: {},
    opts: { exampleApiKey: "test-token" },
    runtime: createTestRuntime(),
    resolveApiKey: vi.fn(async () => ({ key: "test-token", source: "profile" as const })),
    toApiKeyCredential: vi.fn(() => null),
    ...overrides,
  };
}
const discoveredMethod = (
  resolveDefaultModel: NonNullable<Parameters<typeof method>[0]>["resolveDefaultModel"],
) => method({ defaultModel: "example/static-model", resolveDefaultModel });

describe("createProviderApiKeyAuthMethod", () => {
  it("validates before persisting non-interactive credentials through the runtime auth owner", async () => {
    await withOpenClawTestState({ label: "provider-api-key-auth" }, async (state) => {
      const credential = { type: "api_key" as const, provider: "example", key: "test-token" };
      const resolveApiKey = vi.fn(async () => ({ key: "test-token", source: "flag" as const }));
      const ctx = context({
        agentDir: state.agentDir(),
        resolveApiKey,
        toApiKeyCredential: vi.fn(() => credential),
      });
      const auth = method();
      expect(await auth.validateNonInteractive?.(ctx)).toBe(true);
      expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
      expect(resolveApiKey).toHaveBeenCalledWith({
        provider: "example",
        flagValue: "test-token",
        flagName: "--example-api-key",
        envVar: "EXAMPLE_API_KEY",
      });
      const config = await auth.runNonInteractive?.(ctx);
      expect(config?.auth?.profiles?.["example:default"]).toEqual({
        provider: "example",
        mode: "api_key",
      });
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles["example:default"],
      ).toEqual(credential);
    });
  });

  it.each([
    {
      name: "applies a key-scoped default model during non-interactive auth",
      resolveDefaultModel: async () => "example/enabled-model",
      expected: { primary: "example/enabled-model" },
    },
    {
      name: "falls back to the static model when discovery fails",
      resolveDefaultModel: async () => {
        throw new Error("catalog unavailable");
      },
      expected: { primary: "example/static-model" },
    },
    {
      name: "leaves the model unset when discovery finds no safe default",
      resolveDefaultModel: async () => undefined,
      expected: undefined,
    },
  ])("$name", async ({ resolveDefaultModel, expected }) => {
    const ctx = context();
    const config = await discoveredMethod(resolveDefaultModel).runNonInteractive?.(ctx);
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(config?.agents?.defaults?.model).toEqual(expected);
  });

  it("returns a key-scoped default model during interactive auth", async () => {
    const resolveDefaultModel = vi.fn(async () => "example/enabled-model");
    const auth = discoveredMethod(resolveDefaultModel);

    const result = await auth.run({
      config: {},
      env: {},
      opts: { exampleApiKey: "test-token" },
      prompter: { note: vi.fn() },
      runtime: createTestRuntime(),
      secretInputMode: "plaintext",
    } as never);

    expect(resolveDefaultModel).toHaveBeenCalledWith({ apiKey: "test-token", config: {} });
    expect(result.defaultModel).toBe("example/enabled-model");
  });
});
