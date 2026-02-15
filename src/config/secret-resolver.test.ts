import { describe, expect, it, vi } from "vitest";
import { resolveConfigSecrets, SecretResolutionError } from "./secret-resolver.js";

describe("resolveConfigSecrets", () => {
  it("resolves op:// references recursively", () => {
    const exec = vi.fn().mockReturnValue("secret-value\n");
    const resolved = resolveConfigSecrets(
      {
        models: {
          providers: {
            openrouter: { apiKey: "op://Private/OpenRouter/token" },
          },
        },
      },
      { exec: exec as never },
    ) as {
      models: { providers: { openrouter: { apiKey: string } } };
    };
    expect(resolved.models.providers.openrouter.apiKey).toBe("secret-value");
    expect(exec).toHaveBeenCalledWith(
      "op",
      ["read", "op://Private/OpenRouter/token"],
      expect.anything(),
    );
  });

  it("resolves vault://path#field references", () => {
    const exec = vi.fn().mockReturnValue("vault-secret");
    const resolved = resolveConfigSecrets(
      { gateway: { auth: { token: "vault://kv/openclaw#token" } } },
      { exec: exec as never },
    ) as {
      gateway: { auth: { token: string } };
    };
    expect(resolved.gateway.auth.token).toBe("vault-secret");
    expect(exec).toHaveBeenCalledWith(
      "vault",
      ["kv", "get", "-field=token", "kv/openclaw"],
      expect.anything(),
    );
  });

  it("throws SecretResolutionError with path context", () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() =>
      resolveConfigSecrets(
        { auth: { key: "op://private/missing/field" } },
        { exec: exec as never },
      ),
    ).toThrow(SecretResolutionError);
  });
});
