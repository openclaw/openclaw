/**
 * Smoke tests for Ollama integration
 *
 * These tests verify that the system works with a real Ollama instance.
 * Run with: OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts
 *
 * Prerequisites:
 *   - Ollama running on http://127.0.0.1:11434
 *   - A model installed (e.g., `ollama pull mistral`)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createResearchChatSession } from "./research-chatbot.js";
import {
  isOllamaAvailable,
  getAvailableOllamaModels,
  generateOllamaResearchResponse,
} from "./research-ollama.js";

// Only run these tests if OLLAMA_SMOKE_TEST env var is set
const runSmokeTests = process.env.OLLAMA_SMOKE_TEST === "1";

// Only run if OLLAMA_SMOKE_TEST is set; we'll do a real check in beforeAll
let isOllamaRunning = runSmokeTests; // Re-check in beforeAll hook

describe.skipIf(!runSmokeTests || !isOllamaRunning)("Ollama Smoke Tests (Real Instance)", () => {
  let availableModel: string;

  beforeAll(async () => {
    // Final check if Ollama is actually running before running tests
    const available = await isOllamaAvailable();
    if (!available) {
      console.warn(
        "⚠️  Ollama is not running on http://127.0.0.1:11434. Start it with: ollama serve",
      );
      return;
    }

    // Get the first available model to use in tests
    const models = await getAvailableOllamaModels();
    if (models.length === 0) {
      console.warn("⚠️  No models installed. Install one with: ollama pull mistral");
      availableModel = "mistral";
    } else {
      availableModel = models[0];
      console.log(`Using model for tests: ${availableModel}`);
    }
  });

  describe("Connectivity", () => {
    it("should connect to running Ollama instance", async () => {
      const available = await isOllamaAvailable();
      expect(available).toBe(true);
    });
  });

  describe("Model Management", () => {
    it("should list available models", async () => {
      const models = await getAvailableOllamaModels();
      expect(Array.isArray(models)).toBe(true);
      if (models.length === 0) {
        console.warn("⚠️  No models installed. Install one with: ollama pull mistral");
      }
    });

    it("should have at least one model available", async () => {
      const models = await getAvailableOllamaModels();
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe("LLM Interaction", () => {
    it("should call Ollama with simple prompt", async () => {
      const session = createResearchChatSession({
        title: "Simple Test",
      });

      const response = await generateOllamaResearchResponse(
        "Say 'Hello, Ollama!' in exactly this format",
        session,
        { model: availableModel, temperature: 0.7 },
      );

      expect(response).toBeTruthy();
      expect(typeof response).toBe("string");
      expect(response.length).toBeGreaterThan(0);
    }, 60000);

    it("should generate research response", async () => {
      const session = createResearchChatSession({
        title: "Smoke Test Research",
        summary: "Testing Ollama integration",
      });

      const response = await generateOllamaResearchResponse(
        "Add a section on machine learning basics",
        session,
        { model: availableModel, temperature: 0.7 },
      );

      expect(response).toBeTruthy();
      expect(typeof response).toBe("string");
      expect(response.length).toBeGreaterThan(0);
    }, 120000);

    it("should handle multi-turn conversation", async () => {
      const session = createResearchChatSession({
        title: "Multi-turn Test",
      });

      // First turn
      const response1 = await generateOllamaResearchResponse("What is AI?", session, {
        model: availableModel,
      });
      expect(response1).toBeTruthy();

      // Second turn (should have context from first)
      const response2 = await generateOllamaResearchResponse(
        "Expand on that with practical applications",
        session,
        { model: availableModel },
      );
      expect(response2).toBeTruthy();
      expect(response2.length).toBeGreaterThan(0);
    }, 180000);
  });

  describe("Performance", () => {
    it("should respond within reasonable time", async () => {
      const start = Date.now();
      const session = createResearchChatSession({
        title: "Performance Test",
      });
      await generateOllamaResearchResponse("What is 2+2?", session, { model: availableModel });
      const duration = Date.now() - start;

      // Should respond within 30 seconds (adjust based on your hardware)
      expect(duration).toBeLessThan(30000);
    }, 35000);
  });

  describe("Error Handling", () => {
    it("should handle invalid model gracefully", async () => {
      const session = createResearchChatSession({
        title: "Error Test",
      });
      const response = await generateOllamaResearchResponse("Hello", session, {
        model: "nonexistent-model-xyz",
      });

      // Should either error or return fallback response
      expect(typeof response).toBe("string");
    }, 10000);
  });
});

describe("Ollama Setup Guide", () => {
  it("documents how to run smoke tests", () => {
    const guide = `
OLLAMA SMOKE TEST SETUP:

1. Install Ollama:
   - Visit https://ollama.ai
   - Download and install for your OS

2. Start Ollama:
   $ ollama serve
   (Runs on http://127.0.0.1:11434)

3. Pull a model:
   $ ollama pull mistral
   (or another model like: llama2, neural-chat, etc.)

4. Run smoke tests:
   $ OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts

5. View results:
   ✓ All tests pass = Ollama integration working
   ✗ Tests fail/timeout = Check Ollama is running
    `;

    expect(guide).toContain("ollama serve");
    expect(guide).toContain("OLLAMA_SMOKE_TEST");
  });
});
