import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";
import { writeSessionStore } from "./test/session.test-support.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-automation-activity-");

it.each([true, false])(
  "preserves recency only for a scheduled check (automation=%s)",
  async (automation) => {
    const storePath = path.join(tempDirs.make(), "sessions.json");
    const sessionKey = "agent:main:dashboard:automation-activity";
    const at = Date.now() - 1_000;
    const previous = {
      sessionId: "automation-activity",
      updatedAt: at,
      lastInteractionAt: at,
      status: "done" as const,
      systemSent: true,
      agentStatus: "Waiting for review",
      snoozedUntil: at + 60_000,
      snoozedAt: at,
    };
    await writeSessionStore(storePath, { [sessionKey]: previous });
    const result = await initSessionState({
      cfg: { session: { store: storePath } },
      commandAuthorized: false,
      ctx: finalizeInboundContext({
        Body: "Check whether the review has changed.",
        SessionKey: sessionKey,
        Provider: "webchat",
        Surface: "webchat",
        ...(automation
          ? {
              InternalTurnSource: "event",
              InputProvenance: { kind: "internal_system", sourceTool: "cron_execution" },
            }
          : { InputProvenance: { kind: "external_user" } }),
      }),
    });
    const stored = loadSessionEntry({ storePath, sessionKey });
    if (automation) {
      expect(result.sessionEntry).toMatchObject(previous);
      expect(stored).toMatchObject(previous);
    } else {
      expect(stored?.updatedAt).toBeGreaterThan(at);
      expect(stored?.lastInteractionAt).toBeGreaterThan(at);
    }
  },
);
