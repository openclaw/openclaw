import { afterEach, describe, expect, it } from "vitest";
import { convertMessages } from "../../packages/ai/src/openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "../../packages/ai/src/transports/openai-completions-compat.js";
import { buildActiveNodeContextText, setActiveNodeContexts } from "../infra/active-node-context.js";
import type { AgentMessage } from "./runtime/index.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture<"openai-completions">({
  id: "test-model",
  provider: "custom-openai-compatible",
  api: "openai-completions",
  baseUrl: "https://proxy.example/v1",
});

const history = [
  { role: "user", content: [{ type: "text", text: "First request" }], timestamp: 1 },
  makeAssistantMessageFixture({
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "First reply" }],
    stopReason: "stop",
    errorMessage: undefined,
  }),
] as AgentMessage[];

function buildWirePayload() {
  const { runtimeInfo } = buildSystemPromptParams({
    agentId: "main",
    runtime: {
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      host: "host",
      os: "darwin",
      arch: "arm64",
      node: "v24",
      model: "custom-openai-compatible/test-model",
    },
  });
  const systemPrompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", runtimeInfo });
  // The newest message carries the per-turn presence fact, as the prepared runtime context does.
  const currentTurn = {
    role: "user",
    content: [{ type: "text", text: `Next request\n\n${buildActiveNodeContextText()}` }],
    timestamp: 3,
  } as AgentMessage;
  return convertMessages(
    model,
    { systemPrompt, messages: [...history, currentTurn] },
    resolveOpenAICompletionsCompat(model),
  );
}

describe("active-node presence and the openai-completions cached prefix", () => {
  afterEach(() => setActiveNodeContexts([]));

  it("changes only the newest message when the active node changes", () => {
    setActiveNodeContexts([{ nodeId: "mac-123" }]);
    const connected = buildWirePayload();
    setActiveNodeContexts([]);
    const disconnected = buildWirePayload();

    // The relocated Runtime region must reach message 1, or this test proves nothing.
    expect(JSON.stringify(connected[1])).toContain("Runtime: ");
    expect(connected).toHaveLength(disconnected.length);
    for (let index = 0; index < connected.length - 1; index++) {
      expect(JSON.stringify(disconnected[index])).toBe(JSON.stringify(connected[index]));
    }
    expect(JSON.stringify(connected.at(-1))).toContain("active_node=mac-123");
    expect(JSON.stringify(disconnected.at(-1))).toContain("active_node=unknown");
  });
});
