import { describe, expect, it } from "vitest";
import {
  assertOwnedChildEnv,
  buildOwnedChildEnv,
  containsSecretValueInArgv,
} from "./owned-child-env.js";

describe("owned child env", () => {
  it("builds an explicit positive env without deriving tenant token from tenant id", () => {
    const env = buildOwnedChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/runtime",
        OPENAI_API_KEY: "sk-secret",
        BROKER_TENANT_TOKEN: "broker-secret",
        ROCKIELAB_TENANT_ID: "tenant-123",
        LANG: "en_US.UTF-8",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/runtime");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.BROKER_TENANT_TOKEN).toBeUndefined();
    expect(env.ROCKIELAB_TENANT_ID).toBe("tenant-123");
    expect(env.ROCKIELAB_TENANT_TOKEN).toBeUndefined();
  });

  it("preserves explicit tenant token separately from tenant id", () => {
    const env = buildOwnedChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
        ROCKIELAB_TENANT_ID: "tenant-123",
        ROCKIELAB_TENANT_TOKEN: "service-token",
      },
    });
    expect(env.ROCKIELAB_TENANT_ID).toBe("tenant-123");
    expect(env.ROCKIELAB_TENANT_TOKEN).toBe("service-token");
  });

  it("preserves explicit non-secret overrides without broadening inherited env", () => {
    const env = buildOwnedChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-secret",
        INHERITED_EXAMPLE: "drop-me",
      },
      overrides: {
        EXAMPLE: "1",
        MCP_SERVER_MODE: "stdio",
      },
    });
    expect(env.EXAMPLE).toBe("1");
    expect(env.MCP_SERVER_MODE).toBe("stdio");
    expect(env.INHERITED_EXAMPLE).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps the tenant token carve-out exact-name only", () => {
    const env = buildOwnedChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
        ROCKIELAB_TENANT_TOKEN: "service-token",
        ROCKIELAB_OTHER_TENANT_TOKEN: "other-secret",
        SERVICE_TOKEN: "service-secret",
      },
    });
    expect(env.ROCKIELAB_TENANT_TOKEN).toBe("service-token");
    expect(env.ROCKIELAB_OTHER_TENANT_TOKEN).toBeUndefined();
    expect(env.SERVICE_TOKEN).toBeUndefined();
  });

  it("drops secret-like explicit overrides except the tenant-token carve-out", () => {
    const env = buildOwnedChildEnv({
      baseEnv: { PATH: "/usr/bin" },
      overrides: {
        ROCKIELAB_TENANT_TOKEN: "service-token",
        ROCKIELAB_OTHER_TENANT_TOKEN: "other-secret",
        SERVICE_TOKEN: "service-secret",
        PASSWORD: "password",
      },
    });
    expect(env.ROCKIELAB_TENANT_TOKEN).toBe("service-token");
    expect(env.ROCKIELAB_OTHER_TENANT_TOKEN).toBeUndefined();
    expect(env.SERVICE_TOKEN).toBeUndefined();
    expect(env.PASSWORD).toBeUndefined();
  });

  it("rejects secret-like keys in explicit owned envs", () => {
    expect(() => assertOwnedChildEnv(undefined, "test")).toThrow(/explicit owned child env/);
    expect(() => assertOwnedChildEnv({ PATH: "/usr/bin", API_TOKEN: "secret" }, "test")).toThrow(
      /blocked secret-like key/,
    );
    expect(() => assertOwnedChildEnv({ PATH: "/usr/bin" }, "test")).not.toThrow();
  });

  it("detects secret values in argv", () => {
    expect(containsSecretValueInArgv(["ssh", "host", "echo safe"], ["secret-value"])).toBe(false);
    expect(containsSecretValueInArgv(["ssh", "host", "echo secret-value"], ["secret-value"])).toBe(
      true,
    );
  });
});
