import { describe, expect, it } from "vitest";
import {
  assertOwnedChildEnv,
  buildOwnedChildEnv,
  containsSecretValueInArgv,
} from "./owned-child-env.js";

describe("owned child env", () => {
  it("builds an explicit positive env and derives tenant token only from tenant id", () => {
    const env = buildOwnedChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/runtime",
        OPENAI_API_KEY: "sk-secret",
        BROKER_TENANT_TOKEN: "broker-secret",
        ROCKIELAB_TENANT_TOKEN: "legacy-token",
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
    expect(env.ROCKIELAB_TENANT_TOKEN).toBe("tenant-123");
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
