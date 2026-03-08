import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { log } from "../agents/pi-embedded-runner/logger.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { type OpenClawConfig } from "../config/config.js";
import { type IWorldModel, type WorldModelAction, type WorldModelState } from "./types.js";

/**
 * World Model provider that uses an LLM to simulate physics/consequences
 * and predict future actions.
 */
export class LLMWorldModel implements IWorldModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: Model<any> | undefined;
  private apiKey: string | undefined;

  constructor(
    private config: OpenClawConfig,
    private provider: string = "google",
    private modelId: string = "gemini-1.5-pro",
  ) {}

  async initialize(): Promise<void> {
    const { model, error } = resolveModel(this.provider, this.modelId, undefined, this.config);
    if (error || !model) {
      log.error(
        `[LLMWorldModel] Failed to resolve model ${this.provider}/${this.modelId}: ${error}`,
      );
      return;
    }
    this.model = model;

    try {
      const auth = await getApiKeyForModel({ model, cfg: this.config });
      this.apiKey = auth.apiKey;
    } catch (err) {
      log.error(`[LLMWorldModel] Failed to get API key: ${String(err)}`);
    }
  }

  async observe(_state: WorldModelState, _action: WorldModelAction): Promise<void> {
    // LLM World Model currently doesn't learn online in this phase.
    // We strictly use it for inference (simulation/prediction).
    // In the future, this would add to a vector DB or fine-tuning dataset.
  }

  async predict(state: WorldModelState): Promise<WorldModelAction[]> {
    if (!this.model || !this.apiKey) {
      await this.initialize();
      if (!this.model || !this.apiKey) {
        return [];
      }
    }

    const prompt = `
You are an advanced World Model for an AI agent.
Your goal is to analyze the current state and predict the best next actions.

Current State Context:
${state.context || "No context provided"}

Recent Messages:
${JSON.stringify(state.messages?.slice(-5) || [], null, 2)}

Task:
Suggest 1-3 plausible next actions the agent could take.
For each action, provide a 'confidence' score (0.0 to 1.0) and an 'explanation'.

Response Format (JSON Array):
[
  {
    "type": "text" | "tool_call",
    "toolName": "optional_tool_name",
    "toolArgs": { ... },
    "explanation": "Why this action makes sense...",
    "confidence": 0.9
  }
]
Reply ONLY with the JSON array.
`;

    try {
      const responseText = await this.runLLM(prompt);
      const cleaned = responseText
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const actions = JSON.parse(cleaned) as WorldModelAction[];
      return actions.map((a) => ({ ...a, source: "world_model_prediction" }));
    } catch (err) {
      log.warn(`[LLMWorldModel] Prediction failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * The "Dreaming" function.
   * Predicts the state transition T(s, a) -> s'
   */
  async simulate(state: WorldModelState, action: WorldModelAction): Promise<WorldModelState> {
    if (!this.model || !this.apiKey) {
      await this.initialize();
      if (!this.model || !this.apiKey) {
        return state;
      }
    }

    const prompt = `
You are a World Model simulator (Physics Engine for AI).
Predict the IMMEDIATE consequence of the agent's action on the world state.

Current State:
${state.context || (state.messages ? "Conversation History Active" : "Empty State")}

Action Taken:
Type: ${action.type}
${action.toolName ? `Tool: ${action.toolName}` : ""}
${action.toolArgs ? `Args: ${JSON.stringify(action.toolArgs)}` : ""}
${action.content ? `Content: ${action.content}` : ""}

Task:
1. Simulate the execution of this action.
2. Describe the new state of the world (e.g., did the file get created? did the user get a reply?).
3. Assign a 'confidence' score (0.0-1.0) on how likely this outcome is.

Response Format (JSON):
{
  "nextContext": "Updated narrative description of the world state...",
  "predictedEvents": ["List of side effects..."],
  "confidence": 0.95,
  "explanation": "Standard file write operation usually succeeds..."
}
Reply ONLY with the JSON object.
`;

    try {
      const responseText = await this.runLLM(prompt);
      const cleaned = responseText
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const result = JSON.parse(cleaned);

      return {
        ...state,
        context: result.nextContext,
        // We could store predictedEvents in a new field if needed
      };
    } catch (err) {
      log.warn(`[LLMWorldModel] Simulation failed: ${String(err)}`);
      return state;
    }
  }

  private async runLLM(prompt: string): Promise<string> {
    if (!this.model || !this.apiKey) {
      throw new Error("Model not initialized");
    }

    const stream = Helpers.streamSimple(
      this.model,
      {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        apiKey: this.apiKey,
      },
    );

    let fullText = "";
    for await (const event of stream) {
      if (event.type === "done" && event.message.content) {
        // Some implementations might put full text here or in chunks
        // standard pi-ai streamSimple accumulates in chunks usually or just gives final
        // Let's assume standard accumulation handling if needed, but 'done' usually has full message
        const content = event.message.content;
        if (Array.isArray(content)) {
          fullText += content.map((c) => (c.type === "text" ? c.text : "")).join("");
        } else if (typeof content === "string") {
          fullText = content;
        }
      } else if (event.type === "error") {
        throw new Error(event.error.errorMessage);
      }
    }
    return fullText;
  }
}

// Helper to access streamSimple since it might be imported differently in environments
// We use a pragmatic approach: strict import at top, wrapper here.
class Helpers {
  static streamSimple = streamSimple;
}
