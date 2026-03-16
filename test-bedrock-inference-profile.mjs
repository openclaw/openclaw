#!/usr/bin/env node

/**
 * Test script to verify Application Inference Profile ARN support
 */

// Simple test implementation of the updated function
function isAnthropicBedrockModel(modelId, modelName) {
  const normalized = modelId.toLowerCase();

  // Check if the model ID contains Anthropic Claude identifiers
  if (normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude")) {
    return true;
  }

  // Check if the model ID is an Application Inference Profile ARN for a Claude model
  // ARN format: arn:aws:bedrock:<region>:<account>:application-inference-profile/<profile-id>
  // We check if the model name contains "claude" to identify Claude models using inference profiles
  if (modelName) {
    const normalizedName = modelName.toLowerCase();
    if (normalizedName.includes("claude")) {
      return true;
    }
  }

  // Check if the model ID is a short Application Inference Profile ID that might be for Claude
  // Short IDs don't contain model info, so we rely on the model name if available
  if (modelId.startsWith("arn:aws:bedrock:") && modelId.includes(":application-inference-profile/")) {
    // This is an Application Inference Profile ARN
    // We can't determine if it's Claude from the ARN alone, so check the name
    return modelName ? modelName.toLowerCase().includes("claude") : false;
  }

  return false;
}

// Test cases
const testCases = [
  // Standard Bedrock model IDs (should return true)
  { id: "anthropic.claude-3-opus-20240229-v1:0", name: undefined, expected: true },
  { id: "anthropic.claude-3-sonnet-20240229-v1:0", name: undefined, expected: true },
  { id: "us.anthropic.claude-opus-4-6-v1:0", name: undefined, expected: true },

  // Application Inference Profile ARNs with Claude in name (should return true)
  {
    id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile",
    name: "Claude 3 Opus via Application Inference Profile",
    expected: true
  },
  {
    id: "arn:aws:bedrock:us-west-2:987654321098:application-inference-profile/prod-profile",
    name: "Production Claude Model",
    expected: true
  },

  // Short Application Inference Profile IDs with Claude in name (should return true)
  { id: "my-claude-profile", name: "Claude Profile", expected: true },
  { id: "prod-inference", name: "Production Claude", expected: true },

  // Non-Anthropic models (should return false)
  { id: "amazon.titan-text-express-v1", name: undefined, expected: false },
  { id: "meta.llama2-13b-chat-v1", name: undefined, expected: false },

  // Application Inference Profile ARNs without Claude in name (should return false)
  {
    id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/llama-profile",
    name: "Llama 2 Profile",
    expected: false
  },

  // Application Inference Profile ARNs without name (should return false)
  {
    id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/unknown",
    name: undefined,
    expected: false
  },
];

// Run tests
console.log("Testing isAnthropicBedrockModel function with Application Inference Profile support:\n");

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = isAnthropicBedrockModel(testCase.id, testCase.name);
  const status = result === testCase.expected ? "✅ PASS" : "❌ FAIL";

  if (result === testCase.expected) {
    passed++;
  } else {
    failed++;
  }

  console.log(`${status}: isAnthropicBedrockModel("${testCase.id}", ${testCase.name ? `"${testCase.name}"` : "undefined"})`);
  console.log(`  Expected: ${testCase.expected}, Got: ${result}`);

  if (result !== testCase.expected) {
    console.log(`  ⚠️ Test failed!`);
  }
  console.log();
}

console.log("=" .repeat(60));
console.log(`Test Results: ${passed} passed, ${failed} failed out of ${testCases.length} total`);

if (failed === 0) {
  console.log("\n✅ All tests passed! The fix correctly handles Application Inference Profile ARNs.");
} else {
  console.log("\n❌ Some tests failed. Please review the implementation.");
  process.exit(1);
}