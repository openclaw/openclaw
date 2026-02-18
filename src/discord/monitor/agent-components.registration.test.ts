import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomIdForCarbon,
} from "../components.js";
import type { AgentComponentContext } from "./agent-components.js";
import {
  createDiscordComponentButton,
  createDiscordComponentChannelSelect,
  createDiscordComponentMentionableSelect,
  createDiscordComponentModal,
  createDiscordComponentRoleSelect,
  createDiscordComponentStringSelect,
  createDiscordComponentUserSelect,
} from "./agent-components.js";

describe("discord agent-components registration", () => {
  it("uses unique customId values for each Discord component handler (avoid Carbon de-dupe)", () => {
    const ctx = {
      cfg: {} as unknown as OpenClawConfig,
      accountId: "test",
    } satisfies AgentComponentContext;

    const componentHandlers = [
      createDiscordComponentButton(ctx),
      createDiscordComponentStringSelect(ctx),
      createDiscordComponentUserSelect(ctx),
      createDiscordComponentRoleSelect(ctx),
      createDiscordComponentMentionableSelect(ctx),
      createDiscordComponentChannelSelect(ctx),
    ];

    const customIds = componentHandlers.map((c) => c.customId);
    expect(customIds).not.toContain("*");
    expect(new Set(customIds).size).toBe(customIds.length);

    for (const customId of customIds) {
      expect(parseDiscordComponentCustomIdForCarbon(customId).key).toBe("*");
    }

    const modal = createDiscordComponentModal(ctx);
    expect(modal.customId).not.toBe("*");
    expect(parseDiscordModalCustomIdForCarbon(modal.customId).key).toBe("*");
  });
});
