import { expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareHumanMentionTargets } from "./human-mention-policy-targets.js";
import { createHumanMentionPolicy } from "./human-mention-policy.js";
import { resolveSessionSharingTargets } from "./session-sharing-policy.js";

it("keeps canonical sharing target parity, including the removed main agent's physical store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = "agent:main:dashboard:mention-policy";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    await replaceSessionEntry(
      { agentId: "main", sessionKey: key, storePath },
      {
        sessionId: "mention-policy-session",
        updatedAt: 1,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
    );
    const cfg = { agents: { list: [{ id: "main" }] } };
    const retired = { agents: { list: [{ id: "replacement" }] } };
    for (const config of [cfg, retired]) {
      const targets = [{ sessionKey: key }, { sessionKey: "agent:main:dashboard:absent" }];
      const expected = resolveSessionSharingTargets({ cfg: config, targets });
      const prepared = await prepareHumanMentionTargets(config, targets);
      expect(
        prepared.map((target) => {
          if (!target) {
            return target;
          }
          const { database: _database, ...sharing } = target;
          return sharing;
        }),
      ).toEqual(expected);
      expect(prepared[0]?.database).toEqual({ agentId: "main", path: storePath });
    }
    const mainKey = "agent:main:main";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: mainKey, storePath },
      { sessionId: "unrelated-main-session", updatedAt: 2 },
    );
    const absent = [{ sessionKey: "agent:main:dashboard:absent" }];
    expect(() => resolveSessionSharingTargets({ cfg: retired, targets: absent })).toThrow(
      "non-canonical persisted row",
    );
    await expect(prepareHumanMentionTargets(retired, absent)).rejects.toThrow(
      "non-canonical persisted row",
    );
    expect(
      (await prepareHumanMentionTargets(retired, [{ sessionKey: mainKey }]))[0]?.entry.sessionId,
    ).toBe("unrelated-main-session");
  });
});

it("revokes cached target authority when its physical store closes after reader settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const input = { agentId: "main", sessionKey: "agent:main:dashboard:target-close" };
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    await replaceSessionEntry({ ...input, storePath }, { sessionId: "original", updatedAt: 1 });
    const cfg = { agents: { list: [{ id: "main" }] } };
    const policy = createHumanMentionPolicy({ getRuntimeConfig: () => cfg, getClients: () => [] });
    try {
      const preparation = { targets: [input] };
      await policy.prepare(preparation);
      expect(policy.resolveTarget(input)?.entry.sessionId).toBe("original");
      await closeOpenClawAgentDatabaseByPathAsync(storePath);
      expect(() => policy.resolveTarget(input)).toThrow("has not been prepared");
      expect(policy.needsPreparation(preparation)).toBe(true);
      await policy.prepare(preparation);
      expect(policy.resolveTarget(input)?.entry.sessionId).toBe("original");
    } finally {
      policy.dispose();
    }
  });
});
