import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { loadSessionEntry, upsertSessionEntry } from "./session-accessor.js";
import {
  addSessionMember,
  isSessionMember,
  listSessionMembershipKeys,
  listSessionMembers,
  removeSessionMember,
} from "./session-sharing-store.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("session sharing store", () => {
  it("lazily ensures the additive membership table and keeps deterministic rows", async () => {
    await withTempDir({ prefix: "openclaw-session-sharing-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, {
        sessionId: "session-main",
        updatedAt: 1,
      });
      expect(loadSessionEntry(scope)?.visibility).toBe("shared");
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      database.db.exec("DROP TABLE session_members;");
      expect(
        database.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_members'")
          .get(),
      ).toBeUndefined();

      expect(listSessionMembers(scope)).toEqual([]);
      expect(
        addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 }).inserted,
      ).toBe(true);
      expect(
        addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 }).inserted,
      ).toBe(true);

      expect(listSessionMembers(scope)).toEqual([
        { identityId: "alice", addedBy: "owner", addedAt: 3 },
        { identityId: "zoe", addedBy: "owner", addedAt: 2 },
      ]);
      expect(isSessionMember(scope, "alice")).toBe(true);
      expect(
        listSessionMembershipKeys(
          scope,
          [scope.sessionKey, ...Array.from({ length: 450 }, (_, index) => `session-${index}`)],
          "zoe",
        ),
      ).toEqual(new Set([scope.sessionKey]));
      expect(removeSessionMember(scope, "alice")).toEqual({
        identityId: "alice",
        addedBy: "owner",
        addedAt: 3,
      });
      expect(removeSessionMember(scope, "alice")).toBeNull();
    });
  });
});
