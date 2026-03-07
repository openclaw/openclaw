import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

describe("resolveProviderAuthOverview", () => {
  it("does not throw when token profile only has tokenRef", () => {
    const overview = resolveProviderAuthOverview({
      provider: "github-copilot",
      cfg: {},
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
        },
      } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
  });

  it("renders marker-backed models.json auth as marker detail", () => {
    const overview = resolveProviderAuthOverview({
      provider: "openai",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              apiKey: NON_ENV_SECRETREF_MARKER,
              models: [],
            },
          },
        },
      } as never,
      store: { version: 1, profiles: {} } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.effective.kind).toBe("models.json");
    expect(overview.effective.detail).toContain(`marker(${NON_ENV_SECRETREF_MARKER})`);
    expect(overview.modelsJson?.value).toContain(`marker(${NON_ENV_SECRETREF_MARKER})`);
  });

  it("keeps env-var-shaped models.json values masked to avoid accidental plaintext exposure", () => {
    const overview = resolveProviderAuthOverview({
      provider: "openai",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as never,
      store: { version: 1, profiles: {} } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.effective.kind).toBe("models.json");
    expect(overview.effective.detail).not.toContain("marker(");
    expect(overview.effective.detail).not.toContain("OPENAI_API_KEY");
  });
});
