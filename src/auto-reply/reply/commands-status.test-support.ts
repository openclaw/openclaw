import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildStatusReply } from "./commands-status.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

export async function buildStatusReplyForTest(params: {
  sessionKey?: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  verbose?: boolean;
}) {
  const cfg = params.cfg ?? baseCommandTestConfig;
  const commandParams = buildCommandTestParams("/status", cfg);
  const sessionKey = params.sessionKey ?? commandParams.sessionKey;
  return await buildStatusReply({
    cfg,
    agentId: params.agentId,
    command: commandParams.command,
    sessionEntry: commandParams.sessionEntry,
    sessionKey,
    parentSessionKey: sessionKey,
    sessionScope: commandParams.sessionScope,
    storePath: commandParams.storePath,
    provider: "anthropic",
    model: "claude-opus-4-6",
    contextTokens: 0,
    resolvedThinkLevel: commandParams.resolvedThinkLevel,
    resolvedFastMode: false,
    resolvedVerboseLevel: params.verbose ? "on" : commandParams.resolvedVerboseLevel,
    resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
    resolvedElevatedLevel: commandParams.resolvedElevatedLevel,
    resolveDefaultThinkingLevel: commandParams.resolveDefaultThinkingLevel,
    isGroup: commandParams.isGroup,
    defaultGroupActivation: commandParams.defaultGroupActivation,
    modelAuthOverride: "api-key",
    activeModelAuthOverride: "api-key",
  });
}

export async function buildKiraStatusReply(cfg: OpenClawConfig) {
  {
    const reply = await buildStatusReply({
      cfg,
      command: buildCommandTestParams("/status", cfg).command,
      sessionKey: "agent:kira:main",
      provider: "openai",
      model: "gpt-5.4",
      contextTokens: 0,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
    });
    expect(reply).toMatchObject({ presentationTextMode: "fallback" });
    return reply;
  }
}
