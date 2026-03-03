import { describe, expect, it } from "vitest";
import { listChatCommands } from "../../auto-reply/commands-registry.js";
import type { loadConfig } from "../../config/config.js";
import { __testing } from "./native-command.js";

describe("buildDiscordCommandOptions", () => {
  it("forces autocomplete for /acp action", () => {
    const acpCommand = listChatCommands().find((command) => command.key === "acp");
    if (!acpCommand) {
      throw new Error("acp command missing from registry");
    }
    const options = __testing.buildDiscordCommandOptions({
      command: acpCommand,
      cfg: {} as ReturnType<typeof loadConfig>,
    });
    const actionOption = options?.find((option) => option.name === "action");
    expect(actionOption?.autocomplete).toBeTypeOf("function");
    expect(actionOption?.choices).toBeUndefined();
  });
});
