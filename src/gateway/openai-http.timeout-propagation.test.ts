import { describe, expect, it } from "vitest";
import { __testOnlyOpenAiHttp } from "./openai-http.js";

describe("openai compat timeout propagation", () => {
  it("serializes timeout from gateway runtime config into ingress command input", () => {
    const input = __testOnlyOpenAiHttp.buildAgentCommandInput({
      prompt: { message: "hello" },
      modelOverride: "ollama/qwen3.6:latest",
      sessionKey: "agent:main:openai:test",
      runId: "run-1",
      messageChannel: "webchat",
      senderIsOwner: false,
      timeoutSeconds: 300,
    });

    expect(input.timeout).toBe("300");
  });

  it("clamps negative timeout to zero-style no-timeout semantics", () => {
    const input = __testOnlyOpenAiHttp.buildAgentCommandInput({
      prompt: { message: "hello" },
      sessionKey: "agent:main:openai:test",
      runId: "run-2",
      messageChannel: "webchat",
      senderIsOwner: false,
      timeoutSeconds: -25,
    });

    expect(input.timeout).toBe("0");
  });

  it("omits timeout override when gateway runtime did not provide one", () => {
    const input = __testOnlyOpenAiHttp.buildAgentCommandInput({
      prompt: { message: "hello" },
      sessionKey: "agent:main:openai:test",
      runId: "run-3",
      messageChannel: "webchat",
      senderIsOwner: false,
    });

    expect(input).not.toHaveProperty("timeout");
  });
});
