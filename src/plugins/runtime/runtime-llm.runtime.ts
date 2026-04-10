import type { Message } from "@mariozechner/pi-ai";
import { loadConfig } from "../../config/config.js";
import type {
  PluginLlmCompleteParams,
  PluginLlmCompleteResult,
  PluginRuntimeCore,
} from "./types-core.js";

export function createRuntimeLlm(): PluginRuntimeCore["llm"] {
  return {
    complete: async (params: PluginLlmCompleteParams): Promise<PluginLlmCompleteResult> => {
      const [
        { prepareSimpleCompletionModelForAgent, completeWithPreparedSimpleCompletionModel },
        { resolveDefaultAgentId },
      ] = await Promise.all([
        import("../../agents/simple-completion-runtime.js"),
        import("../../agents/agent-scope.js"),
      ]);

      const cfg = loadConfig();
      const agentId = params.agentId ?? resolveDefaultAgentId(cfg);

      const prepared = await prepareSimpleCompletionModelForAgent({
        cfg,
        agentId,
        modelRef: params.model,
      });

      if ("error" in prepared) {
        throw new Error(`Plugin LLM completion failed: ${prepared.error}`);
      }

      const messages: Message[] = params.messages.map((m) =>
        m.role === "user"
          ? { role: "user" as const, content: m.content, timestamp: Date.now() }
          : {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: m.content }],
              api: prepared.model.api,
              provider: prepared.model.provider,
              model: prepared.model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop" as const,
              timestamp: Date.now(),
            },
      );

      const context = {
        systemPrompt: params.systemPrompt,
        messages,
      };

      const result = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        context,
        options: {
          maxTokens: params.maxTokens,
          signal: params.signal,
        },
      });

      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");

      return {
        text,
        usage: {
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
        },
      };
    },
  };
}
