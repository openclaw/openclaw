import { describe, expect, it } from "vitest";
import { isFreshChannelCronAuthorityTurn } from "../../agents/cron-creator-authority-context.js";

const BASE = {
  messageProvider: "telegram",
  senderId: "owner-1",
  isRoomEvent: false,
};

describe("fresh channel cron authority turn", () => {
  it("recognizes a fresh authenticated turn without channel-specific policy", () => {
    expect(isFreshChannelCronAuthorityTurn({ ...BASE, messageProvider: "custom-channel" })).toBe(
      true,
    );
  });

  it.each([
    { name: "missing provider", overrides: { messageProvider: undefined } },
    { name: "missing sender", overrides: { senderId: undefined } },
    { name: "session event", overrides: { inputProvenance: { kind: "internal_system" } } },
    { name: "room event", overrides: { isRoomEvent: true } },
    { name: "continuation provenance", overrides: { inputProvenance: { kind: "continuation" } } },
    { name: "spawned session", overrides: { spawnedBy: "agent:parent" } },
    { name: "replayed turn", overrides: { suppressNextUserMessagePersistence: true } },
  ])("rejects $name", ({ overrides }) => {
    expect(isFreshChannelCronAuthorityTurn({ ...BASE, ...overrides })).toBe(false);
  });
});
