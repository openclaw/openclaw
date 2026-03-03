import { describe, expect, it } from "vitest";
import { listNativeCommandSpecs } from "../../auto-reply/commands-registry.js";
import type { OpenClawConfig, loadConfig } from "../../config/config.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

function createNativeCommand(name: string): ReturnType<typeof createDiscordNativeCommand> {
  const command = listNativeCommandSpecs({ provider: "discord" }).find(
    (entry) => entry.name === name,
  );
  if (!command) {
    throw new Error(`missing native command: ${name}`);
  }
  const cfg = {} as ReturnType<typeof loadConfig>;
  const discordConfig = {} as NonNullable<OpenClawConfig["channels"]>["discord"];
  return createDiscordNativeCommand({
    command,
    cfg,
    discordConfig,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

describe("createDiscordNativeCommand option wiring", () => {
  it("uses autocomplete for /acp action so inline action values are accepted", () => {
    const command = createNativeCommand("acp");
    const action = command.options?.find((option) => option.name === "action");

    expect(action).toBeDefined();
    expect(typeof action?.autocomplete).toBe("function");
    expect(action?.choices).toBeUndefined();
  });

  it("keeps static choices for non-acp string action arguments", () => {
    const command = createNativeCommand("voice");
    const action = command.options?.find((option) => option.name === "action");

    expect(action).toBeDefined();
    expect(action?.autocomplete).toBeUndefined();
    expect(action?.choices?.length).toBeGreaterThan(0);
  });
});
