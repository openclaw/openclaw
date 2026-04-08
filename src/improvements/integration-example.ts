import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  applyAutocompact,
  DEFAULT_AUTOCOMPACT_CONFIG,
  type AutocompactConfig,
  type AutocompactRuntime,
} from "./autocompact.js";
import {
  applyMicrocompact,
  DEFAULT_MICROCOMPACT_CONFIG,
  type MicrocompactConfig,
} from "./microcompact.js";

export async function improvedMessageCompactor(params: {
  messages: AgentMessage[];
  runtime: AutocompactRuntime;
  microcompactConfig?: MicrocompactConfig;
  autocompactConfig?: AutocompactConfig;
}): Promise<AgentMessage[]> {
  const microcompacted = await applyMicrocompact(
    params.messages,
    params.microcompactConfig ?? DEFAULT_MICROCOMPACT_CONFIG,
  );
  return applyAutocompact(
    microcompacted,
    params.runtime,
    params.autocompactConfig ?? DEFAULT_AUTOCOMPACT_CONFIG,
  );
}

export function createExampleAutocompactRuntime(model: Model<Api>): AutocompactRuntime {
  return {
    model,
    summarize: async (messages) =>
      `Summarized ${messages.length} messages for ${model.provider}/${model.id}.`,
  };
}

export default {
  improvedMessageCompactor,
  createExampleAutocompactRuntime,
};
