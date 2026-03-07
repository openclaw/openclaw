import { describe, expect, it } from "vitest";
import { EnvSecretProvider } from "./env-secret-provider.js";

describe("EnvSecretProvider", () => {
  it("resolves a secret from the environment", async () => {
    const provider = new EnvSecretProvider({ MY_SECRET: "hunter2" });
    expect(await provider.getSecret("MY_SECRET")).toBe("hunter2");
  });

  it("throws for missing env var", async () => {
    const provider = new EnvSecretProvider({});
    await expect(provider.getSecret("MISSING")).rejects.toThrow("not set or empty");
  });

  it("throws for empty env var", async () => {
    const provider = new EnvSecretProvider({ EMPTY: "" });
    await expect(provider.getSecret("EMPTY")).rejects.toThrow("not set or empty");
  });

  it("lists environment variable names", async () => {
    const provider = new EnvSecretProvider({ B_KEY: "b", A_KEY: "a" });
    const list = await provider.listSecrets();
    expect(list).toEqual(["A_KEY", "B_KEY"]);
  });

  it("setSecret throws (read-only)", async () => {
    const provider = new EnvSecretProvider({});
    await expect(provider.setSecret("X", "Y")).rejects.toThrow("does not support writing");
  });

  it("testConnection always returns ok", async () => {
    const provider = new EnvSecretProvider({});
    expect(await provider.testConnection()).toEqual({ ok: true });
  });
});
