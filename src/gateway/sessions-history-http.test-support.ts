import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { createGatewaySuiteHarness } from "./test-helpers.server.js";

let historyHarness: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;

export function makeTranscriptAssistantMessage(params: {
  text: string;
  provider?: string;
  model?: string;
}): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text: params.text }],
    provider: params.provider ?? "openai",
    model: params.model ?? "gpt-5.5",
    usage: createZeroUsageFixture(),
    timestamp: Date.now(),
  });
}

export async function closeHistoryHarness() {
  await historyHarness?.close();
  historyHarness = undefined;
}

export async function withGatewayHarness<T>(
  run: (harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>) => Promise<T>,
  options: { fresh?: boolean } = {},
) {
  if (options.fresh) {
    await closeHistoryHarness();
  }
  historyHarness ??= await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "none" } },
  });
  let completed = false;
  try {
    const result = await run(historyHarness);
    completed = true;
    return result;
  } finally {
    if (!completed || options.fresh) {
      await closeHistoryHarness();
    }
  }
}
