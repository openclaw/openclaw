import { beforeEach, describe, expect, it } from "vitest";
import { buildQueuedSystemPrompt } from "../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { isCronSystemEvent } from "./heartbeat-runner.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const main = await buildQueuedSystemPrompt({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
    });
    expect(main).toBeUndefined();
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const discord = await buildQueuedSystemPrompt({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
    });
    expect(discord).toContain("Runtime System Events (gateway-generated)");
    expect(discord).toMatch(/-\s\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });

  it("returns false for consecutive duplicate events", () => {
    const first = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });
    const second = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("filters heartbeat/noise lines from queued system prompt", async () => {
    const key = "agent:main:test-heartbeat-filter";
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const prompt = await buildQueuedSystemPrompt({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(prompt).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("scrubs node last-input suffix in queued system prompt", async () => {
    const key = "agent:main:test-node-scrub";
    enqueueSystemEvent("Node: Mac Studio · last input /tmp/secret.txt", { sessionKey: key });

    const prompt = await buildQueuedSystemPrompt({
      cfg,
      sessionKey: key,
      isMainSession: false,
      isNewSession: false,
    });
    expect(prompt).toContain("Node: Mac Studio");
    expect(prompt).not.toContain("last input");
  });
});

describe("isCronSystemEvent", () => {
  it("returns false for empty entries", () => {
    expect(isCronSystemEvent("")).toBe(false);
    expect(isCronSystemEvent("   ")).toBe(false);
  });

  it("returns false for heartbeat ack markers", () => {
    expect(isCronSystemEvent("HEARTBEAT_OK")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK 🦞")).toBe(false);
    expect(isCronSystemEvent("heartbeat_ok")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK:")).toBe(false);
    expect(isCronSystemEvent("HEARTBEAT_OK, continue")).toBe(false);
  });

  it("returns false for heartbeat poll and wake noise", () => {
    expect(isCronSystemEvent("heartbeat poll: pending")).toBe(false);
    expect(isCronSystemEvent("heartbeat wake complete")).toBe(false);
  });

  it("returns false for exec completion events", () => {
    expect(isCronSystemEvent("Exec finished (gateway id=abc, code 0)")).toBe(false);
  });

  it("returns true for real cron reminder content", () => {
    expect(isCronSystemEvent("Reminder: Check Base Scout results")).toBe(true);
    expect(isCronSystemEvent("Send weekly status update to the team")).toBe(true);
  });
});
