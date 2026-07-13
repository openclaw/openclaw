import { describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  mintAttachGrant,
  resetAttachGrantsForTest,
  resolveAttachGrant,
} from "../gateway/mcp-grant-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { removeCronRunContinuationSessionIfIdle } from "./cron-run-continuation-cleanup.js";

describe("cron continuation attach-grant lifecycle", () => {
  it("revokes the exact grant after persisted continuation deletion", async () => {
    await withOpenClawTestState({ label: "cron-continuation-grant-revocation" }, async () => {
      resetAttachGrantsForTest();
      const sessionKey = "agent:main:cron:one-shot:run:run-123";
      const unrelatedKey = "agent:main:unrelated";
      const storePath = resolveStorePath(getRuntimeConfig().session?.store, { agentId: "main" });
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "run-123",
          updatedAt: 123,
          lifecycleRevision: "revision-1",
          cronRunContinuation: {
            basePersisted: true,
            lifecycleRevision: "revision-1",
            phase: "ready",
          },
        },
      );
      const target = mintAttachGrant({ sessionKey });
      const unrelated = mintAttachGrant({ sessionKey: unrelatedKey });

      await removeCronRunContinuationSessionIfIdle(sessionKey);

      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
      expect(resolveAttachGrant(target.token)).toBeUndefined();
      expect(resolveAttachGrant(unrelated.token)).toBeDefined();
    });
  });
});
