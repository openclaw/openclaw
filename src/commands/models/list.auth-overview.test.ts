import { describe, expect, it, vi } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import { withEnvAsync } from "../../test-utils/env.js";

const resolveProviderSyntheticAuthWithPluginMock = vi.hoisted(() =>
  vi
    .fn<
      typeof import("../../plugins/provider-runtime.runtime.js").resolveProviderSyntheticAuthWithPlugin
    >()
    .mockResolvedValue(undefined),
);

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: resolveProviderSyntheticAuthWithPluginMock,
}));

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
  it("does not throw when token profile only has tokenRef", async () => {
    const overview = await resolveProviderAuthOverview({
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

  it("renders marker-backed models.json auth as marker detail", async () => {
    const overview = await withEnvAsync({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview(NON_ENV_SECRETREF_MARKER),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).toContain(`marker(${NON_ENV_SECRETREF_MARKER})`);
  });

  it("keeps env-var-shaped models.json values masked to avoid accidental plaintext exposure", async () => {
    const overview = await withEnvAsync({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview("OPENAI_API_KEY"),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).not.toContain("marker(");
    expect(overview.modelsJson?.value).not.toContain("OPENAI_API_KEY");
  });

  it("treats env-var marker as usable only when the env key is currently resolvable", async () => {
    await withEnvAsync(
      { OPENAI_API_KEY: "sk-openai-from-env" }, // pragma: allowlist secret
      async () => {
        const overview = await resolveOpenAiOverview("OPENAI_API_KEY");
        expect(overview.effective.kind).toBe("env");
        expect(overview.effective.detail).not.toContain("OPENAI_API_KEY");
      },
    );
  });

  it("reports plugin-owned synthetic auth when no store or env auth exists", async () => {
    resolveProviderSyntheticAuthWithPluginMock.mockResolvedValueOnce({
      apiKey: "codex-app-server",
      source: "codex-app-server",
      mode: "token",
    });

    const overview = await resolveProviderAuthOverview({
      provider: "codex",
      cfg: {},
      store: { version: 1, profiles: {} } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.effective).toEqual({
      kind: "synthetic",
      detail: "token:codex-app-server",
    });
    expect(overview.synthetic).toEqual({
      mode: "token",
      source: "codex-app-server",
    });
  });
});
