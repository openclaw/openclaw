import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../../config/config.js";
import { parseKmsSecretReference, resolveSecretReferenceValue } from "./kms.js";

describe("kms secret reference resolver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses kms references with query overrides", () => {
    const parsed = parseKmsSecretReference(
      "kms://OPENAI_API_KEY?projectId=proj_123&environment=prod&secretPath=/ai",
    );
    expect(parsed).toEqual({
      secretName: "OPENAI_API_KEY",
      projectId: "proj_123",
      environment: "prod",
      secretPath: "/ai",
      projectSlug: undefined,
      siteUrl: undefined,
      version: undefined,
    });
  });

  it("resolves a KMS secret using universal auth and caches the value", async () => {
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/auth/universal-auth/login")) {
        return new Response(
          JSON.stringify({
            accessToken: "kms-access-token",
            expiresIn: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v3/secrets/raw/OPENAI_API_KEY")) {
        return new Response(
          JSON.stringify({
            secret: {
              secretValue: "sk-kms-openai",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const cfg = {
      secrets: {
        backend: "kms",
        kms: {
          siteUrl: "https://kms.hanzo.ai",
          projectId: "proj_abc",
          environment: "dev",
          secretPath: "/",
          machineIdentity: {
            clientId: "machine-client-id",
            clientSecret: "machine-client-secret",
          },
          cacheTtlMs: 60_000,
        },
      },
    } as unknown as BotConfig;

    const resolved1 = await resolveSecretReferenceValue({
      value: "kms://OPENAI_API_KEY",
      cfg,
    });
    const resolved2 = await resolveSecretReferenceValue({
      value: "kms://OPENAI_API_KEY",
      cfg,
    });

    expect(resolved1).toBe("sk-kms-openai");
    expect(resolved2).toBe("sk-kms-openai");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
