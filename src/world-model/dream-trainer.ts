/**
 * Dream Trainer — The "Sleep" Phase
 *
 * Inspired by Ha & Schmidhuber's World Models (2018) dream training
 * and Yann LeCun's autonomous machine intelligence paper (2022).
 *
 * When the agent is idle (night time / no active sessions), this module:
 *
 *   1. Loads observation trajectories from the day's JSONL dataset
 *   2. Encodes them into latent sequences using the StateActionEncoder
 *   3. Trains the LSTM via BPTT to predict next-state from (state, action) pairs
 *   4. Runs "dream simulations" — rolls the LSTM forward without real environment
 *      to generate synthetic training data (like REM sleep consolidation)
 *   5. Evaluates prediction accuracy and saves checkpoints
 *
 * The key insight from LeCun's JEPA: we predict in latent space, not pixel/token space.
 * This makes training vastly more efficient — we don't waste capacity on irrelevant details.
 *
 * Integration:
 *   - Triggered by OpenClaw's cron/heartbeat system
 *   - Or manually via `openclaw dream-train` command
 *   - Reads from ObservationDataset, writes checkpoints to weightsPath
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { ObservationDataset, type Trajectory } from "./dataset.js";
import { StateActionEncoder } from "./encoder.js";
import { LSTMWorldModel } from "./lstm-provider.js";
import { LSTMCell } from "./lstm.js";

const log = createSubsystemLogger("dream-trainer");

export interface DreamTrainerConfig {
  /** Path to the observation dataset directory */
  dataDir: string;
  /** Path to save/load model checkpoints */
  checkpointPath: string;
  /** Number of training epochs per sleep cycle */
  epochs?: number;
  /** Learning rate for Adam optimizer */
  learningRate?: number;
  /** Max sequence length for BPTT (truncated backprop) */
  maxSeqLength?: number;
  /** Number of dream simulation steps to generate synthetic data */
  dreamSteps?: number;
  /** How many days of data to use for training */
  lookbackDays?: number;
  /** LSTM latent dimension */
  latentDim?: number;
  /** LSTM hidden dimension */
  hiddenDim?: number;
}

export interface DreamTrainingResult {
  epochs: number;
  finalLoss: number;
  trajectoryCount: number;
  totalSteps: number;
  dreamSimulations: number;
  duration: number;
  timestamp: string;
}

export class DreamTrainer {
  private readonly config: Required<DreamTrainerConfig>;
  private dataset: ObservationDataset;
  private model: LSTMWorldModel;
  private encoder: StateActionEncoder;
  private lstm: LSTMCell;

  constructor(config: DreamTrainerConfig) {
    this.config = {
      epochs: 10,
      learningRate: 0.001,
      maxSeqLength: 50,
      dreamSteps: 20,
      lookbackDays: 7,
      latentDim: 128,
      hiddenDim: 256,
      ...config,
    };

    this.dataset = new ObservationDataset(this.config.dataDir);
    this.model = new LSTMWorldModel({
      latentDim: this.config.latentDim,
      hiddenDim: this.config.hiddenDim,
      weightsPath: this.config.checkpointPath,
    });
    this.encoder = this.model.getEncoder();
    this.lstm = this.model.getLSTM();
  }

