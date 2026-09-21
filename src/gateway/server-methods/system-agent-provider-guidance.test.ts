import "./system-agent.mocks.test-support.js";
import { describe, expect, it } from "vitest";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  makeContext,
  useSystemAgentGatewayTestFixture,
} from "./system-agent.test-support.js";

const { requireVerifiedInferenceFixture, requireVerifiedInferenceDeps, seededSession } =
  useSystemAgentGatewayTestFixture();

describe("openclaw.chat provider setup guidance", () => {
  it("returns protected Models guidance without applying a pending change or a handoff", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
    });
    engine.propose({ kind: "gateway-stop" });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["provider-guidance", seededSession({ engine })],
    ]);

    const response = await callChat(makeContext(sessions), {
      sessionId: "provider-guidance",
      message: "configure a model provider",
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      action: "none",
      reply: expect.stringContaining("Settings → Models → Connect provider"),
    });
    expect(response.payload).not.toHaveProperty("handoff");
    expect(response.payload).not.toHaveProperty("approval");
    expect(engine.getPendingOperatorProposal()).toBeNull();
    expect(sessions.get("provider-guidance")?.engine).toBe(engine);
  });
});
