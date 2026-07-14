// Verifies shared SecretRef env-fallback diagnostics.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSecretRefEnvFallbackDiagnostics } from "./secretref-env-fallback-diagnostics.js";

vi.mock("./runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async () => ({
    sourceConfig: {},
    config: {},
    authStores: [],
    warnings: [
      {
        code: "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
        path: "plugins.entries.google.config.webSearch.apiKey",
        message: "web search provider fell back to environment credentials",
      },
    ],
    webTools: {},
  })),
}));

describe("collectSecretRefEnvFallbackDiagnostics", () => {
  it("flags gateway token SecretRef env fallback", async () => {
    const diagnostics = await collectSecretRefEnvFallbackDiagnostics({
      cfg: {
        gateway: {
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "MISSING_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } satisfies OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      } as NodeJS.ProcessEnv,
    });

    expect(
      diagnostics.some(
        (entry) =>
          entry.code === "GATEWAY_AUTH_TOKEN_SECRETREF_ENV_FALLBACK" &&
          entry.path === "gateway.auth.token",
      ),
    ).toBe(true);
  });

  it("includes runtime web-tool fallback warnings only when allowExec is enabled", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");
    const mockedPrepare = vi.mocked(prepareSecretsRuntimeSnapshot);
    mockedPrepare.mockClear();

    const withoutAllowExec = await collectSecretRefEnvFallbackDiagnostics({
      cfg: {} satisfies OpenClawConfig,
    });
    expect(
      withoutAllowExec.some((entry) => entry.code === "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED"),
    ).toBe(false);
    expect(mockedPrepare).not.toHaveBeenCalled();

    const withAllowExec = await collectSecretRefEnvFallbackDiagnostics({
      cfg: {} satisfies OpenClawConfig,
      allowExec: true,
    });
    expect(
      withAllowExec.some((entry) => entry.code === "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED"),
    ).toBe(true);
    expect(mockedPrepare).toHaveBeenCalledOnce();
  });

  it("skips gateway token fallback when auth mode is password", async () => {
    const diagnostics = await collectSecretRefEnvFallbackDiagnostics({
      cfg: {
        gateway: {
          auth: {
            mode: "password",
            token: {
              source: "env",
              provider: "default",
              id: "MISSING_GATEWAY_TOKEN",
            },
            password: "local-password",
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } satisfies OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      } as NodeJS.ProcessEnv,
    });

    expect(
      diagnostics.some((entry) => entry.code === "GATEWAY_AUTH_TOKEN_SECRETREF_ENV_FALLBACK"),
    ).toBe(false);
  });

  it("returns empty diagnostics when SecretRef resolves normally", async () => {
    const diagnostics = await collectSecretRefEnvFallbackDiagnostics({
      cfg: {
        gateway: {
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "CUSTOM_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } satisfies OpenClawConfig,
      env: {
        CUSTOM_GATEWAY_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
    });

    expect(
      diagnostics.some((entry) => entry.code === "GATEWAY_AUTH_TOKEN_SECRETREF_ENV_FALLBACK"),
    ).toBe(false);
  });
});
