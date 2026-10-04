import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";

export function registerSessionSystemEventTests(
  buildChannelSummary: Mock<() => Promise<string[]>>,
): void {
  describe("drainFormattedSystemEvents", () => {
    it("keeps channel summary lines prefixed as trusted system output on new main sessions", async () => {
      buildChannelSummary.mockResolvedValue(["WhatsApp: linked\n  - default (line one\nline two)"]);

      const result = await drainFormattedSystemEvents({
        cfg: { channels: {} } as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: true,
      });

      expect(result).toContain("System: WhatsApp: linked");
      for (const line of result!.split("\n")) {
        expect(line).toMatch(/^System:/);
      }
    });

    it("drains only the selected occurrence while preserving other queued events", async () => {
      try {
        enqueueSystemEvent("Reminder: rotate API keys", {
          sessionKey: "agent:main:main",
          contextKey: "cron:rotate-keys",
        });
        const generic = expectDefined(
          enqueueSystemEventEntry("Model switched.", { sessionKey: "agent:main:main" }),
          "queued generic event",
        );

        const result = await drainFormattedSystemEvents({
          cfg: {} as OpenClawConfig,
          agentId: "main",
          sessionKey: "agent:main:main",
          isMainSession: true,
          isNewSession: false,
          events: [generic],
        });

        expect(result).toContain("Model switched.");
        expect(result).not.toContain("rotate API keys");
        expect(peekSystemEvents("agent:main:main")).toEqual(["Reminder: rotate API keys"]);
      } finally {
        resetSystemEventsForTest();
      }
    });

    it("renders passive cron notices on the next normal turn", async () => {
      try {
        enqueueSystemEvent("Reminder: rotate API keys", {
          sessionKey: "agent:main:main",
          contextKey: "cron:rotate-keys",
        });

        const result = await drainFormattedSystemEvents({
          cfg: {} as OpenClawConfig,
          agentId: "main",
          sessionKey: "agent:main:main",
          isMainSession: true,
          isNewSession: false,
        });

        expect(result).toContain("Reminder: rotate API keys");
        expect(peekSystemEvents("agent:main:main")).toEqual([]);
      } finally {
        resetSystemEventsForTest();
      }
    });
  });
}
