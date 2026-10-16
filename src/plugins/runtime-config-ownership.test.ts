import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";

afterEach(() => clearRuntimeConfigSnapshot());

it("uses the host config owner for local-service acquisition in the native plugin runtime", async () => {
  const baseUrl = "https://ollama.example.invalid";
  setRuntimeConfigSnapshot({
    models: { providers: { "ollama-cloud": { baseUrl, models: [] } } },
  });
  const runtime = createLazyPluginRuntime({ pluginSdkResolution: "src" });
  expect(runtime.config.current().models?.providers?.["ollama-cloud"]?.baseUrl).toBe(baseUrl);
  const target = { providerId: "ollama-cloud", baseUrl };
  await expect(runtime.llm.acquireLocalService(target)).resolves.toBeUndefined();

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
