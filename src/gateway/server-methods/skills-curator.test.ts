import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { SkillsCuratorLiveStatusResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getSkillCuratorStatus } from "../../skills/workshop/curator.js";
import { skillsCuratorHandlers } from "./skills-curator.js";
import { callGatewayHandler } from "./skills.test-helpers.js";
import type { GatewayClient } from "./types.js";

vi.mock("../../skills/workshop/curator.js", () => ({
  getSkillCuratorStatus: vi.fn(),
}));

const knownSkill: SkillsCuratorLiveStatusResult["skills"][number] = {
  skillFile: "/workspace/skills/known/SKILL.md",
  skillKey: "known",
  skillName: "Known",
  state: "active",
  pinned: false,
  createdAtMs: 100,
  stateChangedAtMs: 200,
  lastUsedAtMs: 300,
  useCount: 4,
  archivedReason: null,
};
const status: SkillsCuratorLiveStatusResult = {
  inventory: "live-workshop",
  lastAttemptAtMs: 400,
  lastSuccessAtMs: 500,
  lastError: null,
  collectionReview: {},
  experienceReview: {},
  counts: { active: 3, stale: 0, archived: 0 },
  skills: [
    knownSkill,
    { ...knownSkill, skillFile: "/workspace/skills/no-created/SKILL.md", createdAtMs: null },
    {
      ...knownSkill,
      skillFile: "/workspace/skills/no-changed/SKILL.md",
      stateChangedAtMs: null,
    },
  ],
  overlaps: [],
};

describe("skills curator async status", () => {
  beforeEach(() => {
    vi.mocked(getSkillCuratorStatus).mockReset();
  });

  it.each([false, true])(
    "awaits status before replying with live inventory capability %s",
    async (live) => {
      const pendingStatus = createDeferred<SkillsCuratorLiveStatusResult>();
      vi.mocked(getSkillCuratorStatus).mockReturnValueOnce(pendingStatus.promise);
      const client: GatewayClient = {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
          role: "operator",
          scopes: ["operator.read"],
          caps: live ? [GATEWAY_CLIENT_CAPS.SKILL_CURATOR_LIVE_INVENTORY] : [],
        },
      };
      const completed = vi.fn();
      const request = callGatewayHandler(
        skillsCuratorHandlers,
        "skills.curator.status",
        {},
        { client },
      ).then(
        (response) => {
          completed();
          return { response };
        },
        (error: unknown) => {
          completed();
          return { error };
        },
      );
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).not.toHaveBeenCalled();
      } finally {
        pendingStatus.resolve(status);
      }
      const { inventory: _inventory, ...legacyStatus } = status;
      expect(await request).toEqual({
        response: {
          ok: true,
          response: live
            ? status
            : {
                ...legacyStatus,
                skills: [knownSkill],
                counts: { active: 1, stale: 0, archived: 0 },
              },
          error: undefined,
        },
      });
    },
  );

  it("propagates an asynchronous status failure", async () => {
    const error = new Error("curator state unavailable");
    vi.mocked(getSkillCuratorStatus).mockRejectedValueOnce(error);

    await expect(
      callGatewayHandler(skillsCuratorHandlers, "skills.curator.status", {}),
    ).rejects.toBe(error);
  });
});
