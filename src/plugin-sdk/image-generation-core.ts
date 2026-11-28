import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export {
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  resolveCapabilityModelCandidatesAsync,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
export { getProviderEnvVars } from "./provider-env-vars.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { resolveAgentModelPrimaryValue } from "../config/model-input.js";

type ImageGenerationCoreAuthRuntimeModule =
  typeof import("./image-generation-core.auth.runtime.js");

const loadImageGenerationCoreAuthRuntime = createLazyRuntimeModule(
  () => import("./image-generation-core.auth.runtime.js"),
);

/**
 * Resolve image-generation provider API keys through the lazy auth runtime helper.
 *
 * @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by
 * `plugin-sdk-private-runtime-shipped-exports`.
 */
export async function resolveApiKeyForProvider(
  ...args: Parameters<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>
): Promise<Awaited<ReturnType<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>>> {
  const runtime = await loadImageGenerationCoreAuthRuntime();
  return runtime.resolveApiKeyForProvider(...args);
}
