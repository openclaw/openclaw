import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { applyAutocompact, DEFAULT_AUTOCOMPACT_CONFIG } from "./autocompact.js";
import { applyMicrocompact, DEFAULT_MICROCOMPACT_CONFIG } from "./microcompact.js";

function makeToolResult(toolName: string, text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `${toolName}-${timestamp}`,
    toolName,
    content: [{ type: "text", text }],
    details: { size: text.length },
    isError: false,
    timestamp,
  };
}

async function testMicrocompact(): Promise<boolean> {
  console.log("🧪 Testing: Microcompact compression...");
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "read files" }], timestamp: 1 },
    makeToolResult("read", "A".repeat(4000), 2),
    makeToolResult("read", "B".repeat(4000), 3),
    makeToolResult("read", "C".repeat(4000), 4),
    makeToolResult("read", "D".repeat(4000), 5),
  ];

  const compacted = await applyMicrocompact(messages, {
    ...DEFAULT_MICROCOMPACT_CONFIG,
    timeBased: { enabled: false, gapThresholdMinutes: 30, maxCachedResults: 3 },
  });

  const compactedToolResults = compacted.filter(
    (message) => message.role === "toolResult",
  ) as Array<{ content: Array<{ type: string; text?: string }> }>;

  const firstText = compactedToolResults[0]?.content?.[0]?.text ?? "";
  const lastText = compactedToolResults[3]?.content?.[0]?.text ?? "";

  const ok = firstText.startsWith("[Tool Result: read") && lastText.length === 4000;
  console.log(ok ? "✅ Microcompact compression successful" : "❌ Microcompact compression failed");
  return ok;
}

async function testAutocompact(): Promise<boolean> {
  console.log("🧪 Testing: Autocompact summarization...");
  const longMessages: AgentMessage[] = [];
  for (let i = 0; i < 12; i += 1) {
    longMessages.push({
      role: "user",
      content: [{ type: "text", text: `User message ${i} ` + "X".repeat(3000) }],
      timestamp: i * 2 + 1,
    } as AgentMessage);
    longMessages.push({
      role: "assistant",
      content: [{ type: "text", text: `Assistant message ${i} ` + "Y".repeat(3000) }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: i * 2 + 2,
    } as AgentMessage);
  }

  const runtime = {
    model: {
      id: "test-model",
      name: "test-model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "",
      reasoning: false,
      input: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000,
      maxTokens: 4096,
    } satisfies Model<Api>,
    summarize: async () => "summary text",
  };

  const compacted = await applyAutocompact(longMessages, runtime, {
    ...DEFAULT_AUTOCOMPACT_CONFIG,
    thresholdPercent: 20,
    keepRecentTurns: 2,
  });

  const ok =
    compacted.length < longMessages.length &&
    compacted[0]?.role === "user" &&
    JSON.stringify(compacted[0]).includes("summary text");
  console.log(
    ok ? "✅ Autocompact summarization successful" : "❌ Autocompact summarization failed",
  );
  return ok;
}

async function runAllTests(): Promise<void> {
  console.log("🚀 Starting improvements test suite...\n");
  const results = [await testMicrocompact(), await testAutocompact()];
  const passed = results.filter(Boolean).length;
  console.log(`\n📊 Test Summary: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

runAllTests().catch((error: unknown) => {
  console.error("💥 Test suite failed with unexpected error:", error);
  process.exit(1);
});
