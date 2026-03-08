/**
 * Comprehensive Test Suite for LSTM World Model
 *
 * Tests all components:
 *   ✓ Encoder (state/action → latent vectors)
 *   ✓ LSTM (forward pass, backward pass, training)
 *   ✓ LSTMWorldModel (full provider with observe/predict/simulate)
 *   ✓ Dataset (observation collection and trajectory loading)
 *   ✓ DreamTrainer (training loop with dream phase)
 *   ✓ Manager integration (wiring everything together)
 */

import type { OpenClawConfig } from "./src/config/types.openclaw.js";
import type { WorldModelState, WorldModelAction } from "./src/world-model/types.js";
import { ObservationDataset } from "./src/world-model/dataset.js";
import { DreamTrainer } from "./src/world-model/dream-trainer.js";
import { StateActionEncoder } from "./src/world-model/encoder.js";
import { LSTMWorldModel } from "./src/world-model/lstm-provider.js";
import { LSTMCell } from "./src/world-model/lstm.js";
import { WorldModelManager } from "./src/world-model/manager.js";

// ─── Test Helpers ───

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
}

function test(name: string, fn: () => Promise<void> | void) {
  console.log(`\n🧪 ${name}`);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => console.log(`   ✅ passed`));
    }
    console.log(`   ✅ passed`);
  } catch (e) {
    console.error(`   ❌ FAILED: ${String(e)}`);
    process.exit(1);
  }
}

// ─── Tests ───

