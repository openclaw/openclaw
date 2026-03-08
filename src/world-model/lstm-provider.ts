/**
 * LSTM World Model Provider — The Cerebellum
 *
 * Implements IWorldModel using a real LSTM neural network instead of an LLM.
 * This is the lightweight, always-on "involuntary" brain that:
 *
 *   1. Observes agent actions in real-time (like the cerebellum observes motor commands)
 *   2. Predicts what the user will do next (fast LSTM forward pass, not expensive LLM call)
 *   3. Simulates "what if" scenarios by rolling forward in latent space (dreaming)
 *
 * Architecture (Ha & Schmidhuber, 2018):
 *   Encoder (V): text → z ∈ ℝ^latentDim
 *   LSTM (M): (z_t, a_t) → z_{t+1}
 *   Decoder (C): z → action prediction
 *
 * The LSTM weights are trained offline during "sleep" by the DreamTrainer.
 * At runtime, it only does fast forward passes — no gradient computation.
 */

import fs from "node:fs";
import path from "node:path";
import { StateActionEncoder } from "./encoder.js";
import { LSTMCell, type LSTMHiddenState } from "./lstm.js";
import { type IWorldModel, type WorldModelAction, type WorldModelState } from "./types.js";

export interface LSTMWorldModelConfig {
  latentDim?: number;
  hiddenDim?: number;
  actionVocabSize?: number;
  weightsPath?: string;
}

/** Serialized checkpoint format */
interface Checkpoint {
  version: number;
  encoder: ReturnType<StateActionEncoder["serialize"]>;
  lstm: Record<string, number[]>;
  toolVocab: string[];
  config: { latentDim: number; hiddenDim: number };
  trainedAt?: string;
  epoch?: number;
}

export class LSTMWorldModel implements IWorldModel {
  private encoder: StateActionEncoder;
  private lstm: LSTMCell;
  private hiddenState: LSTMHiddenState;
  private readonly latentDim: number;
  private readonly hiddenDim: number;
  private weightsPath?: string;

  /** Observed tool names — builds vocabulary for decoding predictions */
  private toolVocab: Set<string> = new Set();

  /** Rolling hidden state per session for contextual predictions */
  private sessionStates: Map<string, LSTMHiddenState> = new Map();

  constructor(config: LSTMWorldModelConfig = {}) {
    this.latentDim = config.latentDim ?? 128;
    this.hiddenDim = config.hiddenDim ?? 256;
    this.weightsPath = config.weightsPath;

    const vocabSize = config.actionVocabSize ?? 4096;

    // V component: State/Action Encoder
    this.encoder = new StateActionEncoder(vocabSize, this.latentDim);

    // M component: LSTM
    // Input = concatenated [state_latent; action_latent] = 2 * latentDim
    // Output = predicted next state latent = latentDim
    this.lstm = new LSTMCell(this.latentDim * 2, this.hiddenDim, this.latentDim);

    // Default hidden state
    this.hiddenState = this.lstm.initHidden();
  }

  async initialize(): Promise<void> {
    if (this.weightsPath) {
      await this.loadCheckpoint(this.weightsPath);
    }
  }

  /**
   * Observe: Feed the observation through the LSTM to update hidden state.
   * This keeps the LSTM's "memory" current with what's happening in the session.
   * Like the cerebellum continuously tracking motor state.
   */
  async observe(state: WorldModelState, action: WorldModelAction): Promise<void> {
    // Track tool names for decoder vocabulary
    if (action.toolName) {
      this.toolVocab.add(action.toolName);
    }

    // Encode current state and action
    const zState = this.encoder.encodeState(state);
    const zAction = this.encoder.encodeAction(action);

    // Concatenate [z_state; z_action] as LSTM input
    const input = new Float64Array(this.latentDim * 2);
    input.set(zState, 0);
    input.set(zAction, this.latentDim);

    // Get session-specific hidden state
    const sessionId = state.sessionId ?? "default";
    const sessionState = this.sessionStates.get(sessionId) ?? this.lstm.initHidden();

    // Forward pass (inference only, no backprop)
    const { state: newHidden } = this.lstm.forward(input, sessionState);
    this.sessionStates.set(sessionId, newHidden);
    this.hiddenState = newHidden;
  }

