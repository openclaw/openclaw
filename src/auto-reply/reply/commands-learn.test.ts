import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkshopReviewNotFoundError } from "../../skills/workshop/review-undo.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleLearnCommand } from "./commands-learn.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const undoWorkshopReview = vi.hoisted(() => vi.fn());
vi.mock("../../skills/workshop/review-undo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/review-undo.js")>()),
  undoWorkshopReview,
}));

const testModels = (supportsTools = true): NonNullable<OpenClawConfig["models"]> => ({
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
});
const wildcardPolicy: OpenClawConfig = {
  tools: { toolsBySender: { "*": { deny: ["skill_workshop"] } } },
};

function buildLearnParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
): HandleCommandsParams {
  const loadedConfig = createCanonicalAgentConfigFixture(cfg).config;
  const params = buildCommandTestParams(
    commandBodyNormalized,
    { ...loadedConfig, models: loadedConfig.models ?? testModels() },
    {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      BodyForAgent: commandBodyNormalized,
    },
  );
  Object.assign(params.command, {
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "tester",
  });
  return {
    ...params,
    directives: {},
    sessionKey: "agent:main:webchat:test",
    provider: "openai",
    model: "gpt-5.5",
  };
}

async function expectUnavailable(params: HandleCommandsParams) {
  const result = await handleLearnCommand(params, true);
  expect(result?.shouldContinue).toBe(false);
  expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
}

afterEach(() => cliBackendsTesting.resetDepsForTest());

describe("learn command", () => {
  it.each([
    { scope: "global", mode: "all", denyWorkshop: false },
    { scope: "per-sender", mode: "all", denyWorkshop: false },
    { scope: "per-sender", mode: "off", denyWorkshop: true },
  ] as const)(
    "preserves the $scope policy owner with sandbox=$mode and workshop denied=$denyWorkshop",
    async ({ scope, mode, denyWorkshop }) => {
      const params = buildLearnParams("/learn", {
        ...(scope === "global" ? { session: { scope } } : {}),
        agents: {
          entries: {
            [scope === "global" ? "direct" : "main"]: { sandbox: { mode: "off" } },
            isolated: {
              sandbox: { mode },
              tools: { deny: denyWorkshop ? ["skill_workshop"] : [] },
            },
          },
        },
      });
      if (scope === "global") {
        params.agentId = "isolated";
        params.sessionKey = "global";
      } else {
        params.ctx.RuntimePolicySessionKey = "agent:isolated:webchat:test";
      }
      await expectUnavailable(params);
      expect(params.ctx.BodyForAgent).toBe("/learn");
    },
  );

  it.each([true, false])("applies wildcard sender policy for WebChat owner=%s", async (owner) => {
    const params = buildLearnParams("/learn", wildcardPolicy);
    params.command.senderIsOwner = owner;
    if (owner) {
      expect((await handleLearnCommand(params, true))?.shouldContinue).toBe(true);
    } else {
      await expectUnavailable(params);
    }
  });

  it("replies without continuing when the runtime tool allowlist is empty", async () => {
    const params = buildLearnParams("/learn");
    params.opts = { toolsAllow: [] };

    await expectUnavailable(params);
  });

  it("replies without continuing when the selected model disables tools", async () => {
    await expectUnavailable(buildLearnParams("/learn", { models: testModels(false) }));
  });

  describe("undo", () => {
    const reviewId = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
    const undo = (configure?: (params: HandleCommandsParams) => void) => {
      const params = buildLearnParams(`/learn undo ${reviewId.toUpperCase()}`);
      configure?.(params);
      return handleLearnCommand(params, true);
    };

    beforeEach(() => undoWorkshopReview.mockReset());

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
