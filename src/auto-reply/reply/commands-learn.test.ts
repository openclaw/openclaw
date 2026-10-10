// Tests /learn prompt rewriting, defaults, standards, and availability gating.
import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_LEARN_REQUEST } from "../../skills/workshop/learn-prompt.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleLearnCommand } from "./commands-learn.js";
import type { HandleCommandsParams } from "./commands-types.js";

const DEFAULT_TEST_MODELS: NonNullable<OpenClawConfig["models"]> = {
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
          compat: { supportsTools: true },
        },
      ],
    },
  },
};

function buildLearnParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
): HandleCommandsParams {
  const loadedConfig = createCanonicalAgentConfigFixture(cfg).config;
  return {
    cfg: { ...loadedConfig, models: loadedConfig.models ?? DEFAULT_TEST_MODELS },
    ctx: {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      CommandSource: "text",
      Body: commandBodyNormalized,
      RawBody: commandBodyNormalized,
      CommandBody: commandBodyNormalized,
      BodyForCommands: commandBodyNormalized,
      BodyForAgent: commandBodyNormalized,
      BodyStripped: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: INTERNAL_MESSAGE_CHANNEL,
      channelId: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    agentId: "main",
    sessionKey: "agent:main:webchat:test",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

afterEach(() => cliBackendsTesting.resetDepsForTest());

describe("learn command", () => {
  it.each([
    { agentId: "direct", shouldContinue: true },
    { agentId: "isolated", shouldContinue: false },
  ])(
    "uses $agentId workshop availability in a global session",
    async ({ agentId, shouldContinue }) => {
      const params = buildLearnParams("/learn", {
        session: { scope: "global" },
        agents: {
          entries: {
            direct: { sandbox: { mode: "off" } },
            isolated: { sandbox: { mode: "all" } },
          },
        },
      });
      params.agentId = agentId;
      params.sessionKey = "global";

      const result = await handleLearnCommand(params, true);

      expect(result?.shouldContinue).toBe(shouldContinue);
      if (shouldContinue) {
        expect(params.ctx.BodyForAgent).toContain(DEFAULT_LEARN_REQUEST);
        expect(params.command.commandBodyNormalized).toBe(params.ctx.BodyForAgent);
        expect(params.ctx.BodyForCommands).toBe(params.ctx.BodyForAgent);
      } else {
        expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
        expect(params.ctx.BodyForAgent).toBe("/learn");
      }
    },
  );

  it.each([
    { mode: "all", denyWorkshop: false, shouldContinue: false },
    { mode: "off", denyWorkshop: true, shouldContinue: false },
  ] as const)(
    "preserves an independent policy owner with sandbox mode $mode and workshop denied $denyWorkshop",
    async ({ mode, denyWorkshop, shouldContinue }) => {
      const params = buildLearnParams("/learn", {
        agents: {
          entries: {
            main: { sandbox: { mode: "off" } },
            isolated: {
              sandbox: { mode },
              tools: { deny: denyWorkshop ? ["skill_workshop"] : [] },
            },
          },
        },
      });
      params.ctx.RuntimePolicySessionKey = "agent:isolated:webchat:test";

      const result = await handleLearnCommand(params, true);

      expect(result?.shouldContinue).toBe(shouldContinue);
      if (shouldContinue) {
        expect(params.ctx.BodyForAgent).toContain(DEFAULT_LEARN_REQUEST);
      } else {
        expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
      }
    },
  );

  it("keeps the workshop available for owner WebChat under a wildcard sender policy", async () => {
    const params = buildLearnParams("/learn", {
      tools: { toolsBySender: { "*": { deny: ["skill_workshop"] } } },
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
  });

  it("keeps the wildcard sender policy for non-owner WebChat", async () => {
    const params = buildLearnParams("/learn", {
      tools: { toolsBySender: { "*": { deny: ["skill_workshop"] } } },
    });
    params.command.senderIsOwner = false;

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });

  it("replies without continuing when the runtime tool allowlist is empty", async () => {
    const params = buildLearnParams("/learn");
    params.opts = { toolsAllow: [] };

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });

  it("replies without continuing when the selected model disables tools", async () => {
    const params = buildLearnParams("/learn", {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
                compat: { supportsTools: false },
              },
            ],
          },
        },
      },
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });
});
