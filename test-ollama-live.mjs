import { createResearchChatSession } from "./src/lib/research-chatbot.ts";
import {
  isOllamaAvailable,
  getAvailableOllamaModels,
  generateOllamaResearchResponse,
} from "./src/lib/research-ollama.ts";

console.log("\n=== Testing Ollama Integration (Live) ===\n");

// Test 1: Check availability
console.log("Test 1: Checking Ollama availability...");
const available = await isOllamaAvailable();
console.log("✓ Ollama available:", available, "\n");

if (!available) {
  console.error("❌ Ollama is not responding. Make sure: ollama serve");
  process.exit(1);
}

// Test 2: List models
console.log("Test 2: Listing available models...");
const models = await getAvailableOllamaModels();
console.log("✓ Found", models.length, "models");
models.slice(0, 3).forEach((m) => console.log("  -", m));
if (models.length > 3) {
  console.log("  ...and", models.length - 3, "more");
}
console.log();

// Test 3: Simple prompt
console.log("Test 3: Calling Ollama with simple prompt...");
const session = createResearchChatSession({ title: "Test" });
const start = Date.now();
const response = await generateOllamaResearchResponse(
  "What is 2+2? Answer with just the number.",
  session,
  { model: models[0] || "mistral" },
);
const duration = Date.now() - start;
console.log("✓ Response received in", duration + "ms");
console.log("  Response:", response.substring(0, 100) + (response.length > 100 ? "..." : ""));
console.log();

console.log("✅ All tests passed!\n");
