// Verifies web-search credential presence checks for plugins.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const manifestMocks = vi.hoisted(() => ({
  loadManifestMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: manifestMocks.loadManifestMetadataSnapshot,
}));

let hasConfiguredWebSearchCredential: typeof import("./web-search-credential-presence.js").hasConfiguredWebSearchCredential;

beforeAll(async () => {
  ({ hasConfiguredWebSearchCredential } = await import("./web-search-credential-presence.js"));
});

describe("hasConfiguredWebSearchCredential", () => {
  beforeEach(() => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("does not statically import web-search runtime providers", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/plugins/web-search-credential-presence.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*web-search-providers\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*loader\.js["']/);
  });

  it("keeps empty config and env on the manifest-only path", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("detects configured web search credential candidates without runtime loading", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "brave-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("ignores provider selection and non-credential search options", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
                maxResults: 5,
                openaiCodex: true,
                google: {
                  baseUrl: "https://search.example.test",
                  mode: "serp",
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("requires env SecretRefs to resolve before reporting a configured credential", () => {
    const config = {
      tools: {
        web: {
          search: {
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: { BRAVE_API_KEY: "brave-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("requires legacy env SecretRef strings to resolve before reporting a credential", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "${GOOGLE_SEARCH_API_KEY}" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "secretref-env:GOOGLE_SEARCH_API_KEY" } } },
        } as OpenClawConfig,
        env: { GOOGLE_SEARCH_API_KEY: "google-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("treats non-env SecretRefs and nested provider apiKeys as configured credentials", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                google: {
                  apiKey: {
                    source: "file",
                    provider: "default",
                    id: "/run/secrets/google-search-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("checks plugin webSearch apiKey with the same SecretRef semantics", () => {
    const config = {
      plugins: {
        entries: {
          custom: {
            config: {
              webSearch: {
                apiKey: { source: "env", id: "CUSTOM_SEARCH_API_KEY" },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: { CUSTOM_SEARCH_API_KEY: "custom-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("treats manifest env var values as resolved literal credentials", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
          setup: { providers: [{ envVars: ["BRAVE_API_KEY"] }] },
          providerAuthEnvVars: {},
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: { BRAVE_API_KEY: "$BRAVE_API_KEY" },
        origin: "bundled",
      }),
    ).toBe(true);
  });
});
