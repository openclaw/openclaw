import type { OpenClawConfig } from "../../config/config.js";
import { createLazyRuntimeMethod, createLazyRuntimeSurface } from "../../shared/lazy-runtime.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeLlmFacade(getConfig: () => OpenClawConfig): PluginRuntime["llm"] {
  const loadAcquireLocalService = createLazyRuntimeMethod(
    () => import("../../agents/provider-local-service.js"),
    (runtime) => runtime.createConfiguredProviderLocalServiceAcquirer(getConfig),
  );
  const loadLlm = createLazyRuntimeSurface(
    () => import("./runtime-llm.runtime.js"),
    (m) =>
      m.createRuntimeLlm({
        getConfig,
        authority: {
          allowComplete: true,
        },
      }),
  );
  return {
    acquireLocalService: loadAcquireLocalService,
    complete: createLazyRuntimeMethod(loadLlm, (llm) => llm.complete),
  };
}
