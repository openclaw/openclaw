/** Runtime SDK subpath for prepared completions and assistant text extraction. */
import type {
  PreparedSimpleCompletionModelForAgent,
  PrepareSimpleCompletionModelForAgentParams,
} from "../agents/simple-completion.types.js";
import { bindModelCompletionOwner } from "../llm/model-runtime-binding.js";
import { getLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";

export { completeWithPreparedSimpleCompletionModel } from "../agents/simple-completion-execution.js";
export { extractEmbeddedAssistantText as extractAssistantText } from "../agents/embedded-agent-utils.js";
export { runHostPreparedIsolatedCompletion } from "../agents/host-prepared-isolated-completion.js";

/** Preparation owns model/auth discovery; prepared execution must not cold-load it. */
export const prepareSimpleCompletionModelForAgent = async (
  params: PrepareSimpleCompletionModelForAgentParams,
): Promise<PreparedSimpleCompletionModelForAgent> => {
  const host = getLegacyPluginSdkResourceHost();
  return await host.track(async () => {
    const { acquireSimpleCompletionModelForAgent } =
      await import("../agents/simple-completion-runtime.js");
    host.assertOpen();
    const acquired = await acquireSimpleCompletionModelForAgent(params);
    if ("error" in acquired) {
      return acquired;
    }
    const claim = { release: async () => acquired.release() };
    try {
      host.assertOpen();
      const { release: _release, ...prepared } = acquired;
      const model = bindModelCompletionOwner(prepared.model, {
        run: (run) => host.track(run),
        assertCurrent: () => host.assertOpen(),
      });
      host.adopt(model, claim);
      return { ...prepared, model };
    } catch (error) {
      host.releaseClaim(claim);
      throw error;
    }
  });
};
