import { WorldModelManager } from "./src/world-model/manager.js";
import {
  type IWorldModel,
  type WorldModelAction,
  type WorldModelState,
} from "./src/world-model/types.js";

// Mock Model that returns a fixed prediction
class MockWorldModel implements IWorldModel {
  async observe(_state: WorldModelState, _action: WorldModelAction): Promise<void> {}
  async predict(_state: WorldModelState): Promise<WorldModelAction[]> {
    return [
      {
        type: "tool_call",
        toolName: "test_tool",
        toolArgs: { foo: "bar" },
        confidence: 0.9,
      },
    ];
  }
  async simulate(state: WorldModelState, _action: WorldModelAction): Promise<WorldModelState> {
    return state;
  }
}

async function main() {
  console.log("Starting Reality Check Verification...");

  // 1. Initialize Manager
  const manager = WorldModelManager.getInstance();

  // We need to inject our mock model. Since initialize() creates specific classes based on string,
  // we can't easily inject a custom class instance through config.
  // However, we can use "logging" provider and then iterate/hack?
  // Actually, let's just use the fact that we can't easily inject mock without changing code (Singleton pattern limitation).
  // ALTERNATIVE: checking logic by relying on 'logging' provider returning [] actions? No that won't populate buffer.

  // Let's rely on the fact that Javascript allows us to overwrite private properties or we can just use the 'llm' provider with a dummy key if we want, but that uses network.

  // BETTER APPROACH: Add a method `setProvider(model: IWorldModel)` to Manager or just use `any` cast.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).activeModel = new MockWorldModel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).minConfidence = 0.5; // Set threshold

  console.log(`Initial Trust Score: ${manager.getTrustScore()}`);

  // 2. Predict (Populates Buffer)
  const state: WorldModelState = { context: "test" };
  console.log("Requesting Prediction...");
  await manager.predict(state); // Should return our mock action

  // 3. Observe Match (Should Boost Trust)
  const matchingAction: WorldModelAction = {
    type: "tool_call",
    toolName: "test_tool", // Matches mock
    toolArgs: { foo: "bar" },
  };

  console.log("Observing Matching Action...");
  await manager.observe(state, matchingAction);

  let score = manager.getTrustScore();
  console.log(`Trust Score after Match: ${score}`);

  if (score > 1.0) {
    console.warn("Score > 1.0 (Should be capped)");
  }
  if (score == 1) {
    console.log("SUCCESS: Score capped at 1.0 (or boosted if it was lower)");
  }

  // 4. Observe Miss (Should Decay Trust)
  const mismatchAction: WorldModelAction = {
    type: "tool_call",
    toolName: "wrong_tool",
  };

  // We need another prediction first to be 'recent'?
  // The buffer has specific timestamps?
  // The logic checks `predictionBuffer[predictionBuffer.length - 1]`.
  // It compares against the *last* prediction.
  // If we call observe again, it compares against the same last prediction.

  console.log("Observing Mismatch Action...");
  await manager.observe(state, mismatchAction);

  score = manager.getTrustScore();
  console.log(`Trust Score after Miss: ${score}`);

  if (score < 1.0) {
    console.log("SUCCESS: Trust score decayed.");
  } else {
    console.error("FAILURE: Trust score did not decay.");
  }
}

main().catch(console.error);
