import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => "api-key",
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: () => [],
}));

vi.mock("../../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({
    updatedAt: Date.now(),
    providers: [],
  }),
  formatUsageWindowSummary: () => undefined,
}));

vi.mock("../group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value,
}));

vi.mock("./queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: () => ({ mode: "interrupt" }),
}));

const { buildStatusReply } = await import("./commands-status.js");

describe("buildStatusReply", () => {
  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "kira",
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

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

    expect(reply?.text).toContain("Think: xhigh");
  });
});
