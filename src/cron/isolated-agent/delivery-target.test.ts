import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveAgentMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveStorePath: vi.fn(() => "/tmp/session-store.json"),
}));

import { loadSessionStore } from "../../config/sessions.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

describe("resolveDeliveryTarget", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
  });

  it("keeps telegram topic thread ids for explicit announce targets", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-1001111111111:topic:999",
        lastThreadId: 999,
      },
    });

    const resolved = await resolveDeliveryTarget({} as OpenClawConfig, "main", {
      channel: "telegram",
      to: "-1001234567890:topic:123",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1001234567890:topic:123");
    expect(resolved.threadId).toBe(123);
  });
});
