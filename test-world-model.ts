import { WorldModelManager } from "./src/world-model/manager.js";

async function main() {
  console.log("Starting World Model Verification...");

  // 1. Initialize Manager
  const manager = WorldModelManager.getInstance();
  console.log("Manager instance obtained.");

  // 2. Initialize with config
  void manager.initialize({
    worldModel: {
      enabled: true,
      provider: "logging",
    },
  });
  console.log("Manager initialized with logging provider.");

  // 3. Test Observe
  await manager.observe(
    { sessionId: "test-session", runId: "test-run" },
    { type: "text", content: "test observation" },
  );
  console.log("Observation logged.");

  console.log("Verification Successful!");
}

main().catch((err) => {
  console.error("Verification Failed:", err);
  process.exit(1);
});
