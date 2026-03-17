#!/usr/bin/env node

/**
 * Test case for OpenClaw issue #43945: Subagent Ollama Auth Fix
 * Tests that custom-named Ollama providers with "ollama-local" marker
 * resolve correctly for subagents
 */

import { resolveApiKeyForProvider } from "./src/agents/model-auth.js";
import { OLLAMA_LOCAL_AUTH_MARKER } from "./src/agents/model-auth-markers.js";

async function testOllamaAuthFix() {
  console.log("🧪 Testing Ollama Subagent Auth Fix (#43945)");
  console.log("=" * 50);

  // Test configuration matching the reported issue
  const testConfig = {
    models: {
      providers: {
        "ollama-remote": {
          api: "ollama",
          baseUrl: "http://192.168.178.122:11434",
          apiKey: "ollama-local", // The problematic marker
          models: ["qwen3-next:80b"]
        },
        "ollama-local": {
          api: "ollama", 
          baseUrl: "http://127.0.0.1:11434",
          apiKey: "ollama-local",
          models: ["llama3.2:3b"]
        }
      }
    }
  };

  try {
    // Test 1: Custom-named Ollama provider (the bug case)
    console.log("\n📋 Test 1: ollama-remote with ollama-local marker");
    const result1 = await resolveApiKeyForProvider({
      provider: "ollama-remote", 
      cfg: testConfig
    });
    
    console.log("✅ Result:", result1);
    console.log("✅ API Key:", result1.apiKey === OLLAMA_LOCAL_AUTH_MARKER ? "CORRECT" : "WRONG");
    console.log("✅ Source:", result1.source);
    
    // Test 2: Built-in ollama provider (should still work)
    console.log("\n📋 Test 2: Built-in ollama provider");
    const result2 = await resolveApiKeyForProvider({
      provider: "ollama",
      cfg: {
        models: {
          providers: {
            ollama: { api: "ollama", models: ["llama3.2:3b"] }
          }
        }
      }
    });
    
    console.log("✅ Result:", result2);
    console.log("✅ API Key:", result2.apiKey === OLLAMA_LOCAL_AUTH_MARKER ? "CORRECT" : "WRONG");
    
    // Test 3: Non-Ollama provider (should not be affected)  
    console.log("\n📋 Test 3: Non-Ollama provider");
    try {
      const result3 = await resolveApiKeyForProvider({
        provider: "openai",
        cfg: testConfig
      });
      console.log("Result:", result3);
    } catch (err) {
      console.log("✅ Expected failure (no auth):", err.message.substring(0, 50) + "...");
    }

    console.log("\n🎉 All tests completed!");

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

testOllamaAuthFix();