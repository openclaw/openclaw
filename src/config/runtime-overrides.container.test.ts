import { afterEach, describe, expect, it } from "vitest";
import {
  getConfigOverrides,
  getRuntimeStateContainer,
  resetConfigOverrides,
  setConfigOverride,
  setRuntimeStateContainer,
  type RuntimeStateContainer,
} from "./runtime-overrides.js";

describe("runtime overrides container", () => {
  afterEach(() => {
    setRuntimeStateContainer(null);
    resetConfigOverrides();
  });

  it("can route overrides into an injected runtime container", () => {
    const injected: RuntimeStateContainer = {
      configOverrides: {},
    };
    setRuntimeStateContainer(injected);

    setConfigOverride("messages.responsePrefix", "[debug]");

    expect(getRuntimeStateContainer()).toBe(injected);
    expect(injected.configOverrides).toEqual({
      messages: { responsePrefix: "[debug]" },
    });
    expect(getConfigOverrides()).toBe(injected.configOverrides);
  });

  it("falls back to the default container when reset with null", () => {
    const injected: RuntimeStateContainer = {
      configOverrides: {},
    };
    setRuntimeStateContainer(injected);
    setConfigOverride("messages.responsePrefix", "[debug]");
    expect(Object.keys(injected.configOverrides)).toHaveLength(1);

    setRuntimeStateContainer(null);
    resetConfigOverrides();
    setConfigOverride("commands.debug", true);

    expect(injected.configOverrides).toEqual({
      messages: { responsePrefix: "[debug]" },
    });
    expect(getConfigOverrides()).toEqual({
      commands: { debug: true },
    });
  });
});
