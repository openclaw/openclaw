import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "./plugin-test-api.js";

describe("createTestPluginApi", () => {
  it("exposes and allows overriding the nested authorization registrar", () => {
    expect(createTestPluginApi().authorization.registerPolicy).toBeTypeOf("function");

    const registerPolicy = vi.fn();
    const api = createTestPluginApi({ authorization: { registerPolicy } });
    const policy = {
      id: "maintainer-actions",
      description: "Maintainer actions",
      handlers: { "tool.call": () => ({ effect: "pass" as const }) },
    };

    api.authorization.registerPolicy(policy);

    expect(registerPolicy).toHaveBeenCalledExactlyOnceWith(policy);
  });
});
