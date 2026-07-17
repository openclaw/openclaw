import { describe, expect, it, vi } from "vitest";
import { buildPluginApi } from "./api-builder.js";
import type { AuthorizationPolicyRegistration } from "./authorization-policy.types.js";
import { runPluginRegisterSync } from "./loader-module-runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

const policy: AuthorizationPolicyRegistration = {
  id: "maintainer-actions",
  description: "Limit maintainer actions",
  handlers: { "tool.call": () => ({ effect: "pass" }) },
};

function buildApi(registerAuthorizationPolicy: (value: AuthorizationPolicyRegistration) => void) {
  return buildPluginApi({
    id: "sender-access",
    name: "Sender Access",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {} as PluginRuntime,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resolvePath: (input) => input,
    handlers: { registerAuthorizationPolicy },
  });
}

describe("plugin registration lifetime", () => {
  it("closes a saved nested authorization registrar after registration", () => {
    const registerAuthorizationPolicy = vi.fn();
    const api = buildApi(registerAuthorizationPolicy);
    let savedRegistrar: ((value: AuthorizationPolicyRegistration) => void) | undefined;

    runPluginRegisterSync((pluginApi) => {
      savedRegistrar = pluginApi.authorization.registerPolicy;
      pluginApi.authorization.registerPolicy(policy);
    }, api);
    savedRegistrar?.({ ...policy, id: "late-policy" });

    expect(registerAuthorizationPolicy).toHaveBeenCalledOnce();
    expect(registerAuthorizationPolicy).toHaveBeenCalledWith(policy);
  });

  it("blocks nested authorization registration after an async register yields", async () => {
    const registerAuthorizationPolicy = vi.fn();
    const api = buildApi(registerAuthorizationPolicy);

    expect(() =>
      runPluginRegisterSync((pluginApi) => {
        const lateRegistration = Promise.resolve().then(() => {
          pluginApi.authorization.registerPolicy(policy);
        });
        return lateRegistration as unknown as void;
      }, api),
    ).toThrow("plugin register must be synchronous");
    await Promise.resolve();

    expect(registerAuthorizationPolicy).not.toHaveBeenCalled();
  });
});
