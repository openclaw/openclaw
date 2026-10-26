// Tests /learn prompt rewriting, defaults, standards, and availability gating.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkshopReviewNotFoundError } from "../../skills/workshop/review-undo.js";
import { SKILL_LEARNING_METHOD_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleLearnCommand } from "./commands-learn.js";
import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const undoWorkshopReview = vi.hoisted(() => vi.fn());
vi.mock("../../skills/workshop/review-undo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/review-undo.js")>()),
  undoWorkshopReview,
}));

const getMemoryLearnContribution = vi.hoisted(() => vi.fn());
vi.mock("../../plugins/memory-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/memory-state.js")>()),
  getMemoryLearnContribution,
}));

function createLearnModels(supportsTools: boolean): NonNullable<OpenClawConfig["models"]> {
  return {
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
            compat: { supportsTools },
          },
        ],
      },
    },
  };
}

const DEFAULT_TEST_MODELS = createLearnModels(true);

function buildLearnParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
): HandleCommandsParams {
  const loadedConfig = createCanonicalAgentConfigFixture(cfg).config;
  return {
    ...buildSessionCommandTestParams({
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: INTERNAL_MESSAGE_CHANNEL,
      channelId: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    }),
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
    directives: {},
    sessionKey: "agent:main:webchat:test",
    model: "gpt-5.5",
  } as unknown as HandleCommandsParams;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  getMemoryLearnContribution.mockReset();
});

describe("learn command", () => {
  it("uses isolated workshop availability in a global session", async () => {
    const params = buildLearnParams("/learn", {
      session: { scope: "global" },
      agents: {
        entries: {
          direct: { sandbox: { mode: "off" } },
          isolated: { sandbox: { mode: "all" } },
        },
      },
    });
    params.agentId = "isolated";
    params.sessionKey = "global";

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
    expect(params.ctx.BodyForAgent).toBe("/learn");
  });

  it.each([
    { mode: "all", denyWorkshop: false },
    { mode: "off", denyWorkshop: true },
  ] as const)(
    "preserves an independent policy owner with sandbox mode $mode and workshop denied $denyWorkshop",
    async ({ mode, denyWorkshop }) => {
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

      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
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
      models: createLearnModels(false),
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });

  describe("memory provider learning", () => {
    const memoryLearn = () => {
      const buildGuidance = vi.fn(({ availableTools }: { availableTools: Set<string> }) =>
        availableTools.has("memory_save") ? ["Memory: follow the provider learning skill."] : [],
      );
      getMemoryLearnContribution.mockReturnValue({
        pluginId: "acme-memory",
        toolNames: ["memory_save", "memory_search"],
        buildGuidance,
      });
      return buildGuidance;
    };

    it("routes lessons between skills and memory when both are available", async () => {
      memoryLearn();
      const params = buildLearnParams("/learn trajectories/");

      const result = await handleLearnCommand(params, true);

      expect(result?.shouldContinue).toBe(true);
      expect(params.ctx.BodyForAgent).toContain("Route each lesson to one medium.");
      expect(params.ctx.BodyForAgent).toContain("Memory: follow the provider learning skill.");
      expect(params.ctx.BodyForAgent).toContain("Write skills with skill_workshop");
      expect(params.ctx.BodyForAgent).toContain(SKILL_LEARNING_METHOD_PROMPT);
      expect(params.ctx.BodyForAgent).not.toContain("Make at most one change.");
    });

    it("learns into memory alone when policy hides skill_workshop", async () => {
      const buildGuidance = memoryLearn();
      const params = buildLearnParams("/learn", {
        tools: { deny: ["skill_workshop", "memory_search"] },
      });

      const result = await handleLearnCommand(params, true);

      expect(result?.shouldContinue).toBe(true);
      expect(buildGuidance).toHaveBeenCalledWith({ availableTools: new Set(["memory_save"]) });
      expect(params.ctx.BodyForAgent).toContain("The user asked you to learn.");
      expect(params.ctx.BodyForAgent).toContain("Learn what is worth keeping");
      expect(params.ctx.BodyForAgent).not.toContain("skill_workshop");
    });

    it("honors plugin-ID and group:plugins policy entries for memory learning tools", async () => {
      const buildGuidance = memoryLearn();
      const allowed = buildLearnParams("/learn", { tools: { allow: ["acme-memory"] } });

      expect((await handleLearnCommand(allowed, true))?.shouldContinue).toBe(true);
      expect(buildGuidance).toHaveBeenCalledWith({
        availableTools: new Set(["memory_save", "memory_search"]),
      });

      buildGuidance.mockClear();
      for (const deny of [["acme-memory"], ["group:plugins"]]) {
        const denied = buildLearnParams("/learn", { tools: { deny } });
        const result = await handleLearnCommand(denied, true);
        expect(denied.ctx.BodyForAgent).not.toContain(
          "Memory: follow the provider learning skill.",
        );
        expect(result?.shouldContinue).toBe(true);
      }
      expect(buildGuidance).not.toHaveBeenCalled();
    });

    it("names both media when policy hides both", async () => {
      memoryLearn();
      const params = buildLearnParams("/learn", {
        tools: { deny: ["skill_workshop", "memory_save"] },
      });

      const result = await handleLearnCommand(params, true);

      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain(
        "neither the skill_workshop tool nor the memory plugin's learning tools",
      );
    });
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
