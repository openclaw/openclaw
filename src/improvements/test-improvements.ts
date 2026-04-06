/**
 * 改进功能测试脚本
 * 
 * 测试工具并发执行、Microcompact 和 Autocompact 是否正确工作
 * 
 * 创建时间: 2026-04-06
 */

declare var process: any;

import type { ToolCall, ToolResult } from "./tool-concurrent.js";
import { executeToolsWithConcurrency } from "./tool-concurrent.js";
import { applyMicrocompact, DEFAULT_MICROCOMPACT_CONFIG } from "./microcompact.js";
import { applyAutocompact, DEFAULT_AUTOCOMPACT_CONFIG } from "./autocompact.js";
import type { Message } from "./microcompact.js";

// ============================================================================
// 测试工具并发执行
// ============================================================================

async function testToolConcurrency(): Promise<boolean> {
  console.log("🧪 Testing: Tool concurrency execution...");

  // 创建模拟工具调用
  const toolCalls: ToolCall[] = [
    { name: "read", path: "/file1.txt" },
    { name: "read", path: "/file2.txt" },
    { name: "read", path: "/file3.txt" },
    { name: "read", path: "/file4.txt" },
    { name: "read", path: "/file5.txt" },
    { name: "web_search", query: "test query" },
    { name: "grep", pattern: "pattern", path: "/file.txt" },
  ];

  // 模拟工具执行器，添加延迟来模拟实际执行
  let executionCount = 0;
  const startTime = Date.now();

  async function mockExecutor(call: ToolCall): Promise<ToolResult> {
    executionCount++;
    // 模拟 50ms 延迟
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      success: true,
      data: {
        result: `Result for ${call.name} (execution ${executionCount})`
      }
    };
  }

  // 使用并发执行
  const results = await executeToolsWithConcurrency(
    toolCalls,
    mockExecutor,
    {
      maxConcurrency: 10,
      logEnabled: true
    }
  );

  const elapsed = Date.now() - startTime;
  console.log(`✅ Tool concurrency test completed in ${elapsed}ms`);
  console.log(`   - ${results.length} results`);
  console.log(`   - Serial execution would take ~${toolCalls.length * 50}ms`);
  console.log(`   - Speedup: ~${Math.round((toolCalls.length * 50) / elapsed)}x`);

  // 验证结果
  if (results.length !== toolCalls.length) {
    console.error("❌ Result count mismatch");
    return false;
  }

  for (const result of results) {
    if (!result.success) {
      console.error("❌ Some tool calls failed");
      return false;
    }
  }

  console.log("✅ All tool calls succeeded");
  console.log("");
  return true;
}

// ============================================================================
// 测试 Microcompact 压缩
// ============================================================================

async function testMicrocompact(): Promise<boolean> {
  console.log("🧪 Testing: Microcompact compression...");

  // 创建模拟消息列表，包含多个工具结果
  // Note: tool_result 类型已经包含在 Message 类型定义中
  const messages: Message[] = [
    {
      type: "user",
      message: {
        content: "Please read these files for me."
      }
    },
    {
      type: "assistant",
      message: {
        content: "I'll read the files for you."
      }
    },
    {
      type: "user",
      message: {
        content: "This is the content of file 1. It contains several lines of text that would take up tokens in the context.\n".repeat(100)
      }
    },
    {
      type: "user",
      message: {
        content: "This is the content of file 2. It also contains multiple lines of text that would consume tokens.\n".repeat(100)
      }
    },
    {
      type: "user",
      message: {
        content: "This is the content of file 3. More text that takes up tokens.\n".repeat(100)
      }
    },
    {
      type: "user",
      message: {
        content: "This is the content of file 4. Even more text.\n".repeat(100)
      }
    },
    {
      type: "user",
      message: {
        content: "This is the content of file 5. The last one.\n".repeat(100)
      }
    },
    {
      type: "assistant",
      message: {
        content: "I've read all the files. Here's my analysis..."
      }
    }
  ];

  const originalCount = messages.length;
  const originalLength = JSON.stringify(messages).length;

  console.log(`   - Original: ${originalCount} messages, ${originalLength} bytes`);

  // 应用 Microcompact
  const config = {
    ...DEFAULT_MICROCOMPACT_CONFIG,
    cacheBased: {
      enabled: true,
      maxCachedResults: 3,  // 只保留最近 3 个结果
      minToolCalls: 3
    }
  };

  const compactedMessages = await applyMicrocompact(messages, config);

  const compactedCount = compactedMessages.length;
  const compactedLength = JSON.stringify(compactedMessages).length;
  const savedBytes = originalLength - compactedLength;
  const savedPercent = ((savedBytes / originalLength) * 100).toFixed(1);

  console.log(`   - Compressed: ${compactedCount} messages, ${compactedLength} bytes`);
  console.log(`   - Saved: ${savedBytes} bytes (${savedPercent}%)`);

  // 验证结果
  if (compactedLength >= originalLength) {
    console.error("❌ No compression achieved");
    return false;
  }

  if (compactedCount > originalCount) {
    console.error("❌ More messages after compression");
    return false;
  }

  console.log("✅ Microcompact compression successful");
  console.log("");
  return true;
}