  /**
   * Run a full dream training cycle.
   * This is the main entry point — call this from the cron job.
   */
  async train(): Promise<DreamTrainingResult> {
    const startTime = Date.now();
    log.info("Dream training starting... 💤");

    // Phase 0: Load existing checkpoint if available
    await this.model.initialize();
    this.encoder = this.model.getEncoder();
    this.lstm = this.model.getLSTM();

    // Phase 1: Load real-world trajectories
    log.info(`Loading trajectories from last ${this.config.lookbackDays} days...`);
    const trajectories = this.dataset.loadRecentTrajectories(this.config.lookbackDays);

    if (trajectories.length === 0) {
      log.warn("No training data found. Skipping dream training.");
      return {
        epochs: 0,
        finalLoss: 0,
        trajectoryCount: 0,
        totalSteps: 0,
        dreamSimulations: 0,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    log.info(
      `Found ${trajectories.length} trajectories with ${trajectories.reduce((n, t) => n + t.steps.length, 0)} total steps.`,
    );

    // Phase 2: Encode trajectories into latent sequences
    const latentSequences = this.encodeTrajectories(trajectories);

    // Phase 3: Train LSTM on real data (supervised learning on next-state prediction)
    let loss = 0;
    for (let epoch = 0; epoch < this.config.epochs; epoch++) {
      loss = this.trainEpoch(latentSequences);
      if (epoch % 2 === 0 || epoch === this.config.epochs - 1) {
        log.info(`Epoch ${epoch + 1}/${this.config.epochs} — Loss: ${loss.toFixed(6)}`);
      }
    }

    // Phase 4: Dream simulation — generate synthetic data and train on it
    log.info(`Running ${this.config.dreamSteps} dream simulation steps...`);
    const dreamLoss = this.dreamPhase(latentSequences);
    log.info(`Dream phase loss: ${dreamLoss.toFixed(6)}`);

    // Phase 5: Save checkpoint
    await this.model.saveCheckpoint(this.config.checkpointPath);
    log.info(`Checkpoint saved to ${this.config.checkpointPath}`);

    const result: DreamTrainingResult = {
      epochs: this.config.epochs,
      finalLoss: loss,
      trajectoryCount: trajectories.length,
      totalSteps: trajectories.reduce((n, t) => n + t.steps.length, 0),
      dreamSimulations: this.config.dreamSteps,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    log.info(
      `Dream training complete. Duration: ${(result.duration / 1000).toFixed(1)}s, Final Loss: ${loss.toFixed(6)}`,
    );
    return result;
  }

  /**
   * Encode raw trajectories into latent-space sequences for LSTM training.
   * Each trajectory becomes a sequence of (input, target) pairs where:
   *   input_t = [encode(state_t); encode(action_t)]
   *   target_t = encode(state_{t+1})
   */
  private encodeTrajectories(
    trajectories: Trajectory[],
  ): { inputs: Float64Array[]; targets: Float64Array[] }[] {
    const sequences: { inputs: Float64Array[]; targets: Float64Array[] }[] = [];

    for (const traj of trajectories) {
      if (traj.steps.length < 2) {
        continue;
      }

      const inputs: Float64Array[] = [];
      const targets: Float64Array[] = [];

      // Truncate to maxSeqLength for BPTT memory efficiency
      const steps = traj.steps.slice(0, this.config.maxSeqLength + 1);

      for (let t = 0; t < steps.length - 1; t++) {
        const zState = this.encoder.encodeState(steps[t].state);
        const zAction = this.encoder.encodeAction(steps[t].action);
        const zNextState = this.encoder.encodeState(steps[t + 1].state);

        // Concatenate state + action as LSTM input
        const input = new Float64Array(this.config.latentDim * 2);
        input.set(zState, 0);
        input.set(zAction, this.config.latentDim);

        inputs.push(input);
        targets.push(zNextState);
      }

      if (inputs.length > 0) {
        sequences.push({ inputs, targets });
      }
    }

    return sequences;
  }

  /**
   * Run one epoch of training over all sequences.
   * Returns the average loss across all sequences.
   */
  private trainEpoch(sequences: { inputs: Float64Array[]; targets: Float64Array[] }[]): number {
    if (sequences.length === 0) {
      return 0;
    }

    let totalLoss = 0;
    // Shuffle sequences for better training dynamics
    const shuffled = [...sequences].toSorted(() => Math.random() - 0.5);

    for (const seq of shuffled) {
      const loss = this.lstm.trainStep(
        seq.inputs,
        seq.targets,
        this.config.learningRate,
        1.0, // gradient clip norm
      );
      totalLoss += loss;
    }

    return totalLoss / sequences.length;
  }

  /**
   * Dream Phase — Ha & Schmidhuber's key innovation.
   *
   * Instead of training only on real observations, we also train
   * on hallucinated sequences generated by the LSTM itself.
   *
   * Process:
   *   1. Pick a random starting state from real data
   *   2. Use the LSTM to predict forward N steps (dreaming)
   *   3. The dream becomes self-supervised training data:
   *      the LSTM learns to be consistent with its own predictions
   *   4. This is like REM sleep — consolidating memories into patterns
   *
   * The dream phase helps the model generalize beyond observed trajectories
   * and discover latent patterns in user behavior.
   */
  private dreamPhase(realSequences: { inputs: Float64Array[]; targets: Float64Array[] }[]): number {
    if (realSequences.length === 0) {
      return 0;
    }

    let totalDreamLoss = 0;
    const numDreams = Math.min(this.config.dreamSteps, realSequences.length);

    for (let d = 0; d < numDreams; d++) {
      // Pick a random real sequence as the dream seed
      const seedIdx = Math.floor(Math.random() * realSequences.length);
      const seed = realSequences[seedIdx];
      if (seed.inputs.length === 0) {
        continue;
      }

      // Use the first few steps as context, then dream forward
      const contextLen = Math.min(3, seed.inputs.length);
      let state = this.lstm.initHidden();

      // Warm up with real context
      let lastOutput: Float64Array | undefined;
      for (let t = 0; t < contextLen; t++) {
        const result = this.lstm.forward(seed.inputs[t], state);
        state = result.state;
        lastOutput = result.output;
      }

      if (!lastOutput) {
        continue;
      }

      // Dream forward: use predictions as next inputs
      const dreamInputs: Float64Array[] = [];
      const dreamTargets: Float64Array[] = [];

      let currentPrediction = lastOutput;
      for (let t = 0; t < this.config.dreamSteps; t++) {
        // Create dream input from predicted state + null action
        const dreamInput = new Float64Array(this.config.latentDim * 2);
        dreamInput.set(currentPrediction, 0);
        // Leave action part as zeros (exploring what happens with no action)

        const result = this.lstm.forward(dreamInput, state);
        state = result.state;

        dreamInputs.push(dreamInput);
        dreamTargets.push(result.output); // Self-supervised: predict own predictions

        currentPrediction = result.output;
      }

      // Train on dream sequence with lower learning rate (dream data is noisier)
      if (dreamInputs.length > 1) {
        // Shift targets: input[t] should predict target[t+1]
        const loss = this.lstm.trainStep(
          dreamInputs.slice(0, -1),
          dreamTargets.slice(1),
          this.config.learningRate * 0.1, // 10x lower LR for dreams
          0.5, // Tighter gradient clip for dream stability
        );
        totalDreamLoss += loss;
      }
    }

    return numDreams > 0 ? totalDreamLoss / numDreams : 0;
  }

  /** Get training statistics */
  getStats(): { totalObservations: number; dataFiles: string[] } {
    return {
      totalObservations: this.dataset.totalObservations(),
      dataFiles: this.dataset.listFiles(),
    };
  }
}
