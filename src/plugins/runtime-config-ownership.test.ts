import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import * as sdkAlias from "./sdk-alias.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it("keeps the host LLM facade lazy, stable, and bound to current config", async () => {
  const resolveRuntime = vi
    .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
    .mockImplementation(() => {
      throw new Error("LLM facade access must not load the broad plugin runtime");
    });
  const baseUrl = "https://ollama.example.invalid";
  setRuntimeConfigSnapshot({
    models: { providers: { "ollama-cloud": { baseUrl, models: [] } } },
  });
  const runtime = createLazyPluginRuntime({ pluginSdkResolution: "src" });
  expect(runtime.config.current().models?.providers?.["ollama-cloud"]?.baseUrl).toBe(baseUrl);
  const llm = runtime.llm;
  expect(createLazyPluginRuntime({ pluginSdkResolution: "src" }).llm).not.toBe(llm);
  expect(Object.getOwnPropertyDescriptor(runtime, "llm")).toEqual({
    configurable: true,
    enumerable: true,
    get: expect.any(Function),
    set: undefined,
  });
  const target = { providerId: "ollama-cloud", baseUrl };
  await expect(llm.acquireLocalService(target)).resolves.toBeUndefined();
  expect(resolveRuntime).not.toHaveBeenCalled();

  resolveRuntime.mockRestore();
  expect(runtime.events.onAgentEvent).toBeTypeOf("function");
  expect(runtime.llm).toBe(llm);
  expect(Object.getOwnPropertyDescriptor(runtime, "llm")).toEqual({
    configurable: true,
    enumerable: true,
    get: expect.any(Function),
    set: undefined,
  });
  expect(Reflect.set(runtime, "llm", {})).toBe(false);
  expect(runtime.llm).toBe(llm);

  setRuntimeConfigSnapshot({
    models: {
      providers: {
        "ollama-cloud": {
          baseUrl: "http://127.0.0.1:11434",
          models: [],
          localService: { command: "/unused-provider-fixture" },
        },
      },
    },
  });
  await expect(runtime.llm.acquireLocalService(target)).rejects.toThrow(
    "Local endpoint must match models.providers.ollama-cloud.baseUrl",
  );

  clearRuntimeConfigSnapshot();
  await expect(runtime.llm.acquireLocalService(target)).rejects.toThrow(
    "Runtime config is not prepared",
  );
});
