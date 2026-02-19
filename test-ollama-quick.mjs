import { isOllamaAvailable, getAvailableOllamaModels } from "./src/lib/research-ollama.ts";

console.log("\n=== Quick Ollama Connectivity Test ===\n");

console.log("✓ Test 1: Ollama available");
const available = await isOllamaAvailable();
console.log("  Result:", available ? "✅ YES" : "❌ NO");

if (available) {
  console.log("\n✓ Test 2: Available models");
  const models = await getAvailableOllamaModels();
  console.log("  Count:", models.length);
  models.forEach((m) => console.log("  -", m));

  console.log("\n✅ Integration working! Ollama is accessible and responding.\n");
  process.exit(0);
} else {
  console.log("\n❌ Ollama not responding\n");
  process.exit(1);
}
