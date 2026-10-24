import { describe, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader, type OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

// Saved session settings that the Gateway reset (`sessions.reset`) also keeps.
const preferences = {
  fastMode: true,
  contextWindow: "200k",
  toolOverrides: { webSearch: false },
  sendPolicy: "deny",
  queueMode: "collect",
  queueDebounceMs: 2500,
  queueCap: 7,
  queueDrop: "summarize",
  elevatedLevel: "off",
} as const;

describe("reply session rollover", () => {
  it.each([
    { body: "/new", resetTriggered: true },
    { body: "/reset", resetTriggered: true },
    { body: "continue after idle", resetTriggered: false },
  ])("keeps saved session preferences through $body", async ({ body, resetTriggered }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:dashboard:rollover-preferences";
      const cfg: OpenClawConfig = { session: { reset: { mode: "idle", idleMinutes: 1 } } };
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
      // Explicit commands reset a fresh session; the ordinary turn crosses the idle boundary.
      const lastActivity = resetTriggered ? Date.now() : Date.now() - 120_000;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "rollover-preferences",
          updatedAt: lastActivity,
          sessionStartedAt: lastActivity,
          lastInteractionAt: lastActivity,
          ...preferences,
        },
      );

      const initialized = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: finalizeInboundContext({
          Body: body,
          RawBody: body,
          CommandBody: body,
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "webchat",
          Surface: "webchat",
        }),
      });

      expect(initialized.isNewSession).toBe(true);
      expect(initialized.resetTriggered).toBe(resetTriggered);
      expect(initialized.sessionEntry).toMatchObject(preferences);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" }),
      ).toMatchObject(preferences);
    });
  });
});
