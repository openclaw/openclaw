import type { OpenClawConfig } from "./src/config/types.openclaw.js";
import { LLMWorldModel } from "./src/world-model/llm-provider.js";
import { type WorldModelAction, type WorldModelState } from "./src/world-model/types.js";

async function main() {
  console.log("Starting LLM World Model Verification...");

  // Mock Config
  const mockConfig: OpenClawConfig = {
    // We assume the environment variables for keys are set in the shell
    auth: {
      profiles: {},
    },
    models: {
      providers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        google: {
          api: "google",
          apiKey: process.env.GEMINI_API_KEY || "test-key",
        } as unknown,
      },
    },
  };

  try {
    const worldModel = new LLMWorldModel(mockConfig, "google", "gemini-1.5-pro");

    console.log("Initializing...");
    // Initialize specifically here to see errors
    await worldModel.initialize();

    const state: WorldModelState = {
      context:
        "The user has just asked to create a file named 'hello.txt'. The current directory is empty.",
      messages: [
        { role: "user", content: "Create a file called hello.txt with content 'Hello World'" },
      ],
    };

    const action: WorldModelAction = {
      type: "tool_call",
      toolName: "fs_write",
      toolArgs: { path: "hello.txt", content: "Hello World" },
    };

    console.log("Simulating Action:", JSON.stringify(action, null, 2));
    const nextState = await worldModel.simulate(state, action);

    console.log("--- Simulation Result ---");
    console.log(JSON.stringify(nextState, null, 2));

    if (nextState.context && nextState.context.includes("created")) {
      console.log("SUCCESS: Simulation predicted file creation.");
    } else {
      console.warn("WARNING: Simulation result might not be as expected.");
    }

    console.log("Predicting Next Action...");
    const predictions = await worldModel.predict(nextState);
    console.log("--- Prediction Result ---");
    console.log(JSON.stringify(predictions, null, 2));
  } catch (err) {
    console.error("Verification Attempt Failed:", err);
  }
}

main().catch(console.error);