// ============================================================================
// 测试 Autocompact 自动摘要
// ============================================================================

async function testAutocompact(): Promise<boolean> {
  console.log("🧪 Testing: Autocompact summarization...");

  // 创建模拟长对话
  const messages: Message[] = [];

  // 添加多条消息来模拟长对话
  for (let i = 0; i < 20; i++) {
    messages.push({
      type: "user",
      message: {
        content: `This is user message ${i + 1}. It contains some conversation content that would eventually exceed the context window.\n`.repeat(10)
      }
    });
    messages.push({
      type: "assistant",
      message: {
        content: `This is assistant response ${i + 1}. It responds to the user's message and continues the conversation.\n`.repeat(10)
      }
    });
  }

  const originalCount = messages.length;
  const originalTokens = (
    messages.reduce((sum, msg) => {
      const content = msg.message?.content;
      if (typeof content === "string") {
        return sum + Math.ceil(content.length / 4);
      }
      return sum;
    }, 0)
  );

  console.log(`   - Original: ${originalCount} messages, ~${originalTokens} tokens`);

  // 应用 Autocompact
  const config = {
    ...DEFAULT_AUTOCOMPACT_CONFIG,
    thresholdPercent: 50,  // 低阈值触发，便于测试
    keepRecentTurns: 3
  };

  try {
    const compactedMessages = await applyAutocompact(
      messages,
      "test-model",
      config
    );

    const compactedCount = compactedMessages.length;
    const compactedTokens = (
      compactedMessages.reduce((sum, msg) => {
        const content = msg.message?.content;
        if (typeof content === "string") {
          return sum + Math.ceil(content.length / 4);
        }
        return sum;
      }, 0)
    );

    const savedTokens = originalTokens - compactedTokens;
    const savedPercent = ((savedTokens / originalTokens) * 100).toFixed(1);

    console.log(`   - Compressed: ${compactedCount} messages, ~${compactedTokens} tokens`);
    console.log(`   - Saved: ${savedTokens} tokens (${savedPercent}%)`);

    // 验证结果
    if (compactedCount >= originalCount) {
      console.error("❌ No summarization achieved");
      return false;
    }

    console.log("✅ Autocompact summarization successful");
    console.log("");
    return true;
  } catch (error) {
    console.error("❌ Autocompact failed:", error);
    return false;
  }
}

// ============================================================================
// 运行所有测试
// ============================================================================

async function runAllTests() {
  console.log("🚀 Starting improvements test suite...");
  console.log("");

  const results: boolean[] = [];

  // 测试 1: 工具并发执行
  results.push(await testToolConcurrency());

  // 测试 2: Microcompact 压缩
  results.push(await testMicrocompact());

  // 测试 3: Autocompact 摘要
  results.push(await testAutocompact());

  // 总结结果
  console.log("📊 Test Summary:");
  const passed = results.filter(r => r).length;
  const total = results.length;

  console.log(`   - Passed: ${passed}/${total}`);

  if (passed === total) {
    console.log("🎉 All tests PASSED!");
    console.log("");
    console.log("✅ All improvement functions are working correctly:");
    console.log("   - Tool concurrency: works with parallel execution");
    console.log("   - Microcompact: compresses tool results effectively");
    console.log("   - Autocompact: summarizes long conversations correctly");
    console.log("");
    console.log("Ready for integration!");
    process.exit(0);
  } else {
    console.log("❌ Some tests FAILED");
    process.exit(1);
  }
}

// ============================================================================
// 启动测试
// ============================================================================

runAllTests().catch(error => {
  console.error("💥 Test suite failed with unexpected error:", error);
  process.exit(1);
});
