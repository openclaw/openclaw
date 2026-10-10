import { describe, expect, it } from "vitest";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
} from "./command-status.js";
import type { OpenClawConfig } from "./config-contracts.js";

describe("plugin-sdk/command-status", () => {
  it("keeps command status builders on their focused subpath", () => {
    const cfg: OpenClawConfig = { commands: { config: false, debug: false } };

    expect(buildHelpMessage(cfg)).toContain("/commands for full list");
    expect(buildCommandsMessage(cfg)).toContain("More: /tools for available capabilities");
    expect(buildCommandsMessage(cfg)).toContain("/models - List model providers/models.");
    const commandsPage = buildCommandsMessagePaginated(cfg);
    expect(commandsPage.currentPage).toBe(1);
    expect(typeof commandsPage.totalPages).toBe("number");
  });
});
