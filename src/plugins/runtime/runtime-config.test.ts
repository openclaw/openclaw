// Runtime config tests cover plugin runtime config normalization and lookup.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";

const getRuntimeConfigMock = vi.fn();
const mutateConfigFileMock = vi.fn();
const replaceConfigFileMock = vi.fn();

vi.mock("../../config/io.runtime.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));

vi.mock("../../config/mutate.js", () => ({
  mutateConfigFile: (...args: unknown[]) => mutateConfigFileMock(...args),
  replaceConfigFile: (...args: unknown[]) => replaceConfigFileMock(...args),
}));

const { createRuntimeConfig } = await import("./runtime-config.js");

describe("createRuntimeConfig", () => {
  beforeEach(() => {
    getRuntimeConfigMock.mockReset();
    mutateConfigFileMock.mockReset();
    replaceConfigFileMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({ plugins: {} });
  });

  it("reads config from the runtime snapshot", () => {
    const runtimeConfig = { plugins: { entries: {} } };
    getRuntimeConfigMock.mockReturnValue(runtimeConfig);

    expect(createRuntimeConfig().current()).toBe(runtimeConfig);
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
    getRuntimeConfigMock.mockReturnValue(runtimeConfig);

    const cloned = createRuntimeConfig().current({ clone: true });
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
    const configApi = createRuntimeConfig();
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
