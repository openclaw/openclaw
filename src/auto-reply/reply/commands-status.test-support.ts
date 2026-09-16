import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { buildStatusReply } from "./commands-status.js";
import { configureInMemoryTaskRegistryStoreForTests } from "./commands.test-harness.js";

export async function buildKiraStatusReply(cfg: OpenClawConfig) {
  resetTaskRegistryForTests({ persist: false });
  configureInMemoryTaskRegistryStoreForTests();
  try {
    const reply = await buildStatusReply({
      cfg,
      command: {
        isAuthorizedSender: true,
        channel: "whatsapp",
      } as never,
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
  } finally {
    resetTaskRegistryForTests({ persist: false });
  }
}
