import { azureFoundryChatCompletion } from "./client.js";
import { AzureFoundryModelConfig } from "./types.js";

export class AzureFoundryProvider {
  constructor(private model: AzureFoundryModelConfig) {}

  async chat(messages: unknown[], opts?: Record<string, unknown>) {
    return azureFoundryChatCompletion(this.model, messages, opts);
  }
}
