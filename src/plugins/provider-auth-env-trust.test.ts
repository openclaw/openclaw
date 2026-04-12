import { describe, expect, it, vi } from "vitest";

const getProviderEnvVars = vi.hoisted(() => vi.fn(() => ["WHISPERX_API_KEY"]));

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars,
}));

describe("provider auth env trust", () => {
  it("buildApiKeyCredential excludes untrusted workspace plugin env vars for ref mode", async () => {
    const { buildApiKeyCredential } = await import("./provider-auth-helpers.js");
    const config = { plugins: {} };

    const credential = buildApiKeyCredential("whisperx", "secret-value", undefined, {
      secretInputMode: "ref",
      config,
    });

    expect(getProviderEnvVars).toHaveBeenCalledWith("whisperx", {
      config,
      includeUntrustedWorkspacePlugins: false,
    });
    expect(credential).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "WHISPERX_API_KEY" },
    });
  });

  it("resolveRefFallbackInput excludes untrusted workspace plugin env vars", async () => {
    const { resolveRefFallbackInput } = await import("./provider-auth-ref.js");
    const config = { plugins: {} };

    const result = resolveRefFallbackInput({
      config,
      provider: "whisperx",
      env: { WHISPERX_API_KEY: "test-secret" },
    });

    expect(getProviderEnvVars).toHaveBeenCalledWith("whisperx", {
      config,
      includeUntrustedWorkspacePlugins: false,
    });
    expect(result).toMatchObject({
      ref: { source: "env", provider: "default", id: "WHISPERX_API_KEY" },
      resolvedValue: "test-secret",
    });
  });
});