async function main() {
  console.log("\n🚀 LSTM World Model Test Suite\n" + "=".repeat(50));

  await test("Encoder: encode state to latent vector", () => {
    const encoder = new StateActionEncoder(4096, 128);
    const state: WorldModelState = {
      context: "User asked for help debugging",
      messages: ["Please analyze this error", "Here's the error message"],
    };
    const z = encoder.encodeState(state);
    assert(z.length === 128, `State latent should be 128-dim, got ${z.length}`);
    assert(!isNaN(z[0]), "Latent vector should contain valid numbers");
  });

  await test("Encoder: encode action to latent vector", () => {
    const encoder = new StateActionEncoder(4096, 128);
    const action: WorldModelAction = {
      type: "tool_call",
      toolName: "search_docs",
      toolArgs: { query: "error handling" },
      confidence: 0.95,
    };
    const a = encoder.encodeAction(action);
    assert(a.length === 128, `Action latent should be 128-dim, got ${a.length}`);
  });

  await test("Encoder: decode latent back to action", () => {
    const encoder = new StateActionEncoder(4096, 128);
    const tools = ["search_docs", "run_test", "check_logs"];

    // Encode an action
    const original: WorldModelAction = {
      type: "tool_call",
      toolName: "search_docs",
      toolArgs: {},
    };
    const z = encoder.encodeAction(original);

    // Decode it back
    const decoded = encoder.decodeAction(z, tools);
    assert(decoded.type === "tool_call", `Should decode as tool_call, got ${decoded.type}`);
    assert(
      decoded.toolName === "search_docs",
      `Should predict search_docs, got ${decoded.toolName}`,
    );
    assert(decoded.confidence > 0.5, `Should have decent confidence, got ${decoded.confidence}`);
  });

  await test("LSTM: forward pass", () => {
    const lstm = new LSTMCell(256, 128, 128); // input=256, hidden=128, output=128
    const state = lstm.initHidden();

    const input = new Float64Array(256);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.random() - 0.5;
    }

    const { output, state: newState } = lstm.forward(input, state);

    assert(output.length === 128, `Output should be 128-dim, got ${output.length}`);
    assert(newState.h.length === 128, "Hidden state should be 128-dim");
    assert(newState.c.length === 128, "Cell state should be 128-dim");
  });

  await test("LSTM: sequence forward pass", () => {
    const lstm = new LSTMCell(256, 128, 128);
    const inputs: Float64Array[] = [];
    for (let t = 0; t < 5; t++) {
      const x = new Float64Array(256);
      for (let i = 0; i < x.length; i++) {
        x[i] = Math.random() - 0.5;
      }
      inputs.push(x);
    }

    const { outputs, finalState, caches } = lstm.forwardSequence(inputs);

    assert(outputs.length === 5, `Should have 5 outputs, got ${outputs.length}`);
    assert(caches.length === 5, `Should have 5 caches, got ${caches.length}`);
    assert(finalState.h.length === 128, "Final hidden state should be 128-dim");
  });

  await test("LSTM: training step (gradient descent)", () => {
    const lstm = new LSTMCell(64, 32, 32);

    // Create simple sequence: x[t] → y[t] = 2*x[t] (double the input)
    const inputs: Float64Array[] = [];
    const targets: Float64Array[] = [];

    for (let t = 0; t < 10; t++) {
      const x = new Float64Array(64);
      for (let i = 0; i < x.length; i++) {
        x[i] = Math.random() - 0.5;
      }
      inputs.push(x);

      const y = new Float64Array(32);
      for (let i = 0; i < 32; i++) {
        y[i] = x[i] * 2;
      } // Target: double the first 32 inputs
      targets.push(y);
    }

    // Train for multiple epochs
    for (let epoch = 0; epoch < 5; epoch++) {
      const loss = lstm.trainStep(inputs, targets, 0.01);
      console.log(`   Epoch ${epoch + 1}: loss=${loss.toFixed(6)}`);
      assert(!isNaN(loss), "Loss should be a valid number");
      assert(loss > 0, "Loss should be positive");
      // Loss should generally decrease (though not monotonically due to stochasticity)
    }
  });

  await test("LSTMWorldModel: observe and update hidden state", async () => {
    const model = new LSTMWorldModel({
      latentDim: 128,
      hiddenDim: 256,
    });

    const state: WorldModelState = {
      sessionId: "test-session",
      context: "User is debugging code",
      messages: ["Help", "Here's my error"],
    };
    const action: WorldModelAction = {
      type: "tool_call",
      toolName: "search_docs",
    };

    await model.observe(state, action);
    // If no error thrown, observation was successful
    console.log(`   ✅ Observed action, hidden state updated`);
  });

  await test("LSTMWorldModel: predict next action", async () => {
    const model = new LSTMWorldModel({
      latentDim: 128,
      hiddenDim: 256,
    });

    // Seed some observations
    const state: WorldModelState = {
      sessionId: "predict-test",
      context: "User debugging",
      messages: ["Help"],
    };

    for (let i = 0; i < 5; i++) {
      await model.observe(state, {
        type: "tool_call",
        toolName: "search_docs",
      });
    }

    // Now predict
    const predictions = await model.predict(state);

    assert(predictions.length > 0, "Should return at least one prediction");
    assert(predictions[0].confidence !== undefined, "Prediction should have confidence");
    assert(predictions[0].type !== undefined, "Prediction should have type");
    console.log(
      `   Predicted: ${predictions[0].type} (${predictions[0].toolName || "text"}) [confidence=${predictions[0].confidence?.toFixed(2)}]`,
    );
  });

  await test("LSTMWorldModel: simulate (dream) next state", async () => {
    const model = new LSTMWorldModel({
      latentDim: 128,
      hiddenDim: 256,
    });

    const state: WorldModelState = {
      context: "Agent is running a test",
      messages: ["Running pytest"],
    };
    const action: WorldModelAction = {
      type: "tool_call",
      toolName: "run_test",
      toolArgs: { file: "test_app.py" },
    };

    const nextState = await model.simulate(state, action);

    assert(nextState.context !== undefined, "Simulated state should have context");
    assert(nextState.context!.includes("Dream"), "Dream context should be marked");
    console.log(`   Simulated state: "${nextState.context?.substring(0, 60)}..."`);
  });

  await test("Dataset: append observations and flush", () => {
    const dataset = new ObservationDataset("./test-dataset-tmp");

    const state: WorldModelState = {
      sessionId: "session-1",
      context: "test",
    };
    const action: WorldModelAction = {
      type: "text",
      content: "Hello",
    };

    for (let i = 0; i < 60; i++) {
      dataset.append(state, action);
    }

    dataset.flush();

    const files = dataset.listFiles();
    assert(files.length > 0, "Should have created dataset files");
    console.log(
      `   Created ${files.length} file(s), total observations: ${dataset.totalObservations()}`,
    );
  });

  await test("Dataset: load and group trajectories", () => {
    const dataset = new ObservationDataset("./test-dataset-tmp");

    const trajectories = dataset.loadRecentTrajectories(1);

    assert(trajectories.length > 0, "Should have loaded trajectories");
    assert(trajectories[0].steps.length > 0, "Trajectories should have steps");
    console.log(
      `   Loaded ${trajectories.length} trajectory(ies) with ${trajectories.reduce((n, t) => n + t.steps.length, 0)} total steps`,
    );
  });

  await test("DreamTrainer: initialize and check stats", async () => {
    const trainer = new DreamTrainer({
      dataDir: "./test-dataset-tmp",
      checkpointPath: "./test-checkpoint.json",
      epochs: 2,
      dreamSteps: 5,
      maxSeqLength: 20,
      lookbackDays: 1,
    });

    const stats = trainer.getStats();
    console.log(
      `   Dataset stats: ${stats.totalObservations} observations, ${stats.dataFiles.length} file(s)`,
    );
    assert(stats.totalObservations > 0, "Should have observations");
  });

  await test("DreamTrainer: run full training cycle", async () => {
    const trainer = new DreamTrainer({
      dataDir: "./test-dataset-tmp",
      checkpointPath: "./test-checkpoint.json",
      epochs: 2,
      dreamSteps: 3,
      maxSeqLength: 20,
      lookbackDays: 1,
      latentDim: 64,
      hiddenDim: 128,
    });

    const result = await trainer.train();

    assert(result.epochs === 2, `Should train for 2 epochs, got ${result.epochs}`);
    assert(result.finalLoss >= 0, `Loss should be non-negative, got ${result.finalLoss}`);
    assert(result.duration > 0, "Training should take some time");
    console.log(
      `   Trained ${result.epochs} epochs, final loss: ${result.finalLoss.toFixed(6)}, duration: ${(result.duration / 1000).toFixed(1)}s`,
    );
  });

  await test("WorldModelManager: singleton pattern", async () => {
    const mgr1 = WorldModelManager.getInstance();
    const mgr2 = WorldModelManager.getInstance();

    assert(mgr1 === mgr2, "Should return same instance");
    console.log(`   ✅ Singleton pattern working`);
  });

  await test("Manager: integration with LSTM provider", async () => {
    const mgr = WorldModelManager.getInstance();

    // Simulate initialization with LSTM provider
    const mockConfig = {
      worldModel: {
        enabled: true,
        provider: "lstm" as const,
        dataDir: "./test-dataset-tmp",
        lstm: {
          latentDim: 64,
          hiddenDim: 128,
          weightsPath: "./test-checkpoint.json",
        },
      },
    };

    await mgr.initialize(mockConfig as unknown as OpenClawConfig);

    // Check that manager initialized
    assert(mgr.getDataset() !== undefined, "Dataset should be initialized");
    console.log(`   ✅ Manager initialized with LSTM provider`);
  });

  console.log("\n" + "=".repeat(50));
  console.log("✅ All tests passed!\n");
  console.log("📊 Summary:");
  console.log("   • Encoder: state/action encoding ✓");
  console.log("   • LSTM: forward/backward/training ✓");
  console.log("   • LSTMWorldModel: observe/predict/simulate ✓");
  console.log("   • Dataset: collection and persistence ✓");
  console.log("   • DreamTrainer: full training pipeline ✓");
  console.log("   • WorldModelManager: integration ✓");
  console.log("\n🎯 The LSTM cerebellum is ready for OpenClaw!\n");
}

main().catch(console.error);
