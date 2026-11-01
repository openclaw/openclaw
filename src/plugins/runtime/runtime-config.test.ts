// Runtime config tests cover plugin runtime config normalization and lookup.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";

const mutateConfigFileMock = vi.fn();
const replaceConfigFileMock = vi.fn();

vi.mock("../../config/mutate.js", () => ({
  mutateConfigFile: (...args: unknown[]) => mutateConfigFileMock(...args),
  replaceConfigFile: (...args: unknown[]) => replaceConfigFileMock(...args),
}));

const { createRuntimeSystem } = await import("./runtime-system.js");
const { createRuntimeBase } = await import("./runtime-base.js");

describe("plugin runtime config", () => {
  afterEach(clearRuntimeConfigSnapshot);
  beforeEach(() => {
    mutateConfigFileMock.mockReset();
    replaceConfigFileMock.mockReset();
    setRuntimeConfigSnapshot({ plugins: {} });
  });

  it("reads config from the runtime snapshot", () => {
    const runtimeConfig = { plugins: { entries: {} } };
    setRuntimeConfigSnapshot(runtimeConfig);

    expect(createRuntimeBase(createRuntimeSystem).config.current()).toBe(runtimeConfig);
  });

  it("clones mutable config without losing its resolved secret facts", () => {
    const runtimeConfig = { env: { vars: { FIXTURE_API_KEY: "synthetic-key" } } };
    const configPath = "env.vars.FIXTURE_API_KEY";
    setConfigResolutionFacts(
      runtimeConfig,
      createConfigResolutionFacts(
        [],
        new Map(),
        undefined,
        new Map([[configPath, "FIXTURE_API_KEY"]]),
      ),
    );
    setRuntimeConfigSnapshot(runtimeConfig);

    const cloned = createRuntimeBase(createRuntimeSystem).config.current({ clone: true });
    expectDefined(cloned.env?.vars, "cloned config variables").FIXTURE_API_KEY = "changed";

    expect(runtimeConfig.env.vars.FIXTURE_API_KEY).toBe("synthetic-key");
    expect(getResolvedConfigEnvSecretRef(cloned, configPath)).toEqual({
      source: "env",
      provider: "default",
      id: "FIXTURE_API_KEY",
    });
  });

  it("exposes canonical mutation helpers", async () => {
    mutateConfigFileMock.mockResolvedValue({ result: "updated" });
    replaceConfigFileMock.mockResolvedValue({ persistedHash: "hash" });
    const configApi = createRuntimeBase(createRuntimeSystem).config;
    const mutateParams = { mutate: vi.fn() };
    const replaceParams = { nextConfig: { plugins: {} } };

    await expect(configApi.mutateConfigFile(mutateParams as never)).resolves.toEqual({
      result: "updated",
    });
    await expect(configApi.replaceConfigFile(replaceParams as never)).resolves.toEqual({
      persistedHash: "hash",
    });
    expect(mutateConfigFileMock).toHaveBeenCalledWith(mutateParams);
    expect(replaceConfigFileMock).toHaveBeenCalledWith(replaceParams);
  });
});
