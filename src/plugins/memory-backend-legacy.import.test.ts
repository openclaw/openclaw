import { expect, it, vi } from "vitest";
import type { MemoryProviderOpenParams } from "./memory-provider-types.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";

// mock-isolation: evaluating the real authority module would hide an eager registration import.
vi.mock("./memory-audience.js", () => {
  throw new Error("legacy memory registration loaded session audience authority");
});

it("registers without session authority and starts manager lookup immediately on open", async () => {
  const { createLegacyBackendProviderRuntime } = await import("./memory-backend-legacy.js");
  const getMemorySearchManager = vi.fn<MemoryPluginRuntime["getMemorySearchManager"]>();
  const runtime: MemoryPluginRuntime = {
    getMemorySearchManager,
    resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
  };
  const backend = createLegacyBackendProviderRuntime("legacy", runtime);
  const params: MemoryProviderOpenParams = {
    cfg: {},
    agentId: "main",
    purpose: "status",
    context: { authority: { kind: "host", operation: "status" }, assertCurrent() {} },
  };
  expect(getMemorySearchManager).not.toHaveBeenCalled();

  getMemorySearchManager.mockResolvedValueOnce({ manager: null, error: "unavailable" });
  const opened = backend.open(params);
  expect(getMemorySearchManager).toHaveBeenCalledWith({
    cfg: {},
    agentId: "main",
    purpose: "status",
  });
  expect(getMemorySearchManager.mock.contexts[0]).toBe(runtime);
  await expect(opened).resolves.toEqual({ provider: null, error: "unavailable" });

  const failure = new Error("manager failed");
  getMemorySearchManager.mockImplementationOnce(() => {
    throw failure;
  });
  await expect(backend.open(params)).rejects.toBe(failure);
});
