import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_KEY_FILE_MARKER, NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
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

  it("reports apiKeyFile-backed auth separately from models.json", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-overview-"));
    const apiKeyFile = path.join(tempDir, "openai.key");
    try {
      await fs.writeFile(apiKeyFile, "sk-openai-from-file\n", "utf8");

      const overview = resolveProviderAuthOverview({
        provider: "openai",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
                apiKeyFile,
                models: [],
              },
            },
          },
        } as never,
        store: { version: 1, profiles: {} } as never,
        modelsPath: "/tmp/models.json",
      });

      expect(overview.effective.kind).toBe("apiKeyFile");
      expect(overview.effective.detail).not.toContain("sk-openai-from-file");
      expect(overview.modelsJson?.value).toContain(`marker(${API_KEY_FILE_MARKER})`);
      expect(overview.modelsJson?.source).toBe(`apiKeyFile: ${apiKeyFile}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
