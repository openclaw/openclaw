import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

function resolveOpenAiOverview(apiKey: string) {
  return resolveProviderAuthOverview({
    provider: "openai",
    cfg: {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey,
            models: [],
          },
        },
      },
    } as never,
    store: { version: 1, profiles: {} } as never,
    modelsPath: "/tmp/models.json",
  });
}

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
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview(NON_ENV_SECRETREF_MARKER),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).toContain(`marker(${NON_ENV_SECRETREF_MARKER})`);
  });

  it("keeps env-var-shaped models.json values masked to avoid accidental plaintext exposure", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview("OPENAI_API_KEY"),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).not.toContain("marker(");
    expect(overview.modelsJson?.value).not.toContain("OPENAI_API_KEY");
  });

  it("treats env-var marker as usable only when the env key is currently resolvable", () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-from-env"; // pragma: allowlist secret
    try {
      const overview = resolveOpenAiOverview("OPENAI_API_KEY");
      expect(overview.effective.kind).toBe("env");
      expect(overview.effective.detail).not.toContain("OPENAI_API_KEY");
    } finally {
      if (prior === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prior;
      }
    }
  });
});
