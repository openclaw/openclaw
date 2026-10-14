// Tests /learn prompt rewriting, defaults, standards, and availability gating.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_LEARN_REQUEST } from "../../skills/workshop/learn-prompt.js";
import { WorkshopReviewNotFoundError } from "../../skills/workshop/review-undo.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleLearnCommand } from "./commands-learn.js";
import type { HandleCommandsParams } from "./commands-types.js";

const undoWorkshopReview = vi.hoisted(() => vi.fn());
vi.mock("../../skills/workshop/review-undo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/review-undo.js")>()),
  undoWorkshopReview,
}));

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

  describe("undo", () => {
    const reviewId = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
    const undo = (configure?: (params: HandleCommandsParams) => void) => {
      const params = buildLearnParams(`/learn undo ${reviewId.toUpperCase()}`);
      configure?.(params);
      return handleLearnCommand(params, true);
    };

    beforeEach(() => {
      undoWorkshopReview.mockReset();
    });

    it("reverts the review as the user and lists what it restored and archived", async () => {
      undoWorkshopReview.mockResolvedValue({
        status: "undone",
        changes: [
          { skillName: "deploy", action: "restore" },
          { skillName: "release", action: "archive" },
        ],
      });

      const result = await undo();

      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: "↩️ Undid the skill change: restored `deploy`; archived `release`." },
      });
      expect(undoWorkshopReview).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          actor: "user",
          sessionKey: "agent:main:webchat:test",
        }),
        { runId: `skill-workshop-review:${reviewId}` },
      );
    });

    it("answers a repeated undo and an unknown id without a model turn", async () => {
      undoWorkshopReview.mockResolvedValueOnce({ status: "already-undone", changes: [] });
      undoWorkshopReview.mockRejectedValueOnce(new WorkshopReviewNotFoundError("none"));

      expect((await undo())?.reply?.text).toBe("That skill change was already undone.");
      expect((await undo())?.reply?.text).toBe("No skill change found for that id.");
    });

    it("keeps any other undo text a learn request", async () => {
      const params = buildLearnParams("/learn undo the deploy notes");

      const result = await handleLearnCommand(params, true);

      expect(result).toEqual({ shouldContinue: true });
      expect(params.ctx.BodyForAgent).toContain("undo the deploy notes");
      expect(undoWorkshopReview).not.toHaveBeenCalled();
    });

    it("refuses senders without owner or admin authority", async () => {
      const nonOwner = await undo((params) => {
        params.command.senderIsOwner = false;
      });
      const unauthorized = await undo((params) => {
        params.command.senderIsOwner = false;
        params.command.isAuthorizedSender = false;
      });
      const missingAdmin = await undo((params) => {
        params.ctx.GatewayClientScopes = ["operator.write"];
      });

      expect(nonOwner?.reply?.text).toContain("not authorized to use this owner-only command");
      expect(unauthorized).toEqual({ shouldContinue: false });
      expect(missingAdmin?.reply?.text).toBe(
        "❌ /learn undo requires operator.admin for gateway clients.",
      );
      expect(undoWorkshopReview).not.toHaveBeenCalled();
    });
  });
});