  /**
   * Predict: Use the LSTM's current hidden state to predict the next action.
   * The hidden state h_t encodes the temporal context — what's been happening.
   * The output projection maps h_t to a predicted next-state latent vector,
   * which the decoder converts back to an action type + tool name.
   */
  async predict(state: WorldModelState): Promise<WorldModelAction[]> {
    const zState = this.encoder.encodeState(state);

    // Use a "null action" encoding to ask "what happens next?"
    const zNullAction = new Float64Array(this.latentDim);

    const input = new Float64Array(this.latentDim * 2);
    input.set(zState, 0);
    input.set(zNullAction, this.latentDim);

    const sessionId = state.sessionId ?? "default";
    const sessionState = this.sessionStates.get(sessionId) ?? this.hiddenState;

    // Forward pass to get predicted next-state latent
    const { output: zPredicted } = this.lstm.forward(input, sessionState);

    // Decode the predicted latent vector back to action space
    const decoded = this.encoder.decodeAction(zPredicted, Array.from(this.toolVocab));

    const prediction: WorldModelAction = {
      type: decoded.type as WorldModelAction["type"],
      toolName: decoded.toolName,
      confidence: decoded.confidence,
      explanation: `LSTM prediction (h_dim=${this.hiddenDim}, trust=${decoded.confidence.toFixed(2)})`,
    };

    return [prediction];
  }

  /**
   * Simulate: "Dream" — roll forward in latent space to predict consequences.
   * Given current state and a hypothetical action, predict the next state
   * WITHOUT actually executing the action. This is counterfactual reasoning.
   *
   * "What would happen if the agent ran this tool?"
   */
  async simulate(state: WorldModelState, action: WorldModelAction): Promise<WorldModelState> {
    const zState = this.encoder.encodeState(state);
    const zAction = this.encoder.encodeAction(action);

    const input = new Float64Array(this.latentDim * 2);
    input.set(zState, 0);
    input.set(zAction, this.latentDim);

    const sessionId = state.sessionId ?? "default";
    const sessionState = this.sessionStates.get(sessionId) ?? this.hiddenState;

    // Dream forward one step
    const { output: zNext } = this.lstm.forward(input, sessionState);

    // Decode the predicted next action to build a narrative
    const decoded = this.encoder.decodeAction(zNext, Array.from(this.toolVocab));

    return {
      ...state,
      context: [
        state.context ?? "",
        `[Dream: After ${action.type}${action.toolName ? `(${action.toolName})` : ""} →`,
        ` predicted ${decoded.type}${decoded.toolName ? `(${decoded.toolName})` : ""}`,
        ` confidence=${decoded.confidence.toFixed(2)}]`,
      ].join(""),
    };
  }

  /** Get the raw encoder and LSTM for direct access by the DreamTrainer */
  getEncoder(): StateActionEncoder {
    return this.encoder;
  }
  getLSTM(): LSTMCell {
    return this.lstm;
  }
  getToolVocab(): string[] {
    return Array.from(this.toolVocab);
  }

  /** Save a full checkpoint: encoder weights + LSTM weights + tool vocabulary */
  async saveCheckpoint(filepath: string): Promise<void> {
    const checkpoint: Checkpoint = {
      version: 1,
      encoder: this.encoder.serialize(),
      lstm: this.lstm.serialize(),
      toolVocab: Array.from(this.toolVocab),
      config: { latentDim: this.latentDim, hiddenDim: this.hiddenDim },
      trainedAt: new Date().toISOString(),
    };

    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(checkpoint), "utf-8");
  }

  /** Load a checkpoint from disk */
  async loadCheckpoint(filepath: string): Promise<boolean> {
    if (!fs.existsSync(filepath)) {
      return false;
    }

    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const checkpoint: Checkpoint = JSON.parse(raw);

      if (checkpoint.version !== 1) {
        return false;
      }

      this.encoder = StateActionEncoder.deserialize(checkpoint.encoder);
      this.lstm.loadWeights(checkpoint.lstm);
      this.toolVocab = new Set(checkpoint.toolVocab);
      return true;
    } catch {
      return false;
    }
  }

  /** Reset session-specific hidden states (e.g., on session expiry) */
  resetSession(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  resetAllSessions(): void {
    this.sessionStates.clear();
    this.hiddenState = this.lstm.initHidden();
  }
}
