import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ObservationDataset } from "./dataset.js";
import { type IWorldModel, type WorldModelAction, type WorldModelState } from "./types.js";

const log = createSubsystemLogger("world-model");

/**
 * A simple logging world model for demonstration and data collection.
 */
class LoggingWorldModel implements IWorldModel {
  async observe(state: WorldModelState, action: WorldModelAction): Promise<void> {
    let details = "";
    if (action.type === "message_start") {
      details = `Role=${action.role}`;
    } else if (action.type === "message_end") {
      details = `Role=${action.role} ContentLength=${typeof action.content === "string" ? action.content.length : 0}`;
    } else if (action.type === "tool_call") {
      details = `Tool=${action.toolName} Args=${JSON.stringify(action.toolArgs)}`;
    } else if (action.type === "tool_execution_end") {
      details = `Tool=${action.toolName} CallId=${action.toolCallId} Success=${!action.isError}`;
    } else {
      details = `ContentLength=${typeof action.content === "string" ? action.content.length : 0}`;
    }
    log.info(`[WorldModel] Observation: Type=${action.type} ${details}`);
  }

  async predict(_state: WorldModelState): Promise<WorldModelAction[]> {
    // No-op for logging model
    return [];
  }

  async simulate(state: WorldModelState, action: WorldModelAction): Promise<WorldModelState> {
    // Mock simulation: just returns the same state with a "simulated" flag context
    return {
      ...state,
      context: (state.context || "") + ` [Simulated consequence of ${action.type}]`,
    };
  }
}

export class WorldModelManager {
  private static instance: WorldModelManager;
  private activeModel: IWorldModel | undefined;
  private minConfidence: number = 0;
  private dataset: ObservationDataset | undefined;

  // Reality Check State
  private predictionBuffer: { actions: WorldModelAction[]; timestamp: number }[] = [];
  private trustScore: number = 1.0; // Starts at 100% trust
  private readonly MAX_HISTORY = 10;
  private readonly TRUST_DECAY = 0.05; // Penalty for miss
  private readonly TRUST_BOOST = 0.01; // Reward for hit

  private constructor() {}

  static getInstance(): WorldModelManager {
    if (!WorldModelManager.instance) {
      WorldModelManager.instance = new WorldModelManager();
    }
    return WorldModelManager.instance;
  }

  getDataset(): ObservationDataset | undefined {
    return this.dataset;
  }

  getTrustScore(): number {
    return this.trustScore;
  }

  getActiveModel(): IWorldModel | undefined {
    return this.activeModel;
  }

  async initialize(config: OpenClawConfig) {
    const wmConfig = config.worldModel;
    if (wmConfig?.enabled) {
      this.minConfidence = wmConfig.minConfidence ?? 0;

      // Always initialize dataset collector for training data
      const dataDir = wmConfig.dataDir ?? ".";
      this.dataset = new ObservationDataset(dataDir);
      log.info(`Dataset collector initialized at ${dataDir}`);

      log.info(`Initializing World Model (Provider: ${wmConfig.provider})`);
      if (wmConfig.provider === "logging") {
        this.activeModel = new LoggingWorldModel();
      } else if (wmConfig.provider === "llm") {
        const modelStr = wmConfig.model ?? "google/gemini-1.5-pro";
        const parts = modelStr.split("/");
        const provider = parts.length > 1 ? parts[0] : "google";
        const modelId = parts.length > 1 ? parts.slice(1).join("/") : parts[0];

        const { LLMWorldModel } = await import("./llm-provider.js");
        this.activeModel = new LLMWorldModel(config, provider, modelId);
      } else if (wmConfig.provider === "lstm") {
        const { LSTMWorldModel } = await import("./lstm-provider.js");
        const lstmModel = new LSTMWorldModel({
          latentDim: wmConfig.lstm?.latentDim ?? 128,
          hiddenDim: wmConfig.lstm?.hiddenDim ?? 256,
          actionVocabSize: wmConfig.lstm?.actionVocabSize ?? 64,
          weightsPath: wmConfig.lstm?.weightsPath,
        });
        await lstmModel.initialize();
        this.activeModel = lstmModel;
      } else {
        log.warn(`Unknown World Model provider: ${wmConfig.provider}. Defaulting to disabled.`);
      }
    } else {
      log.info("World Model is disabled.");
    }
  }

  async observe(state: WorldModelState, action: WorldModelAction): Promise<void> {
    // Reality Check: Did we predict this?
    if (this.predictionBuffer.length > 0) {
      const lastPrediction = this.predictionBuffer[this.predictionBuffer.length - 1];
      // Simple heuristic: Check if ANY predicted action matches the observed action type/tool
      const match = lastPrediction.actions.find((p) => {
        if (p.type !== action.type) {
          return false;
        }
        if (action.type === "tool_call") {
          return p.toolName === action.toolName;
        }
        return true; // For text, just type match is "good enough" for now
      });

      if (match) {
        this.trustScore = Math.min(1.0, this.trustScore + this.TRUST_BOOST);
        log.debug(`[RealityCheck] Prediction MATCH. Trust=${this.trustScore.toFixed(2)}`);
      } else {
        this.trustScore = Math.max(0.0, this.trustScore - this.TRUST_DECAY);
        log.debug(
          `[RealityCheck] Prediction MISS. Observed=${action.type}/${action.toolName}. Trust=${this.trustScore.toFixed(2)}`,
        );
      }
    }

    // Collect training data for LSTM dream training
    if (this.dataset) {
      try {
        this.dataset.append(state, action);
      } catch (err) {
        log.error(`Failed to append to dataset: ${String(err)}`);
      }
    }

    if (this.activeModel) {
      try {
        await this.activeModel.observe(state, action);
      } catch (err) {
        log.error(`Failed to observe world model event: ${String(err)}`);
      }
    }
  }

  async predict(state: WorldModelState): Promise<WorldModelAction[]> {
    if (this.activeModel) {
      // Dynamic Gating: If trust is too low, don't even ask the model (save cost/latency)
      // But we allow a minimum baseline to let it recover (e.g. if minConfidence is 0.5, we might still predict if trust is 0.4??)
      // Actually, let's use trustScore to Modulate minConfidence?
      // For now, strict disable if trust < 0.2 (arbitrary "broken" threshold)
      if (this.trustScore < 0.2) {
        log.warn(
          `[WorldModel] Trust too low (${this.trustScore.toFixed(2)}). Skipping prediction.`,
        );
        return [];
      }

      try {
        const actions = await this.activeModel.predict(state);

        // Store in buffer for Reality Check
        this.predictionBuffer.push({ actions, timestamp: Date.now() });
        if (this.predictionBuffer.length > this.MAX_HISTORY) {
          this.predictionBuffer.shift();
        }

        if (this.minConfidence > 0) {
          const filtered = actions.filter((a) => (a.confidence ?? 0) >= this.minConfidence);
          if (filtered.length < actions.length) {
            log.debug(
              `[WorldModel] Filtered ${actions.length - filtered.length} predictions below confidence ${this.minConfidence}`,
            );
          }
          return filtered;
        }
        return actions;
      } catch (err) {
        log.error(`Failed to predict world model action: ${String(err)}`);
      }
    }
    return [];
  }

  async simulate(state: WorldModelState, action: WorldModelAction): Promise<WorldModelState> {
    if (this.activeModel) {
      try {
        return await this.activeModel.simulate(state, action);
      } catch (err) {
        log.error(`Failed to simulate world model outcome: ${String(err)}`);
      }
    }
    // Fallback: return state as-is if no model active or error
    return state;
  }
}
